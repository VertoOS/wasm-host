import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const E2E_PAGE_PATH = "/e2e/codex-version-smoke.html";
const TERMINAL_SHELL_PAGE_PATH = "/e2e/terminal-shell.html";
const BROWSER_REQUIRED = process.env.WASM_HOST_BROWSER_E2E_REQUIRED === "1";
const BROWSER_EXECUTABLE = resolveBrowserExecutable();
const CDP_AVAILABLE = typeof globalThis.WebSocket === "function";
const DEVTOOLS_STARTUP_TIMEOUT_MS = 60000;
const DEVTOOLS_POLL_INTERVAL_MS = 100;
const BROWSER_STATUS_TIMEOUT_MS = 30000;
const DEVTOOLS_COMMAND_TIMEOUT_MS = BROWSER_STATUS_TIMEOUT_MS;
const BROWSER_E2E_TIMEOUT_MS =
  DEVTOOLS_STARTUP_TIMEOUT_MS + BROWSER_STATUS_TIMEOUT_MS * 5 + 30000;

async function runBrowserE2e() {
  const skip = skipReason();
  if (skip) {
    return `SKIP browser e2e: ${skip}`;
  }
  assert.ok(
    BROWSER_EXECUTABLE,
    "set WASM_HOST_BROWSER to a Chromium or Chrome executable",
  );
  assert.ok(CDP_AVAILABLE, "Node WebSocket support is required for CDP");

  let browser = null;
  let page = null;
  let server = null;
  try {
    server = await startStaticServer(APP_ROOT);
    browser = await launchBrowser(BROWSER_EXECUTABLE);

    page = await DevToolsPage.open(
      browser.debugPort,
      `${server.origin}${E2E_PAGE_PATH}`,
    );
    const smoke = await runCodexVersionSmokePage(page);
    page.close();

    page = await DevToolsPage.open(
      browser.debugPort,
      `${server.origin}${TERMINAL_SHELL_PAGE_PATH}`,
    );
    const terminal = await runTerminalShellPage(page);
    return `${smoke}\n${terminal}`;
  } finally {
    page?.close();
    await browser?.close();
    await server?.close();
  }
}

async function runCodexVersionSmokePage(page) {
  await page.send("Runtime.enable");
  await page.send("Log.enable");

  const status = await waitForSmokeStatus(page, {
    timeoutMs: BROWSER_STATUS_TIMEOUT_MS,
  });
  assert.equal(status.status, "passed", status.error?.message);
  assert.equal(status.result.exitCode, 0);
  assert.equal(status.result.stderr, "");
  assert.match(status.result.stdout, /^codex-cli /);
  assert.equal(status.result.artifactKind, "wasi-module");
  assert.deepEqual(status.result.hardTimeout, {
    errorKind: "timeout",
    exitCode: 124,
    timedOut: true,
  });
  assert.deepEqual(status.result.httpBridge, {
    exitCode: 0,
    stderr: "",
    stderrBytes: 0,
    stdout: "HTTP_BRIDGE_OK\n",
    stdoutBytes: 15,
    urlPath: "/e2e/http-bridge-smoke.txt",
  });
  assert.equal(status.result.workerEntrypoint, "/src/command-worker-entry.js");
  return `PASS browser Codex version smoke e2e: ${status.result.stdout.trim()}`;
}

