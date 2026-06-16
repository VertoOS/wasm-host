import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserTerminalShell } from "../src/terminal-ui.js";

const encoder = new TextEncoder();

test("BrowserTerminalShellController renders worker output and final status", async () => {
  const worker = fakeWorker();
  const controller = terminalShell({ worker });

  const completion = controller.run();
  const run = await waitForSent(worker, "command.run");

  assert.deepEqual(run.terminal, { columns: 80, rows: 24 });

  worker.emit({ type: "command.started", id: run.id });
  worker.emit({
    type: "command.stdout",
    id: run.id,
    chunk: encoder.encode("codex-cli 0.0.0\n"),
  });
  worker.emit({
    type: "command.stderr",
    id: run.id,
    chunk: encoder.encode(""),
  });
  worker.emit({ type: "command.stdout.close", id: run.id });
  worker.emit({ type: "command.stderr.close", id: run.id });
  worker.emit({
    type: "command.complete",
    id: run.id,
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 16,
      timedOut: false,
    },
  });

  assert.equal((await completion).exitCode, 0);
  assert.equal(controller.elements.output.textContent, "codex-cli 0.0.0\n");
  assert.equal(controller.elements.status.textContent, "Exited 0");
  assert.equal(controller.elements.runButton.disabled, false);
});

