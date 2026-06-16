import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserCommandWorkerError,
  BrowserCommandWorkerRuntime,
  createBrowserCommandWorkerRuntime,
} from "../src/command-worker.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("BrowserCommandWorkerRuntime loads and runs a command", async () => {
  const port = recordingPort();
  const seen = {};
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: { name: "direct" }, gateway: { name: "gateway" } },
    port,
    executors: {
      test: {
        async run(request, output) {
          seen.command = request.command;
          seen.args = request.args;
          seen.cwd = request.cwd;
          seen.env = request.env;
          seen.httpTransportName = request.httpTransportName;
          seen.httpTransport = request.httpTransport;
          seen.stdin = await asyncChunksText(request.stdin);
          await output.writeStdout("out");
          await output.writeStderr(encoder.encode("err"));
          return { exitCode: 7 };
        },
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-1",
    package: {
      id: "pkg",
      type: "test",
      commands: ["run-test"],
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-1",
    packageId: "pkg",
    command: "run-test",
    args: ["--flag", "value"],
    cwd: "/workspace/app",
    env: { A: "1", B: 2 },
    httpTransport: "gateway",
    stdinBase64: "aW5wdXQ=",
  });

  assert.deepEqual(seen, {
    args: ["--flag", "value"],
    command: "run-test",
    cwd: "/workspace/app",
    env: { A: "1", B: "2" },
    httpTransport: { name: "gateway" },
    httpTransportName: "gateway",
    stdin: "input",
  });
  assert.deepEqual(port.messages, [
    {
      type: "command.loaded",
      id: "load-1",
      artifactKind: null,
      cache: null,
      contentSha256: null,
      entrypoint: "run-test",
      packageId: "pkg",
      packageType: "test",
      commands: ["run-test"],
    },
    {
      type: "command.started",
      id: "run-1",
      packageId: "pkg",
      command: "run-test",
      args: ["--flag", "value"],
      cwd: "/workspace/app",
    },
    {
      type: "command.stdout",
      id: "run-1",
      chunk: encoder.encode("out"),
    },
    {
      type: "command.stderr",
      id: "run-1",
      chunk: encoder.encode("err"),
    },
    {
      type: "command.complete",
      id: "run-1",
      result: {
        cancelled: false,
        exitCode: 7,
        failureStage: null,
        stderrBytes: 3,
        stdoutBytes: 3,
        timedOut: false,
      },
    },
  ]);
});

test("BrowserCommandWorkerRuntime streams stdin messages", async () => {
  const port = recordingPort();
  let stdin = null;
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    executors: {
      test: async (request) => {
        stdin = await asyncChunksText(request.stdin);
        return { exitCode: 0 };
      },
    },
    httpTransports: { direct: {} },
  });

  await runtime.handleMessage({
    type: "command.load",
    package: { id: "pkg", type: "test", commands: ["cat"] },
  });
  const run = runtime.handleMessage({
    type: "command.run",
    id: "run-stdin",
    packageId: "pkg",
    command: "cat",
    stdinOpen: true,
  });
  await tick();
  await runtime.handleMessage({
    type: "command.stdin",
    id: "run-stdin",
    chunk: "hello ",
  });
  await runtime.handleMessage({
    type: "command.stdin",
    id: "run-stdin",
    chunkBase64: "d29ybGQ=",
  });
  await runtime.handleMessage({ type: "command.stdin.end", id: "run-stdin" });
  await run;

  assert.equal(stdin, "hello world");
  assert.equal(port.messages.at(-1).type, "command.complete");
});

test("BrowserCommandWorkerRuntime reports startup failures", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: {} },
  });

  await runtime.handleMessage({
    type: "command.run",
    id: "missing-package",
    packageId: "missing",
    command: "smoke",
  });

  assert.deepEqual(port.messages, [
    {
      type: "command.error",
      id: "missing-package",
      error: {
        kind: "invalid_request",
        message: "browser command package is not loaded: missing",
        stage: "package_load",
      },
      result: {
        cancelled: false,
        exitCode: null,
        failureStage: "package_load",
        stderrBytes: 0,
        stdoutBytes: 0,
        timedOut: false,
      },
    },
  ]);
});

