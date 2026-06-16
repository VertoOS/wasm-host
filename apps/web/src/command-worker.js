import { createDefaultHttpTransports } from "./http-worker.js";
import {
  commandPackageFromRecord,
  createBrowserPackageLoader,
} from "./package-loader.js";
import {
  createRawWasiModuleExecutor,
  loadRawWasiModulePackage,
  packageNeedsRawWasiModuleLoader,
} from "./wasi-module.js";

const DEFAULT_PACKAGE_ID = "default";
const DEFAULT_HTTP_TRANSPORT = "direct";
const CANCELLED_EXIT_CODE = 130;
const TIMEOUT_EXIT_CODE = 124;

export class BrowserCommandWorkerError extends Error {
  constructor(kind, message, stage = "runtime", options = {}) {
    super(message);
    this.name = "BrowserCommandWorkerError";
    this.kind = kind;
    this.stage = stage;
    this.exitCode = options.exitCode ?? null;
    this.cancelled = options.cancelled === true;
    this.timedOut = options.timedOut === true;
  }
}

export class BrowserCommandWorkerRuntime {
  constructor(options = {}) {
    this.port = options.port ?? globalThis;
    this.defaultHttpTransport =
      options.defaultHttpTransport ?? DEFAULT_HTTP_TRANSPORT;
    this.httpTransports =
      options.httpTransports ?? createDefaultHttpTransports(options);
    this.executors = options.executors ?? {
      smoke: createSmokeCommandExecutor(options.smoke),
      "wasi-module": createRawWasiModuleExecutor(options.wasiModule),
    };
    this.packageLoader =
      options.packageLoader ??
      createBrowserPackageLoader(options.packageLoaderOptions ?? options);
    this.packages = new Map();
    this.packageLoads = new Map();
    this.activeRun = null;
    this.listener = null;
    this.detach = null;
  }

  start() {
    if (this.listener) {
      return;
    }
    this.listener = (event) => {
      void this.handleMessage(event?.data ?? event);
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

  stop() {
    this.detach?.();
    this.listener = null;
    this.detach = null;
    if (this.activeRun) {
      this.abortRun(this.activeRun, cancelledError());
      this.activeRun.stdin.cancel();
      this.activeRun = null;
    }
  }

  async handleMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }
    switch (message.type) {
      case "command.load":
        await this.loadPackage(message);
        break;
      case "command.run":
        await this.runCommand(message);
        break;
      case "command.stdin":
        this.handleStdinChunk(message);
        break;
      case "command.stdin.end":
        this.handleStdinEnd(message);
        break;
      case "command.stdin.error":
        this.handleStdinError(message);
        break;
      case "command.cancel":
        this.cancel(message.id);
        break;
    }
  }

  async loadPackage(message) {
    const value = message.package ?? message;
    const packageId = packageLoadKey(value);
    if (this.packageLoads.has(packageId)) {
      this.postCommandError(
        message.id ?? packageId,
        new BrowserCommandWorkerError(
          "invalid_request",
          `browser command package is already loading: ${packageId}`,
          "package_load",
        ),
      );
      return;
    }
    const loadRecord = { promise: this.packageFromLoadMessage(message) };
    this.packageLoads.set(packageId, loadRecord);
    try {
      const packageRecord = await loadRecord.promise;
      if (this.packageLoads.get(packageId) !== loadRecord) {
        return;
      }
      this.packages.set(packageRecord.id, packageRecord);
      postMessageToPort(this.port, {
        type: "command.loaded",
        id: message.id ?? packageRecord.id,
        artifactKind: packageRecord.artifactKind,
        cache: packageRecord.cache,
        contentSha256: packageRecord.contentSha256,
        entrypoint: packageRecord.entrypoint,
        packageId: packageRecord.id,
        packageType: packageRecord.type,
        commands: packageRecord.commands,
      });
    } catch (error) {
      this.postCommandError(message.id ?? message.package?.id, error);
    } finally {
      if (this.packageLoads.get(packageId) === loadRecord) {
        this.packageLoads.delete(packageId);
      }
    }
  }

  async packageFromLoadMessage(message) {
    const value = message.package ?? message;
    if (packageNeedsRawWasiModuleLoader(value)) {
      return loadRawWasiModulePackage(value);
    }
    if (packageNeedsBrowserLoader(value)) {
      return commandPackageFromRecord(await this.packageLoader.load(value));
    }
    return normalizePackage(value);
  }

