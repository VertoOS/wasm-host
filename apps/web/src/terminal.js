const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_CWD = "/workspace";

export class BrowserTerminalSessionError extends Error {
  constructor(kind, message, options = {}) {
    super(message);
    this.name = "BrowserTerminalSessionError";
    this.kind = kind;
    this.stage = options.stage ?? "terminal";
  }
}

export class BrowserTerminalSession {
  constructor(options = {}) {
    this.port = options.port ?? globalThis;
    this.sink = options.sink ?? {};
    this.id = null;
    this.listener = null;
    this.detach = null;
    this.stdoutClosed = false;
    this.stderrClosed = false;
    this.completion = null;
    this.resolveCompletion = null;
    this.rejectCompletion = null;
  }

  start(run) {
    if (this.completion) {
      throw new BrowserTerminalSessionError(
        "invalid_state",
        "browser terminal session is already running",
      );
    }
    const message = normalizeRunMessage(run);
    this.id = message.id;
    this.stdoutClosed = false;
    this.stderrClosed = false;
    this.attach();
    this.completion = new Promise((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    postMessageToPort(this.port, message);
    return this.completion;
  }

  load(packageMessage) {
    postMessageToPort(this.port, packageMessage);
  }

  writeStdin(chunk) {
    this.postForActiveRun({
      type: "command.stdin",
      chunk: toUint8Array(chunk),
    });
  }

  closeStdin() {
    this.postForActiveRun({ type: "command.stdin.end" });
  }

  errorStdin(error = {}) {
    this.postForActiveRun({
      type: "command.stdin.error",
      error: {
        kind: error.kind ?? "transport",
        message: error.message ?? "browser terminal stdin failed",
      },
    });
  }

  resize(size = {}) {
    const dimensions = normalizeTerminalSize(size);
    this.postForActiveRun({
      type: "command.terminal.resize",
      ...dimensions,
    });
  }

  cancel() {
    this.postForActiveRun({ type: "command.cancel" });
  }

  attach() {
    if (this.listener) {
      return;
    }
    this.listener = (event) => {
      this.handleMessage(event?.data ?? event);
    };
    if (typeof this.port.addEventListener === "function") {
      this.port.addEventListener("message", this.listener);
      this.port.start?.();
      this.detach = () => this.port.removeEventListener("message", this.listener);
      return;
    }
    if (typeof this.port.on === "function") {
      this.port.on("message", this.listener);
      this.detach = () => this.port.off?.("message", this.listener);
      return;
    }
    const previous = this.port.onmessage;
    this.port.onmessage = this.listener;
    this.detach = () => {
      if (this.port.onmessage === this.listener) {
        this.port.onmessage = previous ?? null;
      }
    };
  }

  dispose() {
    this.detach?.();
    this.detach = null;
    this.listener = null;
  }

  handleMessage(message) {
    if (!message || message.id !== this.id) {
      return;
    }
    switch (message.type) {
      case "command.started":
        this.emit("started", message);
        break;
      case "command.stdout":
        this.writeOutput("stdout", message.chunk);
        break;
      case "command.stderr":
        this.writeOutput("stderr", message.chunk);
        break;
      case "command.stdout.close":
        this.closeOutput("stdout");
        break;
      case "command.stderr.close":
        this.closeOutput("stderr");
        break;
      case "command.complete":
        this.finish(message, false);
        break;
      case "command.error":
        this.finish(message, true);
        break;
    }
  }

  postForActiveRun(message) {
    if (!this.id) {
      throw new BrowserTerminalSessionError(
        "invalid_state",
        "browser terminal session has not started",
      );
    }
    postMessageToPort(this.port, { id: this.id, ...message });
  }

  writeOutput(stream, chunk) {
    const bytes = toUint8Array(chunk);
    this.emit(stream, { bytes, stream });
    if (stream === "stdout") {
      this.sink.writeStdout?.(bytes);
    } else {
      this.sink.writeStderr?.(bytes);
    }
    this.sink.write?.(stream, bytes);
  }

  closeOutput(stream) {
    const key = stream === "stdout" ? "stdoutClosed" : "stderrClosed";
    if (this[key]) {
      return;
    }
    this[key] = true;
    this.emit(`${stream}.close`, { stream });
    if (stream === "stdout") {
      this.sink.closeStdout?.();
    } else {
      this.sink.closeStderr?.();
    }
    this.sink.close?.(stream);
  }

  finish(message, failed) {
    this.closeOutput("stdout");
    this.closeOutput("stderr");
    const payload = failed
      ? { error: message.error, failed: true, result: message.result }
      : { failed: false, result: message.result };
    this.emit(failed ? "error" : "complete", payload);
    this.sink.exit?.(payload.result, payload.error ?? null);
    this.dispose();
    if (failed) {
      this.rejectCompletion?.(terminalErrorFromMessage(message));
    } else {
      this.resolveCompletion?.(payload.result);
    }
    this.completion = null;
    this.id = null;
    this.resolveCompletion = null;
    this.rejectCompletion = null;
  }

  emit(type, payload = {}) {
    this.sink.event?.({ id: this.id, ...payload, type });
  }
}

export function createBrowserTerminalSession(options = {}) {
  return new BrowserTerminalSession(options);
}

export function createTerminalTranscript() {
  const decoder = new TextDecoder();
  const events = [];
  const stderr = [];
  const stdout = [];
  return {
    events,
    sink: {
      close(stream) {
        events.push({ stream, type: "close" });
      },
      event(event) {
        events.push(event);
      },
      exit(result, error) {
        events.push({ error, result, type: "exit" });
      },
      write(stream, bytes) {
        events.push({ bytes, stream, text: decoder.decode(bytes), type: "write" });
        if (stream === "stdout") {
          stdout.push(bytes);
        } else {
          stderr.push(bytes);
        }
      },
    },
    stderrText: () => decodeChunks(decoder, stderr),
    stdoutText: () => decodeChunks(decoder, stdout),
  };
}

function normalizeRunMessage(value = {}) {
  const run = value.run ?? value;
  const id = nonEmptyString(run.id ?? value.id, "run id is required");
  return {
    ...run,
    cwd: run.cwd ?? DEFAULT_CWD,
    id,
    stdinOpen: run.stdinOpen ?? true,
    type: "command.run",
  };
}

function normalizeTerminalSize(value) {
  return {
    columns: terminalSizeValue(value.columns ?? value.cols ?? DEFAULT_COLUMNS),
    rows: terminalSizeValue(value.rows ?? DEFAULT_ROWS),
  };
}

function terminalSizeValue(value) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new BrowserTerminalSessionError(
      "invalid_request",
      "browser terminal size must be a positive integer",
    );
  }
  return size;
}

function terminalErrorFromMessage(message) {
  const error = message.error ?? {};
  return new BrowserTerminalSessionError(
    error.kind ?? "runtime",
    error.message ?? "browser terminal command failed",
    { stage: error.stage },
  );
}

function postMessageToPort(port, message) {
  if (typeof port.postMessage !== "function") {
    throw new BrowserTerminalSessionError(
      "transport",
      "browser terminal port does not support postMessage",
    );
  }
  port.postMessage(message);
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  throw new BrowserTerminalSessionError(
    "invalid_request",
    "browser terminal chunks must be bytes or strings",
  );
}

function nonEmptyString(value, message) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new BrowserTerminalSessionError("invalid_request", message);
  }
  return text;
}

function decodeChunks(decoder, chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return decoder.decode(bytes);
}