test("BrowserCommandWorkerRuntime reports malformed run messages", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: {} },
  });

  await runtime.handleMessage({
    type: "command.run",
    id: "malformed-run",
    packageId: "pkg",
  });

  assert.deepEqual(port.messages, [
    {
      type: "command.error",
      id: "malformed-run",
      error: {
        kind: "invalid_request",
        message: "browser command fields must be non-empty strings",
        stage: "startup",
      },
      result: {
        cancelled: false,
        exitCode: null,
        failureStage: "startup",
        stderrBytes: 0,
        stdoutBytes: 0,
        timedOut: false,
      },
    },
  ]);
});

test("BrowserCommandWorkerRuntime cancels runs waiting for package load", async () => {
  const port = recordingPort();
  const load = deferred();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    packageLoader: { load: async () => load.promise },
    port,
  });

  const loadTask = runtime.handleMessage({
    type: "command.load",
    id: "load-slow",
    package: {
      bytes: new Uint8Array([0]),
      command: "smoke",
      executorType: "smoke",
      id: "slow-pkg",
    },
  });
  await tick();
  const run = runtime.handleMessage({
    type: "command.run",
    id: "run-before-load",
    packageId: "slow-pkg",
    command: "smoke",
  });
  await tick();
  await runtime.handleMessage({
    type: "command.cancel",
    id: "run-before-load",
  });
  await run;
  load.resolve(packageRecord("slow-pkg"));
  await loadTask;

  assert.deepEqual(port.messages.find((message) => message.id === "run-before-load"), {
    type: "command.error",
    id: "run-before-load",
    error: {
      kind: "cancelled",
      message: "browser command cancelled",
      stage: "runtime",
    },
    result: {
      cancelled: true,
      exitCode: 130,
      failureStage: "runtime",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
  assert.equal(
    port.messages.some((message) => message.id === "run-before-load" && message.type === "command.started"),
    false,
  );
});

test("BrowserCommandWorkerRuntime rejects duplicate runs while package load is pending", async () => {
  const port = recordingPort();
  const load = deferred();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    packageLoader: { load: async () => load.promise },
    port,
  });

  const loadTask = runtime.handleMessage({
    type: "command.load",
    id: "load-pending",
    package: {
      bytes: new Uint8Array([0]),
      command: "smoke",
      executorType: "smoke",
      id: "pending-pkg",
    },
  });
  await tick();
  const firstRun = runtime.handleMessage({
    type: "command.run",
    id: "pending-run-a",
    packageId: "pending-pkg",
    command: "smoke",
  });
  await tick();
  await runtime.handleMessage({
    type: "command.run",
    id: "pending-run-b",
    packageId: "pending-pkg",
    command: "smoke",
  });
  load.resolve(packageRecord("pending-pkg"));
  await loadTask;
  await firstRun;

  assert.deepEqual(port.messages.find((message) => message.id === "pending-run-b"), {
    type: "command.error",
    id: "pending-run-b",
    error: {
      kind: "invalid_request",
      message: "another browser command is already running",
      stage: "startup",
    },
    result: {
      cancelled: false,
      exitCode: null,
      failureStage: "startup",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
  assert.equal(
    port.messages.filter((message) => message.type === "command.started").length,
    1,
  );
});

test("BrowserCommandWorkerRuntime rejects duplicate package loads", async () => {
  const port = recordingPort();
  const load = deferred();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    packageLoader: { load: async () => load.promise },
    port,
  });

  const firstLoad = runtime.handleMessage({
    type: "command.load",
    id: "load-a",
    package: {
      bytes: new Uint8Array([0]),
      command: "smoke",
      executorType: "smoke",
      id: "same-pkg",
    },
  });
  await tick();
  await runtime.handleMessage({
    type: "command.load",
    id: "load-b",
    package: {
      bytes: new Uint8Array([1]),
      command: "smoke",
      executorType: "smoke",
      id: "same-pkg",
    },
  });
  load.resolve(packageRecord("same-pkg"));
  await firstLoad;

  assert.deepEqual(port.messages.find((message) => message.id === "load-b"), {
    type: "command.error",
    id: "load-b",
    error: {
      kind: "invalid_request",
      message: "browser command package is already loading: same-pkg",
      stage: "package_load",
    },
    result: {
      cancelled: false,
      exitCode: null,
      failureStage: "package_load",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
  assert.equal(port.messages.filter((message) => message.type === "command.loaded").length, 1);
});

test("BrowserCommandWorkerRuntime maps smoke command resolution failures", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: {} },
  });

  await runtime.handleMessage({
    type: "command.load",
    package: { id: "smoke", type: "smoke", commands: ["smoke"] },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "missing-command",
    packageId: "smoke",
    command: "missing",
  });

  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "missing-command",
    error: {
      kind: "command_not_found",
      message: "browser command not found: missing",
      stage: "command_resolution",
    },
    result: {
      cancelled: false,
      exitCode: 127,
      failureStage: "command_resolution",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
});

