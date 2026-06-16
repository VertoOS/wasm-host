import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserTerminalSessionError,
  createBrowserTerminalSession,
  createTerminalTranscript,
} from "../src/terminal.js";

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
