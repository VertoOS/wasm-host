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

  const status = await waitForSmokeStatus(page, { timeoutMs: 15000 });
  assert.equal(status.status, "passed", status.error?.message);
  assert.equal(status.result.exitCode, 0);
  assert.equal(status.result.stderr, "");
  assert.match(status.result.stdout, /^codex-cli /);
  assert.equal(status.result.artifactKind, "wasi-module");
  assert.equal(status.result.workerEntrypoint, "/src/command-worker-entry.js");
  return `PASS browser Codex version smoke e2e: ${status.result.stdout.trim()}`;
}

async function runTerminalShellPage(page) {
  await page.send("Runtime.enable");
  await page.send("Log.enable");

  const ready = await waitForTerminalShellStatus(page, { timeoutMs: 15000 });
  assert.equal(ready.status, "ready", ready.error?.message);

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

  const status = await waitForTerminalShellStatus(page, { timeoutMs: 15000 });
  assert.equal(status.status, "passed", status.error?.message);
  assert.equal(status.result.exitCode, 0);
  assert.match(status.output, /^codex-cli /);
  assert.deepEqual(status.size, { columns: "96", rows: "28" });
  return `PASS browser terminal shell e2e: ${status.output.trim()}`;
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
    child.kill("SIGTERM");
    await rm(userDataDir, { force: true, recursive: true });
    throw new Error(
      `browser DevTools endpoint did not start: ${error.message}\n${stderr.join("")}`,
    );
  }

  return {
    close: async () => {
      if (!exited) {
        child.kill("SIGTERM");
      }
      await Promise.race([
        exitPromise,
        delay(3000).then(async () => {
          if (exited) {
            return;
          }
          child.kill("SIGKILL");
          await exitPromise;
        }),
      ]).catch(() => {});
      await rm(userDataDir, { force: true, recursive: true });
    },
    debugPort,
  };
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
      `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`,
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
    return new DevToolsPage(socket);
  }

  send(method, params = {}, timeoutMs = 5000) {
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

async function waitForSmokeStatus(page, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 10000);
  while (Date.now() < deadline) {
    const evaluation = await page.send("Runtime.evaluate", {
      expression: "window.__wasmHostCodexVersionSmokeStatus",
      returnByValue: true,
    });
    const status = evaluation.result?.value;
    if (status?.status === "passed" || status?.status === "failed") {
      return status;
    }
    await delay(100);
  }
  throw new Error(
    `timed out waiting for browser smoke status: ${JSON.stringify(page.events)}`,
  );
}

async function waitForTerminalShellStatus(page, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 10000);
  while (Date.now() < deadline) {
    const evaluation = await page.send("Runtime.evaluate", {
      expression: "window.__wasmHostTerminalShellStatus",
      returnByValue: true,
    });
    const status = evaluation.result?.value;
    if (status?.status === "ready" || status?.status === "passed") {
      return status;
    }
    if (status?.status === "failed") {
      return status;
    }
    await delay(100);
  }
  throw new Error(
    `timed out waiting for terminal shell status: ${JSON.stringify(page.events)}`,
  );
}

async function waitForDevTools(debugPort, child) {
  let exit = null;
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (exit) {
      throw new Error(`browser exited with ${JSON.stringify(exit)}`);
    }
    try {
      await fetchJson(`http://127.0.0.1:${debugPort}/json/version`);
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error("timed out waiting for /json/version");
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
  console.error("browser e2e timed out after 45s");
  process.exit(1);
}, 45000);

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
