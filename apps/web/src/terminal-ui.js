import { createBrowserTerminalSession } from "./terminal.js";

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_WORKER_NAME = "wasm-host-terminal";

export class BrowserTerminalShellError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "BrowserTerminalShellError";
    this.kind = kind;
  }
}

export class BrowserTerminalShellController {
  constructor(options = {}) {
    this.document = options.document ?? globalThis.document;
    this.elements = normalizeElements(options.elements);
    this.createWorker = options.createWorker ?? createDefaultCommandWorker;
    this.createSession = options.createSession ?? createBrowserTerminalSession;
    this.loadMessage = cloneMessage(options.loadMessage);
    this.runMessage = cloneMessage(options.runMessage);
    this.commandLabel =
      options.commandLabel ?? commandLabelFromRunMessage(this.runMessage);
    this.onStateChange = options.onStateChange ?? (() => {});
    this.worker = null;
    this.loaded = false;
    this.loadPromise = null;
    this.session = null;
    this.phase = "idle";
    this.runCount = 0;
    this.lastError = null;
    this.lastResult = null;
    this.stdoutDecoder = null;
    this.stderrDecoder = null;
    this.disposers = [];
    this.bind();
    this.setStatus(`Ready: ${this.commandLabel}`);
    this.updateControls();
  }

  async run() {
    if (this.phase === "loading" || this.phase === "running") {
      return this.activeRunPromise;
    }
    this.clearOutput();
    this.lastError = null;
    this.lastResult = null;
    this.stdoutDecoder = new TextDecoder();
    this.stderrDecoder = new TextDecoder();
    this.setPhase("loading", "Loading package");

    this.activeRunPromise = this.runOnce()
      .then((result) => {
        this.lastResult = result;
        this.setPhase("complete", `Exited ${result.exitCode}`);
        return result;
      })
      .catch((error) => {
        this.lastError = error;
        const cancelled = error?.kind === "cancelled";
        this.setPhase(
          cancelled ? "cancelled" : "error",
          cancelled ? "Cancelled" : error?.message ?? String(error),
        );
        throw error;
      })
      .finally(() => {
        this.session = null;
        this.activeRunPromise = null;
        this.updateControls();
      });
    return this.activeRunPromise;
  }

  configurePackage(options = {}) {
    if (this.phase === "loading" || this.phase === "running") {
      throw new BrowserTerminalShellError(
        "invalid_state",
        "cannot change packages while a command is running",
      );
    }
    this.loadMessage = cloneMessage(options.loadMessage);
    this.runMessage = cloneMessage(options.runMessage);
    this.commandLabel =
      options.commandLabel ?? commandLabelFromRunMessage(this.runMessage);
    this.lastError = null;
    this.lastResult = null;
    this.loaded = false;
    this.loadPromise = null;
    this.runCount = 0;
    this.resetWorker();
    this.clearOutput();
    this.setPhase("idle", `Ready: ${this.commandLabel}`);
  }

  writeStdin(text) {
    if (!this.session || this.phase !== "running") {
      return false;
    }
    this.session.writeStdin(text);
    return true;
  }

  closeStdin() {
    if (!this.session || this.phase !== "running") {
      return false;
    }
    this.session.closeStdin();
    this.elements.eofButton.disabled = true;
    return true;
  }

  resize() {
    const size = this.currentSize();
    this.elements.output.dataset.columns = String(size.columns);
    this.elements.output.dataset.rows = String(size.rows);
    if (!this.session || this.phase !== "running") {
      this.setStatus(`Ready: ${size.columns}x${size.rows}`);
      return false;
    }
    this.session.resize(size);
    this.setStatus(`Running: ${size.columns}x${size.rows}`);
    return true;
  }

  cancel() {
    if (!this.session || this.phase !== "running") {
      return false;
    }
    this.session.cancel();
    this.setStatus("Cancelling");
    return true;
  }