test("BrowserCommandWorkerRuntime cancels active commands", async () => {
  const port = recordingPort();
  const runtime = runtimeWithAbortableExecutor(port);

  await loadBlockingPackage(runtime);
  const run = runtime.handleMessage({
    type: "command.run",
    id: "cancel-run",
    packageId: "pkg",
    command: "block",
  });
  await tick();
  await runtime.handleMessage({ type: "command.cancel", id: "cancel-run" });
  await run;

  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "cancel-run",
    error: {
      kind: "cancelled",
      message: "browser command cancelled",
      stage: "runtime",
    },
    result: {
      cancelled: true,
      exitCode: 130,
      failureStage: "runtime",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
  assert.equal(runtime.activeRun, null);
});

test("BrowserCommandWorkerRuntime rejects success after cancellation", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: {} },
    executors: {
      late: {
        async run() {
          await delay(5);
          return { exitCode: 0 };
        },
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    package: { id: "pkg", type: "late", commands: ["late"] },
  });
  const run = runtime.handleMessage({
    type: "command.run",
    id: "late-run",
    packageId: "pkg",
    command: "late",
  });
  await tick();
  await runtime.handleMessage({ type: "command.cancel", id: "late-run" });
  await run;

  assert.equal(port.messages.at(-1).type, "command.error");
  assert.equal(port.messages.at(-1).error.kind, "cancelled");
});

test("BrowserCommandWorkerRuntime times out active commands", async () => {
  const port = recordingPort();
  const runtime = runtimeWithAbortableExecutor(port);

  await loadBlockingPackage(runtime);
  await runtime.handleMessage({
    type: "command.run",
    id: "timeout-run",
    packageId: "pkg",
    command: "block",
    timeoutMs: 5,
  });

  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "timeout-run",
    error: {
      kind: "timeout",
      message: "browser command exceeded wall time limit",
      stage: "runtime",
    },
    result: {
      cancelled: false,
      exitCode: 124,
      failureStage: "runtime",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: true,
    },
  });
});

test("BrowserCommandWorkerRuntime times out non-cooperative commands", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: {} },
    executors: {
      hanging: {
        async run() {
          await new Promise(() => {});
        },
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    package: { id: "pkg", type: "hanging", commands: ["hang"] },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "hang-run",
    packageId: "pkg",
    command: "hang",
    timeoutMs: 5,
  });

  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "hang-run",
    error: {
      kind: "timeout",
      message: "browser command exceeded wall time limit",
      stage: "runtime",
    },
    result: {
      cancelled: false,
      exitCode: 124,
      failureStage: "runtime",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: true,
    },
  });
  assert.equal(runtime.activeRun, null);
});

test("BrowserCommandWorkerRuntime keeps timeout reason for plain AbortError", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: {} },
    executors: {
      aborting: {
        async run(request) {
          await rejectAbortErrorOnAbort(request.signal);
        },
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    package: { id: "pkg", type: "aborting", commands: ["abort"] },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "abort-timeout-run",
    packageId: "pkg",
    command: "abort",
    timeoutMs: 5,
  });

  assert.equal(port.messages.at(-1).error.kind, "timeout");
  assert.equal(port.messages.at(-1).result.exitCode, 124);
  assert.equal(port.messages.at(-1).result.timedOut, true);
});