async function runTerminalShellPage(page) {
  await page.send("Runtime.enable");
  await page.send("Log.enable");

  const ready = await waitForTerminalShellStatus(page, {
    timeoutMs: BROWSER_STATUS_TIMEOUT_MS,
  });
  assert.equal(ready.status, "ready", terminalStatusMessage(ready));
  assert.equal(ready.packageSource.metadata.packageId, "codex");

  await page.send("Runtime.evaluate", {
    expression: `
      (() => {
        document.querySelector("[data-terminal-columns]").value = "96";
        document.querySelector("[data-terminal-rows]").value = "28";
        document.querySelector("[data-terminal-resize]").click();
        document.querySelector("[data-terminal-run]").click();
        return true;
      })()
    `,
    returnByValue: true,
  });

  const status = await waitForTerminalShellStatus(page, {
    expectedOutputPrefix: "codex-cli ",
    timeoutMs: BROWSER_STATUS_TIMEOUT_MS,
  });
  assert.equal(status.status, "passed", terminalStatusMessage(status));
  assert.equal(status.result.exitCode, 0);
  assert.match(status.output, /^codex-cli /);
  assert.deepEqual(status.size, { columns: "96", rows: "28" });

  await page.send("Runtime.evaluate", {
    expression: `
      (() => {
        const bytes = new Uint8Array([0, 119, 101, 98, 99, 115, 109, 111, 107, 101]);
        const encoded = btoa(String.fromCharCode(...bytes));
        const source = document.querySelector("[data-package-source]");
        source.value = "package-url";
        source.dispatchEvent(new Event("change", { bubbles: true }));
        document.querySelector("[data-package-url]").value =
          "data:application/octet-stream;base64," + encoded;
        document.querySelector("[data-package-id]").value = "url-smoke";
        document.querySelector("[data-package-command]").value = "smoke";
        document.querySelector("[data-package-args]").value = "";
        document.querySelector("[data-package-executor]").value = "smoke";
        document.querySelector("[data-package-apply]").click();
        return true;
      })()
    `,
    returnByValue: true,
  });

  const packageStatus = await waitForPackageSourceStatus(page, {
    packageId: "url-smoke",
    timeoutMs: BROWSER_STATUS_TIMEOUT_MS,
  });
  assert.equal(packageStatus.phase, "ready", packageStatus.error?.message);
  assert.equal(packageStatus.metadata.sourceLabel, "data: URL");
  assert.equal(packageStatus.metadata.artifactKind, "webc-package");

  await page.send("Runtime.evaluate", {
    expression: 'document.querySelector("[data-terminal-run]").click()',
    returnByValue: true,
  });
  const urlStatus = await waitForTerminalShellStatus(page, {
    expectedOutputPrefix: "BROWSER_SMOKE_OK",
    timeoutMs: BROWSER_STATUS_TIMEOUT_MS,
  });
  assert.equal(urlStatus.status, "passed", terminalStatusMessage(urlStatus));
  assert.equal(urlStatus.result.exitCode, 0);
  assert.match(urlStatus.output, /^BROWSER_SMOKE_OK/);

  return [
    `PASS browser terminal shell e2e: ${status.output.trim()}`,
    `PASS browser package URL shell e2e: ${urlStatus.output.trim()}`,
  ].join("\\n");
}

function skipReason() {
  if (!CDP_AVAILABLE && !BROWSER_REQUIRED) {
    return "Node WebSocket support is unavailable";
  }
  if (!BROWSER_EXECUTABLE && !BROWSER_REQUIRED) {
    return "Chromium or Chrome executable is unavailable";
  }
  return false;
}