  destroy() {
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
    this.session?.dispose();
    this.session = null;
    this.resetWorker();
  }

  resetWorker() {
    this.worker?.terminate?.();
    this.worker = null;
    this.loaded = false;
    this.loadPromise = null;
  }

  async runOnce() {
    const worker = this.ensureWorker();
    await this.ensureLoaded(worker);
    this.setPhase("running", "Running");
    this.session = this.createSession({
      port: worker,
      sink: this.createSink(),
    });
    this.runCount += 1;
    const run = {
      ...this.runMessage,
      id: `${this.runMessage.id ?? "terminal-run"}-${this.runCount}`,
      stdinOpen: this.runMessage.stdinOpen ?? true,
      terminal: this.currentSize(),
    };
    return this.session.start(run);
  }

  ensureWorker() {
    if (!this.worker) {
      this.worker = this.createWorker();
      if (!this.worker || typeof this.worker.postMessage !== "function") {
        throw new BrowserTerminalShellError(
          "transport",
          "terminal worker does not support postMessage",
        );
      }
    }
    return this.worker;
  }

  ensureLoaded(worker) {
    if (this.loaded) {
      return Promise.resolve();
    }
    if (!this.loadPromise) {
      this.loadPromise = dispatchLoad(worker, this.loadMessage)
        .then(() => {
          this.loaded = true;
        })
        .catch((error) => {
          this.loadPromise = null;
          throw error;
        });
    }
    return this.loadPromise;
  }

  createSink() {
    return {
      close: (stream) => this.flushStream(stream),
      event: (event) => {
        if (event.type === "started") {
          this.setStatus(`Running: ${this.commandLabel}`);
        }
      },
      exit: (result, error) => {
        this.lastResult = result ?? null;
        this.lastError = error ?? null;
      },
      write: (stream, bytes) => this.appendOutput(stream, bytes),
    };
  }

  bind() {
    this.listen(this.elements.runButton, "click", () => {
      this.run().catch(() => {});
    });
    this.listen(this.elements.cancelButton, "click", () => {
      this.cancel();
    });
    this.listen(this.elements.eofButton, "click", () => {
      this.closeStdin();
    });
    this.listen(this.elements.resizeButton, "click", () => {
      this.resize();
    });
    this.listen(this.elements.clearButton, "click", () => {
      this.clearOutput();
    });
    this.listen(this.elements.inputForm, "submit", (event) => {
      event.preventDefault?.();
      this.sendInputLine();
    });
    this.listen(this.elements.sendButton, "click", (event) => {
      event.preventDefault?.();
      this.sendInputLine();
    });
    this.listen(this.elements.input, "keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey) {
        return;
      }
      event.preventDefault?.();
      this.sendInputLine();
    });
    this.listen(this.elements.input, "paste", (event) => {
      const text = event.clipboardData?.getData?.("text");
      if (!text) {
        return;
      }
      if (this.writeStdin(text)) {
        event.preventDefault?.();
      }
    });
  }

  listen(target, type, listener) {
    if (!target || typeof target.addEventListener !== "function") {
      return;
    }
    target.addEventListener(type, listener);
    this.disposers.push(() => target.removeEventListener?.(type, listener));
  }

  sendInputLine() {
    const text = this.elements.input.value;
    if (!text) {
      return false;
    }
    const sent = this.writeStdin(`${text}\n`);
    if (sent) {
      this.elements.input.value = "";
    }
    return sent;
  }

  appendOutput(stream, bytes) {
    const decoder = stream === "stderr" ? this.stderrDecoder : this.stdoutDecoder;
    const text = (decoder ?? new TextDecoder()).decode(bytes, { stream: true });
    appendOutputText(this.document, this.elements.output, stream, text);
  }

  flushStream(stream) {
    const decoder = stream === "stderr" ? this.stderrDecoder : this.stdoutDecoder;
    if (!decoder) {
      return;
    }
    const text = decoder.decode();
    appendOutputText(this.document, this.elements.output, stream, text);
  }

  clearOutput() {
    replaceChildren(this.elements.output);
    this.elements.output.textContent = "";
  }

  currentSize() {
    return {
      columns: positiveInteger(this.elements.columnsInput.value, DEFAULT_COLUMNS),
      rows: positiveInteger(this.elements.rowsInput.value, DEFAULT_ROWS),
    };
  }

  setPhase(phase, status) {
    this.phase = phase;
    this.setStatus(status);
    this.updateControls();
  }

  setStatus(text) {
    this.elements.status.textContent = text;
    this.elements.status.dataset.phase = this.phase;
    this.onStateChange({
      error: this.lastError,
      phase: this.phase,
      result: this.lastResult,
      status: text,
    });
  }

  updateControls() {
    const running = this.phase === "running";
    const busy = running || this.phase === "loading";
    this.elements.runButton.disabled = busy;
    this.elements.cancelButton.disabled = !running;
    this.elements.eofButton.disabled = !running;
    this.elements.input.disabled = !running;
    this.elements.sendButton.disabled = !running;
  }
}