  async runCommand(message) {
    let run;
    try {
      run = normalizeRunMessage(message);
    } catch (error) {
      this.postCommandError(message.id ?? message.run?.id, error);
      return;
    }
    if (this.activeRun) {
      this.postCommandError(
        run.id,
        new BrowserCommandWorkerError(
          "invalid_request",
          "another browser command is already running",
          "startup",
        ),
      );
      return;
    }

    const activeRun = createActiveRun(run.id);
    this.activeRun = activeRun;
    enqueueInitialStdin(activeRun.stdin, run);
    if (!run.stdinOpen) {
      activeRun.stdin.end();
    }
    if (run.timeoutMs != null) {
      activeRun.timeout = setTimeout(() => {
        this.abortRun(activeRun, timeoutError());
      }, run.timeoutMs);
    }

    let packageRecord;
    let executor;
    let http;
    try {
      packageRecord = await waitForRunAbort(this.packageForRun(run), activeRun);
      throwIfAborted(activeRun.controller.signal);
      executor = this.resolveExecutor(packageRecord.type);
      http = this.resolveHttpTransport(run.httpTransport);
    } catch (error) {
      const normalized = normalizeRunError(activeRun, error);
      postMessageToPort(this.port, {
        type: "command.error",
        id: run.id,
        error: commandErrorPayload(normalized),
        result: errorResult(activeRun, normalized),
      });
      clearTimeout(activeRun.timeout);
      if (this.activeRun === activeRun) {
        this.activeRun = null;
      }
      return;
    }

    try {
      postMessageToPort(this.port, {
        type: "command.started",
        id: run.id,
        packageId: packageRecord.id,
        command: run.command,
        args: run.args,
        cwd: run.cwd,
      });
      const output = new CommandOutputWriter(this.port, run.id, activeRun);
      const result = await callExecutorWithAbort(executor, {
        args: run.args,
        command: run.command,
        cwd: run.cwd,
        env: run.env,
        httpTransport: http.transport,
        httpTransportName: http.name,
        httpTransports: this.httpTransports,
        package: packageRecord,
        signal: activeRun.controller.signal,
        stdin: activeRun.stdin,
      }, output);
      throwIfAborted(activeRun.controller.signal);
      postMessageToPort(this.port, {
        type: "command.complete",
        id: run.id,
        result: completeResult(activeRun, result),
      });
    } catch (error) {
      const normalized = normalizeRunError(activeRun, error);
      postMessageToPort(this.port, {
        type: "command.error",
        id: run.id,
        error: commandErrorPayload(normalized),
        result: errorResult(activeRun, normalized),
      });
    } finally {
      clearTimeout(activeRun.timeout);
      if (this.activeRun === activeRun) {
        this.activeRun = null;
      }
    }
  }

  cancel(id) {
    if (!this.activeRun || this.activeRun.id !== id) {
      return;
    }
    this.abortRun(this.activeRun, cancelledError());
  }

  handleStdinChunk(message) {
    const run = this.activeRunForStdin(message);
    if (!run) {
      return;
    }
    try {
      run.stdin.push(stdinChunkFromMessage(message));
    } catch (error) {
      this.failStdin(run, error);
    }
  }

  handleStdinEnd(message) {
    const run = this.activeRunForStdin(message);
    if (!run) {
      return;
    }
    try {
      run.stdin.end();
    } catch (error) {
      this.failStdin(run, error);
    }
  }

  handleStdinError(message) {
    const run = this.activeRunForStdin(message);
    if (!run) {
      return;
    }
    this.failStdin(run, errorFromStdinMessage(message));
  }

  activeRunForStdin(message) {
    if (this.activeRun?.id === message.id) {
      return this.activeRun;
    }
    this.postCommandError(
      message.id,
      new BrowserCommandWorkerError(
        "invalid_request",
        "unknown browser command stdin stream",
        "stdio",
      ),
    );
    return null;
  }

  failStdin(run, error) {
    const normalized = normalizeCommandError(error, "stdio");
    run.stdin.fail(normalized);
    this.abortRun(run, normalized);
  }

  abortRun(run, error) {
    run.abortError = normalizeCommandError(error);
    run.controller.abort(run.abortError);
  }

