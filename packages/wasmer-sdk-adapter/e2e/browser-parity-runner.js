import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile, mkdtemp, rm } from "node:fs/promises";
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

const ADAPTER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(ADAPTER_ROOT, "../..");
const PAGE_PATH = "/packages/wasmer-sdk-adapter/e2e/browser-parity.html";
const BROWSER_REQUIRED = process.env.WASM_HOST_BROWSER_E2E_REQUIRED === "1";
const BROWSER_EXECUTABLE = resolveBrowserExecutable();
const CDP_AVAILABLE = typeof globalThis.WebSocket === "function";
const PRINT_JSON = process.env.WASM_HOST_WASMER_SDK_E2E_JSON === "1";
const DEVTOOLS_STARTUP_TIMEOUT_MS = 60000;
const DEVTOOLS_COMMAND_TIMEOUT_MS = 30000;
const STATUS_TIMEOUT_MS = 240000;
const POLL_INTERVAL_MS = 100;

async function runWasmerSdkBrowserParityE2e() {
  const skip = skipReason();
  if (skip) {
    return `SKIP Wasmer SDK browser parity e2e: ${skip}`;
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
    server = await startStaticServer(REPO_ROOT);
    browser = await launchBrowser(BROWSER_EXECUTABLE);
    page = await DevToolsPage.open(
      browser.debugPort,
      `${server.origin}${PAGE_PATH}`,
    );
    const status = await waitForParityStatus(page);
    assert.notEqual(status.status, "failed", statusMessage(status));
    if (status.status === "blocked") {
      const summary = [
        "BLOCKED Wasmer SDK browser parity e2e:",
        status.result?.blocker?.stage,
        status.result?.blocker?.kind,
        status.result?.blocker?.message,
      ]
        .filter(Boolean)
        .join(" ");
      return PRINT_JSON
        ? `${summary}\n${JSON.stringify(status.result, null, 2)}`
        : summary;
    }

    assert.equal(status.status, "passed", statusMessage(status));
    assert.equal(status.result?.blocked, false);
    assert.equal(status.result?.environment?.crossOriginIsolated, true);
    assert.equal(status.result?.environment?.sharedArrayBuffer, true);
    assert.equal(status.result?.registry?.exitCode, 7);
    assert.equal(status.result?.registry?.stderr, "");
    assert(
      status.result?.registry?.stdout?.includes("ISSUE_228_SDK_OK"),
      statusMessage(status),
    );
    return "PASS Wasmer SDK browser parity e2e";
  } finally {
    page?.close();
    await browser?.close();
    await server?.close();
  }
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
      const pathname = url.pathname === "/" ? PAGE_PATH : url.pathname;
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
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin",
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
  const userDataDir = await mkdtemp(
    join(tmpdir(), "wasm-host-wasmer-sdk-browser-"),
  );
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
    { stdio: ["ignore", "ignore", "pipe"] },
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

class DevToolsPage {
  constructor(socket) {
    this.events = [];
    this.nextId = 1;
    this.pending = new Map();
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
    await this.send("Log.enable");
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
  const deadline = Date.now() + DEVTOOLS_COMMAND_TIMEOUT_MS;
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
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `timed out waiting for browser page navigation: ${JSON.stringify({
      events: page.events,
      lastState,
      url,
    })}`,
  );
}

async function waitForParityStatus(page) {
  const deadline = Date.now() + STATUS_TIMEOUT_MS;
  let lastStatus = null;
  while (Date.now() < deadline) {
    const evaluation = await page.send("Runtime.evaluate", {
      expression: "window.__wasmHostWasmerSdkParityStatus",
      returnByValue: true,
    });
    const status = evaluation.result?.value;
    lastStatus = status ?? lastStatus;
    if (
      status?.status === "passed" ||
      status?.status === "blocked" ||
      status?.status === "failed"
    ) {
      return status;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `timed out waiting for Wasmer SDK parity status: ${JSON.stringify({
      events: page.events,
      lastStatus,
    })}`,
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
      await delay(POLL_INTERVAL_MS);
    }
  }
  throw new Error(
    `timed out ${DEVTOOLS_STARTUP_TIMEOUT_MS}ms for /json/version`,
  );
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

function statusMessage(status) {
  return JSON.stringify({
    error: status?.error ?? null,
    phase: status?.phase ?? null,
    result: status?.result ?? null,
    status: status?.status ?? null,
  });
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

runWasmerSdkBrowserParityE2e()
  .then((message) => {
    console.log(message);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