export function createBrowserTerminalShell(options = {}) {
  return new BrowserTerminalShellController(options);
}

export function mountBrowserTerminalShell(options = {}) {
  const document = options.document ?? globalThis.document;
  const root = options.root ?? document?.getElementById?.("app");
  if (!document || !root) {
    throw new BrowserTerminalShellError(
      "invalid_request",
      "terminal shell requires a document root",
    );
  }
  const { elements, shell } = renderTerminalShell(document, options);
  replaceChildren(root, shell);
  return createBrowserTerminalShell({
    ...options,
    document,
    elements,
  });
}

export function createDefaultCommandWorker() {
  return new Worker(new URL("./command-worker-entry.js", import.meta.url), {
    name: DEFAULT_WORKER_NAME,
    type: "module",
  });
}

function renderTerminalShell(document, options) {
  const shell = document.createElement("main");
  shell.className = "terminal-shell";
  shell.dataset.terminalShell = "";

  const header = document.createElement("header");
  header.className = "terminal-shell__header";

  const titleBlock = document.createElement("div");
  const title = document.createElement("h1");
  title.textContent = options.title ?? "wasm-host terminal";
  const subtitle = document.createElement("p");
  subtitle.textContent =
    options.subtitle ?? "Browser worker command session";
  titleBlock.append(title, subtitle);

  const status = document.createElement("div");
  status.className = "terminal-shell__status";
  status.dataset.terminalStatus = "";
  status.setAttribute("role", "status");

  header.append(titleBlock, status);

  const toolbar = document.createElement("div");
  toolbar.className = "terminal-shell__toolbar";

  const runButton = button(document, "Run", "terminalRun");
  const cancelButton = button(document, "Cancel", "terminalCancel");
  const eofButton = button(document, "EOF", "terminalEof");
  const clearButton = button(document, "Clear", "terminalClear");

  const sizeGroup = document.createElement("div");
  sizeGroup.className = "terminal-shell__size";
  const columnsInput = numberInput(
    document,
    "Cols",
    "terminalColumns",
    DEFAULT_COLUMNS,
  );
  const rowsInput = numberInput(document, "Rows", "terminalRows", DEFAULT_ROWS);
  const resizeButton = button(document, "Resize", "terminalResize");
  sizeGroup.append(
    columnsInput.label,
    columnsInput.input,
    rowsInput.label,
    rowsInput.input,
    resizeButton,
  );

  toolbar.append(runButton, cancelButton, eofButton, clearButton, sizeGroup);

  const output = document.createElement("pre");
  output.className = "terminal-shell__output";
  output.dataset.terminalOutput = "";
  output.dataset.columns = String(DEFAULT_COLUMNS);
  output.dataset.rows = String(DEFAULT_ROWS);
  output.setAttribute("aria-live", "polite");
  output.setAttribute("role", "log");
  output.tabIndex = 0;

  const inputForm = document.createElement("form");
  inputForm.className = "terminal-shell__input";
  inputForm.dataset.terminalInputForm = "";
  const input = document.createElement("textarea");
  input.dataset.terminalInput = "";
  input.rows = 2;
  input.spellcheck = false;
  input.placeholder = "stdin";
  const sendButton = button(document, "Send", "terminalSend");
  sendButton.type = "submit";
  inputForm.append(input, sendButton);

  shell.append(header, toolbar, output, inputForm);

  return {
    elements: {
      cancelButton,
      clearButton,
      columnsInput: columnsInput.input,
      eofButton,
      input,
      inputForm,
      output,
      resizeButton,
      rowsInput: rowsInput.input,
      runButton,
      sendButton,
      status,
    },
    shell,
  };
}