  async packageForRun(run) {
    const loadRecord = this.packageLoads.get(run.packageId);
    if (loadRecord) {
      await loadRecord.promise;
    }
    const packageRecord = this.packages.get(run.packageId);
    if (!packageRecord) {
      throw new BrowserCommandWorkerError(
        "invalid_request",
        `browser command package is not loaded: ${run.packageId}`,
        "package_load",
      );
    }
    return packageRecord;
  }

  resolveExecutor(type) {
    const executor = this.executors[type];
    if (!executor) {
      throw new BrowserCommandWorkerError(
        "unsupported_package",
        `unsupported browser package type: ${String(type)}`,
        "package_load",
      );
    }
    return executor;
  }

  resolveHttpTransport(name) {
    const transportName = name ?? this.defaultHttpTransport;
    const transport = this.httpTransports[transportName];
    if (!transport) {
      throw new BrowserCommandWorkerError(
        "invalid_request",
        `unknown HTTP bridge transport: ${String(transportName)}`,
        "startup",
      );
    }
    return { name: transportName, transport };
  }

  postCommandError(id, error) {
    const normalized = normalizeCommandError(error);
    postMessageToPort(this.port, {
      type: "command.error",
      id,
      error: commandErrorPayload(normalized),
      result: errorResult(null, normalized),
    });
  }
}

export function createBrowserCommandWorkerRuntime(options = {}) {
  return new BrowserCommandWorkerRuntime(options);
}

export function createSmokeCommandExecutor(options = {}) {
  const marker = options.marker ?? "BROWSER_SMOKE_OK";
  return {
    async run(request, output) {
      if (!request.package.commands.includes(request.command)) {
        throw new BrowserCommandWorkerError(
          "command_not_found",
          `browser command not found: ${request.command}`,
          "command_resolution",
          { exitCode: 127 },
        );
      }
      throwIfAborted(request.signal);
      await output.writeStdout(`${marker}\n`);
      return { exitCode: 0 };
    },
  };
}

class CommandOutputWriter {
  constructor(port, id, activeRun) {
    this.port = port;
    this.id = id;
    this.activeRun = activeRun;
  }

  writeStdout(chunk) {
    this.write("command.stdout", chunk, "stdoutBytes");
  }

  writeStderr(chunk) {
    this.write("command.stderr", chunk, "stderrBytes");
  }

  write(type, chunk, counter) {
    throwIfAborted(this.activeRun.controller.signal);
    const bytes = toUint8Array(chunk, "command output chunks must be bytes");
    this.activeRun[counter] += bytes.length;
    postMessageToPort(this.port, {
      type,
      id: this.id,
      chunk: bytes,
    });
  }
}

class CommandInputStream {
  constructor() {
    this.chunks = [];
    this.waiters = [];
    this.closed = false;
    this.error = null;
  }

  push(chunk) {
    if (this.closed) {
      throw new BrowserCommandWorkerError(
        "invalid_request",
        "browser command stdin is already closed",
        "stdio",
      );
    }
    if (this.error) {
      throw this.error;
    }
    const bytes = toUint8Array(chunk, "command stdin chunks must be bytes");
    if (bytes.length === 0) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(bytes);
      return;
    }
    this.chunks.push(bytes);
  }

  end() {
    if (this.closed) {
      throw new BrowserCommandWorkerError(
        "invalid_request",
        "browser command stdin is already closed",
        "stdio",
      );
    }
    this.closed = true;
    this.resolveWaiters(null);
  }

  fail(error) {
    if (this.error) {
      return;
    }
    this.error = normalizeCommandError(error, "stdio");
    this.rejectWaiters(this.error);
  }

  cancel() {
    this.fail(cancelledError());
  }

  readChunk() {
    if (this.chunks.length > 0) {
      return Promise.resolve(this.chunks.shift());
    }
    if (this.error) {
      return Promise.reject(this.error);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const chunk = await this.readChunk();
      if (chunk == null) {
        return;
      }
      yield chunk;
    }
  }

  resolveWaiters(value) {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.resolve(value);
    }
  }

  rejectWaiters(error) {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }
}

function createActiveRun(id) {
  return {
    id,
    abortError: null,
    controller: new AbortController(),
    stderrBytes: 0,
    stdin: new CommandInputStream(),
    stdoutBytes: 0,
    timeout: null,
  };
}