async function startStaticServer(root) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname === "/" ? E2E_PAGE_PATH : url.pathname;
      const filePath = resolve(root, `.${decodeURIComponent(pathname)}`);
      if (!isPathInside(root, filePath)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }
      const body = await readFile(filePath);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        Connection: "close",
        "Content-Type": contentType(filePath),
      });
      response.end(body);
    } catch (error) {
      response.writeHead(error?.code === "ENOENT" ? 404 : 500, {
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end(error?.message ?? "static server error");
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const { port } = server.address();
  return {
    close: async () => {
      const closePromise = new Promise((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await withTimeout(closePromise, 3000, "static server did not close");
    },
    origin: `http://127.0.0.1:${port}`,
  };
}

async function launchBrowser(executable) {
  const debugPort = await freePort();
  const userDataDir = await mkdtemp(join(tmpdir(), "wasm-host-browser-"));
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--disable-background-networking",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-sync",
      "--disable-setuid-sandbox",
      "--no-first-run",
      "--no-sandbox",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const stderr = [];
  let exited = false;
  const exitPromise = once(child, "exit").then(() => {
    exited = true;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  try {
    await waitForDevTools(debugPort, child);
  } catch (error) {
    await terminateBrowser(child, exitPromise, () => exited);
    await removeBrowserProfile(userDataDir);
    throw new Error(
      `browser DevTools endpoint did not start: ${error.message}\n${stderr.join("")}`,
    );
  }

  return {
    close: async () => {
      await terminateBrowser(child, exitPromise, () => exited);
      await removeBrowserProfile(userDataDir);
    },
    debugPort,
  };
}

async function terminateBrowser(child, exitPromise, isExited) {
  if (!isExited()) {
    child.kill("SIGTERM");
  }
  await Promise.race([
    exitPromise,
    delay(3000).then(async () => {
      if (isExited()) {
        return;
      }
      child.kill("SIGKILL");
      await exitPromise;
    }),
  ]).catch(() => {});
}

async function removeBrowserProfile(userDataDir) {
  await rm(userDataDir, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 100,
  });
}

class DevToolsPage {
  constructor(socket) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.socket = socket;
    this.socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });
    this.socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("DevTools socket closed"));
      }
      this.pending.clear();
    });
  }

  static async open(debugPort, url) {
    const target = await fetchJson(
      `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent("about:blank")}`,
      { method: "PUT" },
    );
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await withTimeout(
      new Promise((resolveOpen, reject) => {
        socket.addEventListener("open", resolveOpen, { once: true });
        socket.addEventListener("error", reject, { once: true });
      }),
      5000,
      "DevTools socket did not open",
    );
    const page = new DevToolsPage(socket);
    await page.navigate(url);
    return page;
  }

  send(method, params = {}, timeoutMs = DEVTOOLS_COMMAND_TIMEOUT_MS) {
    const id = this.nextId;
    this.nextId += 1;
    const message = { id, method, params };
    const promise = new Promise((resolveSend, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { reject, resolve: resolveSend, timeout });
    });
    this.socket.send(JSON.stringify(message));
    return promise;
  }

  async navigate(url) {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Page.navigate", { url });
    await waitForPageReady(this, url);
  }

  close() {
    this.socket.close();
  }

  handleMessage(data) {
    const message = JSON.parse(data);
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(
          new Error(
            `${message.error.message}: ${JSON.stringify(message.error.data)}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    this.events.push(message);
  }
}

async function waitForPageReady(page, url) {
  const deadline = Date.now() + BROWSER_STATUS_TIMEOUT_MS;
  let lastState = null;
  while (Date.now() < deadline) {
    const evaluation = await page.send("Runtime.evaluate", {
      expression: `({
        href: location.href,
        readyState: document.readyState,
      })`,
      returnByValue: true,
    });
    lastState = evaluation.result?.value ?? lastState;
    if (lastState?.href === url && lastState.readyState !== "loading") {
      return;
    }
    await delay(100);
  }
  throw new Error(
    `timed out waiting for browser page navigation: ${JSON.stringify({
      events: page.events,
      lastState,
      url,
    })}`,
  );
}

async function waitForSmokeStatus(page, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 10000);
  let lastStatus = null;
  while (Date.now() < deadline) {
    const evaluation = await page.send("Runtime.evaluate", {
      expression: "window.__wasmHostCodexVersionSmokeStatus",
      returnByValue: true,
    });
    const status = evaluation.result?.value;
    lastStatus = status ?? lastStatus;
    if (status?.status === "passed" || status?.status === "failed") {
      return status;
    }
    await delay(100);
  }
  throw new Error(
    `timed out waiting for browser smoke status: ${JSON.stringify({
      lastStatus,
      events: page.events,
    })}`,
  );
}

async function waitForTerminalShellStatus(page, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 10000);
  let lastStatus = null;
  while (Date.now() < deadline) {
    const evaluation = await page.send("Runtime.evaluate", {
      expression: "window.__wasmHostTerminalShellStatus",
      returnByValue: true,
    });
    const status = evaluation.result?.value;
    lastStatus = status ?? lastStatus;
    if (status?.status === "ready" && !options.expectedOutputPrefix) {
      return status;
    }
    if (status?.status === "passed") {
      const output = String(status.output ?? "");
      if (
        !options.expectedOutputPrefix ||
        output.startsWith(options.expectedOutputPrefix)
      ) {
        return status;
      }
    }
    if (status?.status === "failed") {
      return status;
    }
    await delay(100);
  }
  throw new Error(
    `timed out waiting for terminal shell status: ${JSON.stringify({
      lastStatus,
      events: page.events,
    })}`,
  );
}

function terminalStatusMessage(status) {
  return JSON.stringify({
    error: status?.error ?? null,
    output: status?.output ?? "",
    phase: status?.phase ?? null,
    result: status?.result ?? null,
    status: status?.status ?? null,
  });
}

async function waitForPackageSourceStatus(page, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 10000);
  while (Date.now() < deadline) {
    const evaluation = await page.send("Runtime.evaluate", {
      expression: "window.__wasmHostTerminalShellStatus?.packageSource",
      returnByValue: true,
    });
    const status = evaluation.result?.value;
    if (status?.phase === "error") {
      return status;
    }
    if (
      status?.phase === "ready" &&
      (!options.packageId || status.metadata?.packageId === options.packageId)
    ) {
      return status;
    }
    await delay(100);
  }
  throw new Error(
    `timed out waiting for package source status: ${JSON.stringify(page.events)}`,
  );
}

async function waitForDevTools(debugPort, child) {
  const deadline = Date.now() + DEVTOOLS_STARTUP_TIMEOUT_MS;
  let exit = null;
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });
  while (Date.now() < deadline) {
    if (exit) {
      throw new Error(`browser exited with ${JSON.stringify(exit)}`);
    }
    try {
      await fetchJson(`http://127.0.0.1:${debugPort}/json/version`);
      return;
    } catch {
      await delay(DEVTOOLS_POLL_INTERVAL_MS);
    }
  }
  throw new Error(
    `timed out waiting ${DEVTOOLS_STARTUP_TIMEOUT_MS}ms for /json/version`,
  );
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const { port } = server.address();
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return port;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`request failed ${response.status}: ${url}`);
  }
  return response.json();
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function resolveBrowserExecutable() {
  const env = process.env.WASM_HOST_BROWSER;
  if (env) {
    return isAbsolute(env) || env.includes("/")
      ? existsSync(env)
        ? env
        : null
      : findOnPath(env);
  }
  for (const name of [
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "microsoft-edge",
    "microsoft-edge-stable",
  ]) {
    const executable = findOnPath(name);
    if (executable) {
      return executable;
    }
  }
  for (const executable of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ]) {
    if (existsSync(executable)) {
      return executable;
    }
  }
  return null;
}

function findOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) {
      continue;
    }
    const executable = join(directory, name);
    if (existsSync(executable)) {
      return executable;
    }
  }
  return null;
}

function contentType(filePath) {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

function isPathInside(root, filePath) {
  const value = relative(root, filePath);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

const watchdog = setTimeout(() => {
  console.error(
    `browser e2e timed out after ${Math.round(BROWSER_E2E_TIMEOUT_MS / 1000)}s`,
  );
  process.exit(1);
}, BROWSER_E2E_TIMEOUT_MS);

try {
  const result = await runBrowserE2e();
  clearTimeout(watchdog);
  console.log(result);
  process.exit(0);
} catch (error) {
  clearTimeout(watchdog);
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exit(1);
}
