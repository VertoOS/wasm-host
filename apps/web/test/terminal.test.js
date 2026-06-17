import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserTerminalSessionError,
  createBrowserTerminalSession,
  createTerminalTranscript,
} from "../src/terminal.js";
import { createBrowserCommandWorkerRuntime } from "../src/command-worker.js";
import { createMemoryBrowserWorkspaceStore } from "../src/workspace.js";

const encoder = new TextEncoder();

test("BrowserTerminalSession maps worker stdio and exit messages to a transcript", async () => {
  const port = eventPort();
  const transcript = createTerminalTranscript();
  const session = createBrowserTerminalSession({
    port,
    sink: transcript.sink,
  });

  const completion = session.start({
    id: "term-run",
    packageId: "pkg",
    command: "cat",
    terminal: { cols: 90, rows: 30 },
  });

  assert.deepEqual(port.sent, [
    {
      type: "command.run",
      id: "term-run",
      packageId: "pkg",
      command: "cat",
      cwd: "/workspace",
      stdinOpen: true,
      terminal: { columns: 90, rows: 30 },
    },
  ]);

  port.emit({ type: "command.started", id: "term-run" });
  port.emit({
    type: "command.stdout",
    id: "term-run",
    chunk: encoder.encode("out"),
  });
  port.emit({
    type: "command.stderr",
    id: "term-run",
    chunk: encoder.encode("err"),
  });
  port.emit({ type: "command.stdout.close", id: "term-run" });
  port.emit({ type: "command.stderr.close", id: "term-run" });
  port.emit({
    type: "command.complete",
    id: "term-run",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 3,
      stdoutBytes: 3,
      timedOut: false,
    },
  });

  assert.deepEqual(await completion, {
    cancelled: false,
    exitCode: 0,
    failureStage: null,
    stderrBytes: 3,
    stdoutBytes: 3,
    timedOut: false,
  });
  assert.equal(transcript.stdoutText(), "out");
  assert.equal(transcript.stderrText(), "err");
  assert.deepEqual(
    transcript.events.map((event) => event.type),
    [
      "started",
      "stdout",
      "write",
      "stderr",
      "write",
      "stdout.close",
      "close",
      "stderr.close",
      "close",
      "complete",
      "exit",
    ],
  );
});

test("BrowserTerminalSession captures browser tool fixture transcripts", async () => {
  const workspaceStore = createMemoryBrowserWorkspaceStore();
  await workspaceStore.createDirectory("/workspace/tools", { recursive: true });
  await workspaceStore.writeFile("/workspace/tools/input.txt", "tool file\n");
  const { runtime, terminalPort } = runtimeBackedTerminalPort({
    httpTransports: { direct: {} },
    workspaceStore,
  });
  const transcript = createTerminalTranscript();
  const session = createBrowserTerminalSession({
    port: terminalPort,
    sink: transcript.sink,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-tool-fixture",
    package: {
      bytes: webcBytes("tool-fixture"),
      commands: ["tool-inspect"],
      executorType: "browser-tool-fixture",
      id: "tool-fixture",
    },
  });
  const completion = session.start({
    id: "terminal-tool-fixture",
    packageId: "tool-fixture",
    command: "tool-inspect",
    args: ["/workspace/tools/input.txt"],
    cwd: "/workspace/tools",
    env: {
      BROWSER_TOOL_MODE: "terminal",
      SECRET_SHOULD_NOT_ECHO: "nope",
    },
    timeoutMs: 5000,
  });
  session.writeStdin("terminal ");
  session.writeStdin("stdin\n");
  session.closeStdin();

  const result = await completion;
  const stdout = transcript.stdoutText();

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(stdout), {
    args: ["/workspace/tools/input.txt"],
    command: "tool-inspect",
    cwd: "/workspace/tools",
    env: { BROWSER_TOOL_MODE: "terminal" },
    stdin: "terminal stdin\n",
    workspace: {
      bytes: 10,
      path: "/workspace/tools/input.txt",
      text: "tool file\n",
    },
  });
  assert.equal(
    transcript.stderrText(),
    "browser-tool-fixture: inspected workspace\n",
  );
  assert.deepEqual(
    transcript.events.map((event) => event.type),
    [
      "started",
      "stderr",
      "write",
      "stdout",
      "write",
      "stdout.close",
      "close",
      "stderr.close",
      "close",
      "complete",
      "exit",
    ],
  );
  assert.deepEqual(terminalPort.sent, [
    {
      type: "command.run",
      id: "terminal-tool-fixture",
      packageId: "tool-fixture",
      command: "tool-inspect",
      args: ["/workspace/tools/input.txt"],
      cwd: "/workspace/tools",
      env: {
        BROWSER_TOOL_MODE: "terminal",
        SECRET_SHOULD_NOT_ECHO: "nope",
      },
      timeoutMs: 5000,
      stdinOpen: true,
    },
    {
      type: "command.stdin",
      id: "terminal-tool-fixture",
      chunk: encoder.encode("terminal "),
    },
    {
      type: "command.stdin",
      id: "terminal-tool-fixture",
      chunk: encoder.encode("stdin\n"),
    },
    { type: "command.stdin.end", id: "terminal-tool-fixture" },
  ]);
  assert.equal(stdout.includes("SECRET_SHOULD_NOT_ECHO"), false);
  assert.equal(stdout.includes("nope"), false);
});