function normalizePackage(value) {
  if (!value || typeof value !== "object") {
    throw new BrowserCommandWorkerError(
      "invalid_request",
      "browser command package must be an object",
      "package_load",
    );
  }
  const id = nonEmptyString(
    value.id ?? value.packageId ?? DEFAULT_PACKAGE_ID,
    "package_load",
  );
  const type = nonEmptyString(value.type, "package_load");
  const commands = normalizeStringList(
    value.commands ?? [value.command ?? type],
    "package_load",
  );
  return {
    artifactKind: value.artifactKind ?? null,
    cache: value.cache ?? null,
    commands,
    contentSha256: value.contentSha256 ?? null,
    entrypoint: value.entrypoint ?? commands[0],
    id,
    metadata: value.metadata ?? {},
    type,
  };
}

function packageLoadKey(value) {
  return String(value?.id ?? value?.packageId ?? DEFAULT_PACKAGE_ID);
}

function packageNeedsBrowserLoader(value) {
  return (
    value?.bytes != null ||
    value?.url != null ||
    value?.source?.kind === "bytes" ||
    value?.source?.kind === "url"
  );
}

function normalizeRunMessage(message) {
  const run = message.run ?? message;
  const id = nonEmptyString(run.id ?? message.id);
  return {
    args: normalizeStringList(run.args ?? []),
    command: nonEmptyString(run.command),
    cwd: nonEmptyString(run.cwd ?? "/workspace"),
    env: normalizeEnv(run.env ?? {}),
    httpTransport: run.httpTransport ?? message.httpTransport,
    id,
    initialStdin: initialStdinChunks(run),
    packageId: nonEmptyString(run.packageId ?? DEFAULT_PACKAGE_ID),
    stdinOpen: run.stdinOpen === true,
    timeoutMs: normalizeTimeout(run.timeoutMs ?? message.timeoutMs),
  };
}

function normalizeStringList(value, stage = "startup") {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new BrowserCommandWorkerError(
      "invalid_request",
      "browser command lists must be arrays of strings",
      stage,
    );
  }
  return [...value];
}

function normalizeEnv(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserCommandWorkerError(
      "invalid_request",
      "browser command env must be an object",
      "startup",
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, envValue]) => [
      String(key),
      String(envValue),
    ]),
  );
}

function normalizeTimeout(value) {
  if (value == null) {
    return null;
  }
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new BrowserCommandWorkerError(
      "invalid_request",
      "browser command timeoutMs must be positive",
      "startup",
    );
  }
  return timeout;
}

function nonEmptyString(value, stage = "startup") {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new BrowserCommandWorkerError(
      "invalid_request",
      "browser command fields must be non-empty strings",
      stage,
    );
  }
  return text;
}

function initialStdinChunks(run) {
  const fields = [
    run.stdin != null,
    run.stdinBase64 != null,
    run.stdinChunks != null,
    run.stdinChunksBase64 != null,
  ].filter(Boolean).length;
  if (fields > 1) {
    throw new BrowserCommandWorkerError(
      "invalid_request",
      "browser command run must include at most one stdin field",
      "startup",
    );
  }
  if (run.stdin != null) {
    return [toUint8Array(run.stdin, "command stdin chunks must be bytes")];
  }
  if (run.stdinBase64 != null) {
    return [base64ToBytes(run.stdinBase64)];
  }
  if (Array.isArray(run.stdinChunks)) {
    return run.stdinChunks.map((chunk) =>
      toUint8Array(chunk, "command stdin chunks must be bytes"),
    );
  }
  if (Array.isArray(run.stdinChunksBase64)) {
    return run.stdinChunksBase64.map(base64ToBytes);
  }
  return [];
}

function enqueueInitialStdin(stdin, run) {
  for (const chunk of run.initialStdin) {
    stdin.push(chunk);
  }
}

function stdinChunkFromMessage(message) {
  const hasChunk = message.chunk != null;
  const hasChunkBase64 = message.chunkBase64 != null;
  if (hasChunk === hasChunkBase64) {
    throw new BrowserCommandWorkerError(
      "invalid_request",
      "browser command stdin messages must include exactly one chunk",
      "stdio",
    );
  }
  return hasChunk
    ? toUint8Array(message.chunk, "command stdin chunks must be bytes")
    : base64ToBytes(message.chunkBase64);
}