function button(document, text, dataName) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.dataset[dataName] = "";
  return element;
}

function numberInput(document, labelText, dataName, value) {
  const id = `terminal-${dataName}`;
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = labelText;
  const input = document.createElement("input");
  input.dataset[dataName] = "";
  input.id = id;
  input.inputMode = "numeric";
  input.min = "1";
  input.step = "1";
  input.type = "number";
  input.value = String(value);
  return { input, label };
}

function dispatchLoad(worker, message) {
  const id = message.id;
  return new Promise((resolve, reject) => {
    const cleanup = attachPortListener(worker, (event) => {
      const data = event?.data ?? event;
      if (!data || data.id !== id) {
        return;
      }
      if (data.type === "command.loaded") {
        cleanup();
        resolve(data);
        return;
      }
      if (data.type === "command.error") {
        cleanup();
        reject(
          new BrowserTerminalShellError(
            data.error?.kind ?? "load_failed",
            data.error?.message ?? "terminal package load failed",
          ),
        );
      }
    });
    worker.postMessage(message);
  });
}

function attachPortListener(port, listener) {
  if (typeof port.addEventListener === "function") {
    port.addEventListener("message", listener);
    return () => port.removeEventListener?.("message", listener);
  }
  if (typeof port.on === "function") {
    port.on("message", listener);
    return () => port.off?.("message", listener);
  }
  const previous = port.onmessage;
  port.onmessage = listener;
  return () => {
    if (port.onmessage === listener) {
      port.onmessage = previous ?? null;
    }
  };
}

function appendOutputText(document, output, stream, text) {
  if (!text) {
    return;
  }
  if (document?.createElement && typeof output.append === "function") {
    const span = document.createElement("span");
    span.dataset.stream = stream;
    span.textContent = text;
    output.append(span);
  } else {
    output.textContent = `${output.textContent ?? ""}${text}`;
  }
  output.scrollTop = output.scrollHeight ?? output.scrollTop ?? 0;
}

function replaceChildren(element, ...children) {
  if (typeof element.replaceChildren === "function") {
    element.replaceChildren(...children);
    return;
  }
  element.children = children;
  element.textContent = "";
}

function normalizeElements(elements) {
  const required = [
    "cancelButton",
    "clearButton",
    "columnsInput",
    "eofButton",
    "input",
    "inputForm",
    "output",
    "resizeButton",
    "rowsInput",
    "runButton",
    "sendButton",
    "status",
  ];
  for (const name of required) {
    if (!elements?.[name]) {
      throw new BrowserTerminalShellError(
        "invalid_request",
        `terminal shell element is missing: ${name}`,
      );
    }
  }
  return elements;
}

function cloneMessage(message) {
  if (!message || typeof message !== "object") {
    throw new BrowserTerminalShellError(
      "invalid_request",
      "terminal shell requires worker messages",
    );
  }
  return { ...message };
}

function commandLabelFromRunMessage(message) {
  const args = Array.isArray(message.args) ? message.args : [];
  return [message.command, ...args].filter(Boolean).join(" ");
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