test("BrowserTerminalSession sends stdin, resize, cancellation, and stdin close messages", () => {
  const port = eventPort();
  const session = createBrowserTerminalSession({ port });

  session.start({
    id: "interactive-run",
    packageId: "pkg",
    command: "sh",
    stdinOpen: true,
  }).catch(() => {});
  session.writeStdin("hello");
  session.resize({ columns: 100, rows: 32 });
  session.closeStdin();
  session.cancel();

  assert.deepEqual(port.sent, [
    {
      type: "command.run",
      id: "interactive-run",
      packageId: "pkg",
      command: "sh",
      cwd: "/workspace",
      stdinOpen: true,
    },
    {
      type: "command.stdin",
      id: "interactive-run",
      chunk: encoder.encode("hello"),
    },
    {
      type: "command.terminal.resize",
      id: "interactive-run",
      columns: 100,
      rows: 32,
    },
    { type: "command.stdin.end", id: "interactive-run" },
    { type: "command.cancel", id: "interactive-run" },
  ]);
});

test("BrowserTerminalSession rejects on command errors after closing output streams", async () => {
  const port = eventPort();
  const transcript = createTerminalTranscript();
  const session = createBrowserTerminalSession({
    port,
    sink: transcript.sink,
  });

  const completion = session.start({
    id: "failed-run",
    packageId: "pkg",
    command: "run",
  });
  port.emit({
    type: "command.error",
    id: "failed-run",
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

  await assert.rejects(completion, {
    kind: "cancelled",
    message: "browser command cancelled",
    name: "BrowserTerminalSessionError",
    stage: "runtime",
  });
  assert.deepEqual(
    transcript.events.map((event) => event.type),
    ["stdout.close", "close", "stderr.close", "close", "error", "exit"],
  );
});

test("BrowserTerminalSession validates terminal lifecycle and resize input", () => {
  const session = createBrowserTerminalSession({ port: eventPort() });

  assert.throws(
    () => session.writeStdin("too early"),
    /browser terminal session has not started/,
  );
  session.start({ id: "run", packageId: "pkg", command: "cmd" }).catch(() => {});
  assert.throws(
    () => session.start({ id: "again", packageId: "pkg", command: "cmd" }),
    /browser terminal session is already running/,
  );
  assert.throws(
    () => session.resize({ columns: 0, rows: 24 }),
    (error) =>
      error instanceof BrowserTerminalSessionError &&
      error.kind === "invalid_request",
  );
});

function eventPort() {
  const listeners = new Set();
  return {
    sent: [],
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
      this.sent.push(message);
    },
    emit(data) {
      for (const listener of listeners) {
        listener({ data });
      }
    },
  };
}

function runtimeBackedTerminalPort(options = {}) {
  const listeners = new Set();
  let runtime;
  const terminalPort = {
    sent: [],
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
      this.sent.push(message);
      void runtime.handleMessage(message);
    },
  };
  runtime = createBrowserCommandWorkerRuntime({
    ...options,
    port: {
      postMessage(message) {
        for (const listener of listeners) {
          listener({ data: message });
        }
      },
    },
  });
  return { runtime, terminalPort };
}

function webcBytes(suffix) {
  const payload = encoder.encode(suffix);
  const bytes = new Uint8Array(5 + payload.byteLength);
  bytes.set([0x00, 0x77, 0x65, 0x62, 0x63]);
  bytes.set(payload, 5);
  return bytes;
}