function errorFromStdinMessage(message) {
  const error = message.error ?? {};
  return new BrowserCommandWorkerError(
    typeof error.kind === "string" && error.kind ? error.kind : "transport",
    typeof error.message === "string" && error.message
      ? error.message
      : "browser command stdin producer failed",
    "stdio",
  );
}

async function callExecutor(executor, request, output) {
  if (typeof executor === "function") {
    return executor(request, output);
  }
  if (typeof executor?.run === "function") {
    return executor.run(request, output);
  }
  throw new BrowserCommandWorkerError(
    "invalid_request",
    "browser command executor is not callable",
    "startup",
  );
}

async function callExecutorWithAbort(executor, request, output) {
  const executorPromise = Promise.resolve().then(() =>
    callExecutor(executor, request, output),
  );
  executorPromise.catch(() => {});

  const abort = abortRejection(request.signal);
  try {
    return await Promise.race([executorPromise, abort.promise]);
  } finally {
    abort.cleanup();
  }
}

async function waitForRunAbort(promise, activeRun) {
  const runPromise = Promise.resolve(promise);
  runPromise.catch(() => {});

  const abort = abortRejection(activeRun.controller.signal);
  try {
    return await Promise.race([runPromise, abort.promise]);
  } finally {
    abort.cleanup();
  }
}

function abortRejection(signal) {
  let onAbort = null;
  const promise = new Promise((_resolve, reject) => {
    onAbort = () =>
      reject(normalizeCommandError(signal.reason ?? cancelledError()));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    cleanup() {
      if (onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

function completeResult(activeRun, result = {}) {
  return {
    cancelled: false,
    exitCode: Number(result.exitCode ?? 0),
    failureStage: null,
    stderrBytes: activeRun.stderrBytes,
    stdoutBytes: activeRun.stdoutBytes,
    timedOut: false,
  };
}

function errorResult(activeRun, error) {
  return {
    cancelled: error.cancelled === true,
    exitCode: error.exitCode,
    failureStage: error.stage ?? "runtime",
    stderrBytes: activeRun?.stderrBytes ?? 0,
    stdoutBytes: activeRun?.stdoutBytes ?? 0,
    timedOut: error.timedOut === true,
  };
}

function commandErrorPayload(error) {
  return {
    kind: error.kind,
    message: error.message,
    stage: error.stage ?? "runtime",
  };
}

function normalizeRunError(activeRun, error) {
  if (activeRun.controller.signal.aborted && activeRun.abortError) {
    return activeRun.abortError;
  }
  return normalizeCommandError(error);
}

function normalizeCommandError(error, stage = "runtime") {
  if (error instanceof BrowserCommandWorkerError) {
    return error;
  }
  if (error?.name === "AbortError") {
    return cancelledError();
  }
  if (typeof error?.kind === "string") {
    return new BrowserCommandWorkerError(
      error.kind,
      String(error.message ?? ""),
      error.stage ?? stage,
      {
        cancelled: error.cancelled,
        exitCode: error.exitCode,
        timedOut: error.timedOut,
      },
    );
  }
  return new BrowserCommandWorkerError(
    "runtime",
    error?.message ?? "browser command worker failed",
    stage,
  );
}

function throwIfAborted(signal) {
  if (!signal?.aborted) {
    return;
  }
  throw normalizeCommandError(signal.reason ?? cancelledError());
}

function cancelledError() {
  return new BrowserCommandWorkerError(
    "cancelled",
    "browser command cancelled",
    "runtime",
    { cancelled: true, exitCode: CANCELLED_EXIT_CODE },
  );
}

function timeoutError() {
  return new BrowserCommandWorkerError(
    "timeout",
    "browser command exceeded wall time limit",
    "runtime",
    { exitCode: TIMEOUT_EXIT_CODE, timedOut: true },
  );
}

function postMessageToPort(port, message) {
  if (typeof port.postMessage !== "function") {
    throw new BrowserCommandWorkerError(
      "transport",
      "browser command worker port does not support postMessage",
      "runtime",
    );
  }
  port.postMessage(message);
}

function base64ToBytes(value) {
  if (typeof value !== "string" || !isValidBase64(value)) {
    throw new BrowserCommandWorkerError(
      "invalid_request",
      "invalid browser command stdin base64",
      "startup",
    );
  }
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isValidBase64(value) {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function toUint8Array(value, message) {
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
  throw new BrowserCommandWorkerError("invalid_request", message, "startup");
}
