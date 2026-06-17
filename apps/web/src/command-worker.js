import { HttpBridgeError } from "./http.js";
import {
  createCodexBrowserRequestBuilderExecutor,
  loadCodexBrowserPackage,
  packageNeedsCodexBrowserLoader,
} from "./codex-browser.js";
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
import {
  createWebcWasixExecutor,
  WEBC_PACKAGE_TYPE,
  WEBC_WASIX_EXECUTOR_TYPE,
} from "./webc-wasix.js";
import { createBrowserWorkspaceStore } from "./workspace.js";

const DEFAULT_PACKAGE_ID = "default";
const DEFAULT_HTTP_TRANSPORT = "direct";
const BROWSER_TOOL_FIXTURE_TYPE = "browser-tool-fixture";
const BROWSER_TOOL_INSPECT_COMMAND = "tool-inspect";
const BROWSER_TOOL_DEFAULT_PATH = "/workspace/tools/input.txt";
const BROWSER_TOOL_MODE_ENV = "BROWSER_TOOL_MODE";
const CANCELLED_EXIT_CODE = 130;
const TIMEOUT_EXIT_CODE = 124;
const DEFAULT_COMMAND_PATH = "/bin:/usr/bin";

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
    this.packageLoader =
      options.packageLoader ??
      createBrowserPackageLoader(options.packageLoaderOptions ?? options);
    const webcWasixOptions = {
      ...(options.webcWasix ?? {}),
      cache: options.webcWasix?.cache ?? this.packageLoader.cache,
      rawWasi: options.webcWasix?.rawWasi ?? options.wasiModule,
    };
    const webcWasixExecutor = createWebcWasixExecutor(webcWasixOptions);
    this.executors = options.executors ?? {
      "codex-browser": createCodexBrowserRequestBuilderExecutor(
        options.codexBrowser,
      ),
      [BROWSER_TOOL_FIXTURE_TYPE]: createBrowserToolFixtureExecutor(
        options.browserToolFixture,
      ),
      "http-smoke": createHttpSmokeCommandExecutor(options.httpSmoke),
      smoke: createSmokeCommandExecutor(options.smoke),
      "wasi-module": createRawWasiModuleExecutor(options.wasiModule),
      [WEBC_PACKAGE_TYPE]: webcWasixExecutor,
      [WEBC_WASIX_EXECUTOR_TYPE]: webcWasixExecutor,
    };
    this.packages = new Map();
    this.packageLoads = new Map();
    this.packageCatalog = createPackageCatalog();
    this.workspaceStore =
      options.workspaceStore === undefined
        ? createBrowserWorkspaceStore(options.workspaceStoreOptions ?? {})
        : options.workspaceStore;
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
      case "command.catalog":
        this.postCommandCatalog(message);
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
      case "command.terminal.resize":
        this.handleTerminalResize(message);
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
      this.registerPackage(packageRecord);
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
    if (packageNeedsCodexBrowserLoader(value)) {
      return loadCodexBrowserPackage(value);
    }
    if (packageNeedsRawWasiModuleLoader(value)) {
      return loadRawWasiModulePackage(value);
    }
    if (packageNeedsBrowserLoader(value)) {
      const packageRecord = await this.packageLoader.load(value);
      if (packageNeedsRawWasiModuleLoader(packageRecord)) {
        return loadRawWasiModulePackage(packageRecord);
      }
      if (packageNeedsCodexBrowserLoader(packageRecord)) {
        return loadCodexBrowserPackage(packageRecord);
      }
      return commandPackageFromRecord(packageRecord);
    }
    return normalizePackage(value);
  }

  registerPackage(packageRecord) {
    const packages = new Map(this.packages);
    packages.set(packageRecord.id, packageRecord);
    const catalog = createPackageCatalog([...packages.values()]);
    this.packages = packages;
    this.packageCatalog = catalog;
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

    const activeRun = createActiveRun(run.id, run.terminal);
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
    let command;
    let executor;
    let http;
    try {
      const resolution = await waitForRunAbort(
        this.packageForRun(run),
        activeRun,
      );
      packageRecord = resolution.packageRecord;
      command = resolution.command;
      throwIfAborted(activeRun.controller.signal);
      executor = this.resolveExecutor(packageRecord.type);
      http = this.resolveHttpTransport(run.httpTransport);
    } catch (error) {
      const normalized = normalizeRunError(activeRun, error);
      postOutputStreamClose(this.port, run.id, activeRun);
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
        command,
        args: run.args,
        cwd: run.cwd,
      });
      const output = new CommandOutputWriter(this.port, run.id, activeRun);
      const result = await callExecutorWithAbort(executor, {
        args: run.args,
        command,
        cwd: run.cwd,
        env: run.env,
        httpBridge: new BrowserHttpBridgeClient({
          signal: activeRun.controller.signal,
          transport: http.transport,
          transportName: http.name,
        }),
        httpTransport: http.transport,
        httpTransportName: http.name,
        httpTransports: this.httpTransports,
        package: packageRecord,
        signal: activeRun.controller.signal,
        stdin: activeRun.stdin,
        terminal: activeRun.terminal,
        workspaceStore: this.workspaceStoreForPackage(packageRecord),
      }, output);
      throwIfAborted(activeRun.controller.signal);
      postOutputStreamClose(this.port, run.id, activeRun);
      postMessageToPort(this.port, {
        type: "command.complete",
        id: run.id,
        result: completeResult(activeRun, result),
      });
    } catch (error) {
      const normalized = normalizeRunError(activeRun, error);
      postOutputStreamClose(this.port, run.id, activeRun);
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

  handleTerminalResize(message) {
    const run = this.activeRunForTerminal(message);
    if (!run) {
      return;
    }
    try {
      const resize = terminalResizeFromMessage(message);
      run.terminal.columns = resize.columns;
      run.terminal.rows = resize.rows;
    } catch (error) {
      this.postCommandError(message.id, error);
    }
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

  activeRunForTerminal(message) {
    if (this.activeRun?.id === message.id) {
      return this.activeRun;
    }
    this.postCommandError(
      message.id,
      new BrowserCommandWorkerError(
        "invalid_request",
        "unknown browser command terminal stream",
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
    run.stdin.fail(run.abortError);
  }

  async packageForRun(run) {
    if (run.packageId === null) {
      const entry = this.packageCatalog.resolve(run.command, run.env.PATH);
      const packageRecord = this.packages.get(entry.packageId);
      if (!packageRecord) {
        throw new BrowserCommandWorkerError(
          "invalid_request",
          `browser command package is not loaded: ${entry.packageId}`,
          "package_load",
        );
      }
      return {
        command: entry.command,
        packageRecord,
      };
    }
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
    return { command: run.command, packageRecord };
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

  postCommandCatalog(message) {
    postMessageToPort(this.port, {
      type: "command.catalog",
      id: message.id ?? null,
      defaultPath: DEFAULT_COMMAND_PATH,
      entries: this.packageCatalog.entries(),
    });
  }

  workspaceStoreForPackage(packageRecord) {
    return (
      packageRecord.type === "codex-browser" ||
      packageRecord.type === BROWSER_TOOL_FIXTURE_TYPE
    )
      ? this.workspaceStore
      : undefined;
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

export function createHttpSmokeCommandExecutor(options = {}) {
  const responseBodyLimit = options.responseBodyLimit ?? 1024 * 1024;
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
      if (typeof request.httpBridge?.dispatch !== "function") {
        throw new BrowserCommandWorkerError(
          "unsupported_package",
          "browser HTTP bridge is unavailable",
          "runtime",
        );
      }

      const url = httpSmokeUrl(request, options);
      throwIfAborted(request.signal);
      const response = await request.httpBridge.dispatch({
        method: "GET",
        responseBodyLimit,
        timeoutMs: options.timeoutMs,
        url,
      });
      if (!isSuccessfulHttpStatus(response.status)) {
        throw new BrowserCommandWorkerError(
          "transport",
          `browser HTTP smoke request failed with status ${response.status}`,
          "runtime",
          { exitCode: 1 },
        );
      }
      await output.writeStdout(response.body);
      return { exitCode: 0 };
    },
  };
}

export function createBrowserToolFixtureExecutor(options = {}) {
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
      if (request.command !== BROWSER_TOOL_INSPECT_COMMAND) {
        throw new BrowserCommandWorkerError(
          "command_not_found",
          `unsupported browser tool fixture command: ${request.command}`,
          "command_resolution",
          { exitCode: 127 },
        );
      }
      const workspace = browserToolWorkspaceStore(request, options);
      const path = browserToolPath(request, options);
      throwIfAborted(request.signal);
      const stdin = await readCommandInputText(request.stdin, request.signal);
      let file;
      try {
        file = await workspace.readFile(path);
      } catch (error) {
        throw browserToolWorkspaceError(error);
      }
      const bytes = toUint8Array(
        file,
        "browser tool fixture workspace reads must be bytes",
      );
      throwIfAborted(request.signal);
      const workspaceText = new TextDecoder().decode(bytes);
      const summary = {
        args: request.args,
        command: request.command,
        cwd: request.cwd,
        env: {
          [BROWSER_TOOL_MODE_ENV]: request.env[BROWSER_TOOL_MODE_ENV] ?? null,
        },
        stdin,
        workspace: {
          bytes: bytes.byteLength,
          path,
          text: workspaceText,
        },
      };
      await output.writeStderr("browser-tool-fixture: inspected workspace\n");
      await output.writeStdout(`${JSON.stringify(summary)}\n`);
      return { exitCode: 0, tool: summary };
    },
  };
}

export class BrowserHttpBridgeClient {
  constructor(options = {}) {
    this.signal = options.signal;
    this.transport = options.transport;
    this.transportName = options.transportName ?? DEFAULT_HTTP_TRANSPORT;
  }

  async dispatch(request = {}) {
    if (typeof this.transport?.dispatch !== "function") {
      throw new HttpBridgeError(
        "transport",
        `HTTP bridge transport is not dispatchable: ${String(this.transportName)}`,
      );
    }

    const abort = createHttpBridgeAbortSignal(this.signal, request.timeoutMs);
    const writer = new HttpBridgeResponseCollector();
    try {
      await this.transport.dispatch(
        normalizeHttpBridgeRequest(request),
        writer,
        abort.signal,
      );
      abort.throwIfAborted();
      return writer.result();
    } catch (error) {
      throw normalizeHttpBridgeClientError(error, abort);
    } finally {
      abort.cleanup();
    }
  }
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

class HttpBridgeResponseCollector {
  constructor() {
    this.bodyChunks = [];
    this.complete = null;
  }

  async writeBodyChunk(chunk) {
    this.bodyChunks.push(toUint8Array(chunk, "HTTP bridge body chunks must be bytes"));
  }

  async finish(status, headers, body = new Uint8Array()) {
    if (body != null) {
      const bytes = toUint8Array(body, "HTTP bridge body chunks must be bytes");
      if (bytes.byteLength > 0) {
        this.bodyChunks.push(bytes);
      }
    }
    this.complete = {
      headers: normalizeHttpHeaders(headers ?? []),
      status: Number(status),
    };
  }

  result() {
    if (!this.complete) {
      throw new HttpBridgeError(
        "invalid_response",
        "HTTP bridge transport completed without a response",
      );
    }
    return {
      body: concatBytes(this.bodyChunks),
      bodyChunks: [...this.bodyChunks],
      headers: this.complete.headers,
      status: this.complete.status,
    };
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

function createActiveRun(id, terminal = {}) {
  return {
    id,
    abortError: null,
    controller: new AbortController(),
    stderrBytes: 0,
    stderrClosed: false,
    stdin: new CommandInputStream(),
    terminal: {
      columns: terminal.columns ?? null,
      rows: terminal.rows ?? null,
    },
    stdoutBytes: 0,
    stdoutClosed: false,
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

function createPackageCatalog(packages = []) {
  const entriesByPath = new Map();
  for (const packageRecord of packages) {
    for (const entry of catalogEntriesForPackage(packageRecord)) {
      const existing = entriesByPath.get(entry.path);
      if (existing && !sameCatalogTarget(existing, entry)) {
        throw new BrowserCommandWorkerError(
          "command_catalog_collision",
          `browser command catalog path collision: ${entry.path}`,
          "package_load",
        );
      }
      entriesByPath.set(entry.path, entry);
    }
  }
  return {
    entries() {
      return [...entriesByPath.values()].sort((left, right) =>
        left.path.localeCompare(right.path) ||
        left.packageId.localeCompare(right.packageId) ||
        left.command.localeCompare(right.command),
      );
    },
    resolve(command, pathValue) {
      const paths = catalogLookupPaths(command, pathValue);
      for (const path of paths) {
        const entry = entriesByPath.get(path);
        if (entry) {
          return entry;
        }
      }
      throw new BrowserCommandWorkerError(
        "command_not_found",
        `browser command not found in package catalog: ${String(command ?? "")}`,
        "command_resolution",
        { exitCode: 127 },
      );
    },
  };
}

function catalogEntriesForPackage(packageRecord) {
  const entries = [];
  for (const command of packageRecord.commands ?? []) {
    for (const path of catalogPathsForCommand(command)) {
      entries.push({
        command,
        packageId: packageRecord.id,
        packageType: packageRecord.type,
        path,
      });
    }
  }
  return dedupeCatalogEntries(entries);
}

function catalogPathsForCommand(value) {
  const text = String(value ?? "").trim();
  if (!text || text.includes("\0")) {
    return [];
  }
  if (text.startsWith("/")) {
    const path = normalizeCommandPath(text);
    return path ? [path] : [];
  }
  if (text.includes("/")) {
    return [];
  }
  return commandPathDirs(DEFAULT_COMMAND_PATH).map((dir) => `${dir}/${text}`);
}

function catalogLookupPaths(command, pathValue) {
  const text = nonEmptyString(command, "command_resolution");
  if (text.includes("\0")) {
    throw new BrowserCommandWorkerError(
      "invalid_request",
      "browser command fields must not contain NUL bytes",
      "command_resolution",
    );
  }
  if (text.startsWith("/")) {
    const path = normalizeCommandPath(text);
    return path ? [path] : [];
  }
  if (text.includes("/")) {
    return [];
  }
  const searchPath = pathValue ?? DEFAULT_COMMAND_PATH;
  return commandPathDirs(searchPath, {
    fallbackToDefault: pathValue == null,
  }).map((dir) => `${dir}/${text}`);
}

function commandPathDirs(pathValue, options = {}) {
  const fallbackToDefault = options.fallbackToDefault ?? true;
  const dirs = String(pathValue ?? DEFAULT_COMMAND_PATH)
    .split(":")
    .map(normalizeCommandPath)
    .filter(Boolean);
  if (dirs.length > 0) {
    return dirs;
  }
  return fallbackToDefault
    ? commandPathDirs(DEFAULT_COMMAND_PATH, { fallbackToDefault: false })
    : [];
}

function normalizeCommandPath(value) {
  const text = String(value ?? "").trim();
  if (!text.startsWith("/") || text.includes("\0")) {
    return null;
  }
  const segments = [];
  for (const segment of text.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return null;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? `/${segments.join("/")}` : null;
}

function dedupeCatalogEntries(entries) {
  const keys = new Set();
  const deduped = [];
  for (const entry of entries) {
    const key = `${entry.path}\0${entry.packageId}\0${entry.command}`;
    if (keys.has(key)) {
      continue;
    }
    keys.add(key);
    deduped.push(entry);
  }
  return deduped;
}

function sameCatalogTarget(left, right) {
  return left.packageId === right.packageId && left.command === right.command;
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
    packageId:
      run.packageId === null
        ? null
        : nonEmptyString(run.packageId ?? DEFAULT_PACKAGE_ID),
    stdinOpen: run.stdinOpen === true,
    terminal: normalizeInitialTerminal(run.terminal ?? message.terminal),
    timeoutMs: normalizeTimeout(run.timeoutMs ?? message.timeoutMs),
  };
}

function normalizeInitialTerminal(value) {
  if (value == null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserCommandWorkerError(
      "invalid_request",
      "browser command terminal must be an object",
      "startup",
    );
  }
  const terminal = {};
  if (value.columns != null || value.cols != null) {
    terminal.columns = terminalSizeValue(value.columns ?? value.cols, "columns");
  }
  if (value.rows != null) {
    terminal.rows = terminalSizeValue(value.rows, "rows");
  }
  return terminal;
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

function terminalResizeFromMessage(message) {
  const columns = terminalSizeValue(message.columns ?? message.cols, "columns");
  const rows = terminalSizeValue(message.rows, "rows");
  return { columns, rows };
}

function terminalSizeValue(value, field) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new BrowserCommandWorkerError(
      "invalid_request",
      `browser terminal ${field} must be a positive integer`,
      "stdio",
    );
  }
  return size;
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

function createHttpBridgeAbortSignal(commandSignal, timeoutMs) {
  const controller = new AbortController();
  let reason = null;
  const cleanupHandlers = [];
  const abort = (nextReason) => {
    if (!controller.signal.aborted) {
      reason = nextReason;
      controller.abort(nextReason);
    }
  };

  if (commandSignal) {
    if (commandSignal.aborted) {
      abort(commandSignal.reason ?? cancelledError());
    } else {
      const onAbort = () => abort(commandSignal.reason ?? cancelledError());
      commandSignal.addEventListener("abort", onAbort, { once: true });
      cleanupHandlers.push(() =>
        commandSignal.removeEventListener("abort", onAbort),
      );
    }
  }

  if (timeoutMs != null) {
    const timeout = Number(timeoutMs);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new HttpBridgeError(
        "invalid_request",
        "HTTP bridge request timeoutMs must be positive",
      );
    }
    const timer = setTimeout(() => abort(httpBridgeTimeoutError()), timeout);
    cleanupHandlers.push(() => clearTimeout(timer));
  }

  return {
    get reason() {
      return reason;
    },
    signal: controller.signal,
    cleanup() {
      for (const cleanup of cleanupHandlers.splice(0)) {
        cleanup();
      }
    },
    throwIfAborted() {
      if (!controller.signal.aborted) {
        return;
      }
      throw reason ?? new HttpBridgeError("cancelled", "HTTP request cancelled");
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

function httpSmokeUrl(request, options) {
  const value =
    request.args.find((arg) => String(arg ?? "").trim()) ??
    request.env.WASM_HOST_HTTP_SMOKE_URL ??
    options.url;
  const url = String(value ?? "").trim();
  if (!url) {
    throw new BrowserCommandWorkerError(
      "invalid_request",
      "browser HTTP smoke URL is required",
      "runtime",
    );
  }
  return url;
}

function browserToolWorkspaceStore(request, options) {
  const store = request.workspaceStore ?? options.workspaceStore;
  if (typeof store?.readFile !== "function") {
    throw new BrowserCommandWorkerError(
      "unsupported_package",
      "browser tool fixture requires a workspace store",
      "startup",
    );
  }
  return store;
}

function browserToolPath(request, options) {
  return nonEmptyString(
    request.args[0] ??
      request.env.BROWSER_TOOL_PATH ??
      options.path ??
      BROWSER_TOOL_DEFAULT_PATH,
    "startup",
  );
}

async function readCommandInputText(stdin, signal) {
  const chunks = [];
  for await (const chunk of stdin) {
    throwIfAborted(signal);
    chunks.push(toUint8Array(chunk, "command stdin chunks must be bytes"));
  }
  throwIfAborted(signal);
  return new TextDecoder().decode(concatBytes(chunks));
}

function browserToolWorkspaceError(error) {
  if (typeof error?.kind === "string") {
    return new BrowserCommandWorkerError(
      error.kind,
      `browser tool fixture workspace read failed: ${error.message}`,
      error.stage ?? "workspace",
      { exitCode: 1 },
    );
  }
  return error;
}

function isSuccessfulHttpStatus(status) {
  return Number.isInteger(status) && status >= 200 && status <= 299;
}

function httpBridgeTimeoutError() {
  return new HttpBridgeError("timeout", "HTTP request exceeded wall time limit");
}

function normalizeHttpBridgeRequest(request) {
  if (!request || typeof request !== "object") {
    throw new HttpBridgeError("invalid_request", "HTTP bridge request is required");
  }
  return {
    body: normalizeHttpBridgeRequestBody(request),
    gatewayResponseLimit: request.gatewayResponseLimit,
    headers: normalizeHttpHeaders(request.headers ?? [], "invalid_request"),
    id: request.id,
    method: nonEmptyHttpString(request.method, "HTTP bridge method is required"),
    responseBodyLimit: request.responseBodyLimit,
    timeoutMs: request.timeoutMs,
    url: nonEmptyHttpString(request.url, "HTTP bridge URL is required"),
  };
}

function normalizeHttpBridgeRequestBody(request) {
  const fields = [
    request.body != null,
    request.bodyBase64 != null,
    request.bodyChunks != null,
    request.bodyChunksBase64 != null,
  ].filter(Boolean).length;
  if (fields > 1) {
    throw new HttpBridgeError(
      "invalid_request",
      "HTTP bridge request must include at most one body field",
    );
  }
  if (request.body != null) {
    return toUint8Array(request.body, "HTTP bridge body chunks must be bytes");
  }
  if (request.bodyBase64 != null) {
    return httpBase64ToBytes(request.bodyBase64);
  }
  if (Array.isArray(request.bodyChunks)) {
    return request.bodyChunks.map((chunk) =>
      toUint8Array(chunk, "HTTP bridge body chunks must be bytes"),
    );
  }
  if (Array.isArray(request.bodyChunksBase64)) {
    return request.bodyChunksBase64.map(httpBase64ToBytes);
  }
  return null;
}

function normalizeHttpBridgeClientError(error, abort) {
  if (abort.reason?.kind === "timeout") {
    return httpBridgeTimeoutError();
  }
  if (abort.reason?.kind === "cancelled" || error?.name === "AbortError") {
    return new HttpBridgeError("cancelled", "HTTP request cancelled");
  }
  if (error instanceof HttpBridgeError) {
    return error;
  }
  if (typeof error?.kind === "string") {
    return new HttpBridgeError(error.kind, String(error.message ?? ""));
  }
  return new HttpBridgeError(
    "transport",
    error?.message ?? "HTTP bridge transport failed",
  );
}

function postOutputStreamClose(port, id, activeRun) {
  if (!activeRun.stdoutClosed) {
    activeRun.stdoutClosed = true;
    postMessageToPort(port, { type: "command.stdout.close", id });
  }
  if (!activeRun.stderrClosed) {
    activeRun.stderrClosed = true;
    postMessageToPort(port, { type: "command.stderr.close", id });
  }
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

function normalizeHttpHeaders(headers, kind = "invalid_response") {
  if (!Array.isArray(headers)) {
    throw new HttpBridgeError(
      kind,
      "HTTP bridge headers must be an array",
    );
  }
  return headers.map((header) => {
    const name = String(header?.name ?? "").trim().toLowerCase();
    const value = String(header?.value ?? "").trim();
    if (!name) {
      throw new HttpBridgeError(
        kind,
        "HTTP bridge header names must be non-empty",
      );
    }
    return { name, value };
  });
}

function nonEmptyHttpString(value, message) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new HttpBridgeError("invalid_request", message);
  }
  return text;
}

function httpBase64ToBytes(value) {
  if (typeof value !== "string" || !isValidBase64(value)) {
    throw new HttpBridgeError("invalid_request", "invalid HTTP body base64");
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

function concatBytes(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
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