test("BrowserCommandWorkerRuntime rejects duplicate active runs", async () => {
  const port = recordingPort();
  const runtime = runtimeWithAbortableExecutor(port);

  await loadBlockingPackage(runtime);
  const first = runtime.handleMessage({
    type: "command.run",
    id: "run-a",
    packageId: "pkg",
    command: "block",
  });
  await tick();
  await runtime.handleMessage({
    type: "command.run",
    id: "run-b",
    packageId: "pkg",
    command: "block",
  });
  await runtime.handleMessage({ type: "command.cancel", id: "run-a" });
  await first;

  assert.deepEqual(port.messages.find((message) => message.id === "run-b"), {
    type: "command.error",
    id: "run-b",
    error: {
      kind: "invalid_request",
      message: "another browser command is already running",
      stage: "startup",
    },
    result: {
      cancelled: false,
      exitCode: null,
      failureStage: "startup",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
});

test("BrowserCommandWorkerRuntime can attach to a worker-style port", async () => {
  const port = eventPort();
  const runtime = new BrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: {} },
  });

  runtime.start();
  port.emit({
    type: "command.load",
    package: { id: "smoke", type: "smoke", commands: ["smoke"] },
  });
  port.emit({
    type: "command.run",
    id: "smoke-run",
    packageId: "smoke",
    command: "smoke",
  });
  await tick();
  runtime.stop();

  assert.equal(port.started, true);
  assert.equal(port.listenerCount(), 0);
  assert.equal(chunksText(stdoutChunks(port.messages, "smoke-run")), "BROWSER_SMOKE_OK\n");
  assert.equal(port.messages.at(-1).type, "command.complete");
});

function runtimeWithAbortableExecutor(port) {
  return createBrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: {} },
    executors: {
      blocking: {
        async run(request) {
          await rejectOnAbort(request.signal);
        },
      },
    },
  });
}

function loadBlockingPackage(runtime) {
  return runtime.handleMessage({
    type: "command.load",
    package: { id: "pkg", type: "blocking", commands: ["block"] },
  });
}

function packageRecord(id) {
  return {
    artifactKind: "webc-package",
    byteLength: 5,
    cache: { backend: "memory", modulePath: "module", packagePath: "package" },
    cacheKeys: {},
    commands: ["smoke"],
    contentSha256: "a".repeat(64),
    defaultCommand: "smoke",
    entrypoint: "smoke",
    executorType: "smoke",
    format: "webc",
    id,
    metadata: {},
    sha256: "a".repeat(64),
    source: { kind: "bytes", label: "test" },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

function recordingPort() {
  return {
    messages: [],
    postMessage(message) {
      this.messages.push(message);
    },
  };
}

function eventPort() {
  const listeners = new Set();
  return {
    messages: [],
    started: false,
    addEventListener(type, listener) {
      if (type === "message") {
        listeners.add(listener);
      }
    },
    removeEventListener(type, listener) {
      if (type === "message") {
        listeners.delete(listener);
      }
    },
    postMessage(message) {
      this.messages.push(message);
    },
    start() {
      this.started = true;
    },
    emit(data) {
      for (const listener of listeners) {
        listener({ data });
      }
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

function rejectOnAbort(signal) {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () =>
      reject(
        signal.reason ??
          new BrowserCommandWorkerError(
            "cancelled",
            "browser command cancelled",
            "runtime",
            { cancelled: true, exitCode: 130 },
          ),
      );
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

function rejectAbortErrorOnAbort(signal) {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () => reject(new DOMException("aborted", "AbortError"));
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

function stdoutChunks(messages, id) {
  return messages
    .filter((message) => message.type === "command.stdout" && message.id === id)
    .map((message) => message.chunk);
}

function chunksText(chunks) {
  return decoder.decode(concatChunks(chunks));
}

async function asyncChunksText(chunks) {
  const result = [];
  for await (const chunk of chunks) {
    result.push(chunk);
  }
  return chunksText(result);
}

function concatChunks(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