test("BrowserTerminalShellController sends keyboard, paste, EOF, resize, and cancel messages", async () => {
  const worker = fakeWorker();
  const controller = terminalShell({ worker });

  const completion = controller.run().catch((error) => error);
  const run = await waitForSent(worker, "command.run");

  controller.elements.input.value = "pwd";
  const enter = controller.elements.input.dispatch("keydown", {
    key: "Enter",
    shiftKey: false,
  });
  assert.equal(enter.defaultPrevented, true);

  const paste = controller.elements.input.dispatch("paste", {
    clipboardData: {
      getData: () => "echo pasted\n",
    },
  });
  assert.equal(paste.defaultPrevented, true);

  controller.elements.columnsInput.value = "100";
  controller.elements.rowsInput.value = "32";
  controller.elements.resizeButton.dispatch("click");
  controller.elements.eofButton.dispatch("click");
  controller.elements.cancelButton.dispatch("click");

  assert.deepEqual(
    worker.sent.filter((message) => message.type === "command.stdin"),
    [
      { type: "command.stdin", id: run.id, chunk: encoder.encode("pwd\n") },
      {
        type: "command.stdin",
        id: run.id,
        chunk: encoder.encode("echo pasted\n"),
      },
    ],
  );
  assert.deepEqual(
    worker.sent.find((message) => message.type === "command.terminal.resize"),
    { type: "command.terminal.resize", id: run.id, columns: 100, rows: 32 },
  );
  assert.deepEqual(
    worker.sent.filter((message) =>
      message.type === "command.stdin.end" ||
      message.type === "command.cancel"
    ),
    [
      { type: "command.stdin.end", id: run.id },
      { type: "command.cancel", id: run.id },
    ],
  );

  worker.emit({
    type: "command.error",
    id: run.id,
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

  const error = await completion;
  assert.equal(error.kind, "cancelled");
  assert.equal(controller.elements.status.textContent, "Cancelled");
});

test("BrowserTerminalShellController keeps resize values ready before a run", () => {
  const worker = fakeWorker();
  const controller = terminalShell({ worker });

  controller.elements.columnsInput.value = "120";
  controller.elements.rowsInput.value = "40";

  assert.equal(controller.resize(), false);
  assert.equal(controller.elements.output.dataset.columns, "120");
  assert.equal(controller.elements.output.dataset.rows, "40");
  assert.equal(controller.elements.status.textContent, "Ready: 120x40");
});

test("BrowserTerminalShellController can reconfigure package messages between runs", async () => {
  const firstWorker = fakeWorker();
  const secondWorker = fakeWorker();
  const workers = [firstWorker, secondWorker];
  const controller = createBrowserTerminalShell({
    document: fakeDocument(),
    elements: fakeElements(),
    createWorker: () => workers.shift(),
    loadMessage: {
      type: "command.load",
      id: "load-one",
      package: { id: "one", type: "smoke", commands: ["one"] },
    },
    runMessage: {
      type: "command.run",
      id: "run-one",
      packageId: "one",
      command: "one",
    },
  });

  const firstCompletion = controller.run();
  const firstRun = await waitForSent(firstWorker, "command.run");
  firstWorker.emit({
    type: "command.stdout",
    id: firstRun.id,
    chunk: encoder.encode("old output"),
  });
  firstWorker.emit({
    type: "command.complete",
    id: firstRun.id,
    result: completeResult(10),
  });
  await firstCompletion;

  controller.configurePackage({
    commandLabel: "two --version",
    loadMessage: {
      type: "command.load",
      id: "load-two",
      package: { id: "two", type: "smoke", commands: ["two"] },
    },
    runMessage: {
      type: "command.run",
      id: "run-two",
      packageId: "two",
      command: "two",
      args: ["--version"],
    },
  });

  assert.equal(firstWorker.terminated, true);
  assert.equal(controller.elements.output.textContent, "");
  assert.equal(controller.elements.status.textContent, "Ready: two --version");

  const secondCompletion = controller.run();
  const secondRun = await waitForSent(secondWorker, "command.run");
  assert.equal(secondRun.id, "run-two-1");
  assert.equal(secondRun.packageId, "two");
  assert.deepEqual(
    secondWorker.sent.filter((message) => message.type === "command.load"),
    [
      {
        type: "command.load",
        id: "load-two",
        package: { id: "two", type: "smoke", commands: ["two"] },
      },
    ],
  );
  secondWorker.emit({
    type: "command.complete",
    id: secondRun.id,
    result: completeResult(0),
  });
  await secondCompletion;
});

function terminalShell({ worker }) {
  return createBrowserTerminalShell({
    document: fakeDocument(),
    elements: fakeElements(),
    createWorker: () => worker,
    loadMessage: {
      type: "command.load",
      id: "load-codex",
      package: { id: "codex", type: "smoke", commands: ["codex"] },
    },
    runMessage: {
      type: "command.run",
      id: "run-codex",
      packageId: "codex",
      command: "codex",
      args: ["--version"],
    },
  });
}

function fakeElements() {
  return {
    cancelButton: fakeElement(),
    clearButton: fakeElement(),
    columnsInput: fakeElement({ value: "80" }),
    eofButton: fakeElement(),
    input: fakeElement(),
    inputForm: fakeElement(),
    output: fakeElement(),
    resizeButton: fakeElement(),
    rowsInput: fakeElement({ value: "24" }),
    runButton: fakeElement(),
    sendButton: fakeElement(),
    status: fakeElement(),
  };
}

function fakeElement(options = {}) {
  const listeners = new Map();
  return {
    children: [],
    dataset: {},
    disabled: false,
    scrollHeight: 0,
    scrollTop: 0,
    textContent: "",
    value: options.value ?? "",
    addEventListener(type, listener) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type).add(listener);
    },
    append(child) {
      this.children.push(child);
      this.textContent += child.textContent ?? "";
      this.scrollHeight = this.textContent.length;
    },
    dispatch(type, event = {}) {
      const dispatched = {
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        ...event,
      };
      for (const listener of listeners.get(type) ?? []) {
        listener(dispatched);
      }
      return dispatched;
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    replaceChildren(...children) {
      this.children = children;
      this.textContent = children.map((child) => child.textContent ?? "").join("");
    },
  };
}

function fakeDocument() {
  return {
    createElement() {
      return fakeElement();
    },
  };
}

function fakeWorker() {
  const listeners = new Set();
  return {
    sent: [],
    addEventListener(type, listener) {
      if (type === "message") {
        listeners.add(listener);
      }
    },
    emit(message) {
      for (const listener of listeners) {
        listener({ data: message });
      }
    },
    postMessage(message) {
      this.sent.push(message);
      if (message.type === "command.load") {
        queueMicrotask(() => {
          this.emit({
            type: "command.loaded",
            id: message.id,
            packageId: message.package.id,
          });
        });
      }
    },
    removeEventListener(type, listener) {
      if (type === "message") {
        listeners.delete(listener);
      }
    },
    terminated: false,
    terminate() {
      this.terminated = true;
    },
  };
}

function completeResult(stdoutBytes) {
  return {
    cancelled: false,
    exitCode: 0,
    failureStage: null,
    stderrBytes: 0,
    stdoutBytes,
    timedOut: false,
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForSent(worker, type) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const message = worker.sent.find((item) => item.type === type);
    if (message) {
      return message;
    }
    await settle();
  }
  throw new Error(`timed out waiting for ${type}`);
}
