import {
  createMemoryBrowserWorkspaceStore,
  normalizeWorkspacePath,
} from "./workspace.js";

const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
const DEFAULT_PACKAGE_ID = "default";
const DEFAULT_ENTRYPOINT = "_start";
const RAW_WASI_ARTIFACT_KIND = "wasi-module";
const ENV_IMPORT_MODULE = "env";
const MEMORY_IMPORT_NAME = "memory";
const WASM_PAGE_SIZE = 65_536;
const WASI_IMPORT_MODULE = "wasi_snapshot_preview1";
const WASI_THREAD_IMPORT_MODULE = "wasi";
const WASI_THREAD_SPAWN_IMPORT = "thread-spawn";
const WASIX_IMPORT_MODULE = "wasix_32v1";
const DEFAULT_WASIX_PROC_SEARCH_PATH = "/usr/local/bin:/bin:/usr/bin";
const WASM_IMPORT_SECTION_ID = 2;
const WASM_IMPORT_KIND_FUNCTION = 0;
const WASM_IMPORT_KIND_TABLE = 1;
const WASM_IMPORT_KIND_MEMORY = 2;
const WASM_IMPORT_KIND_GLOBAL = 3;
const WASM_IMPORT_KIND_TAG = 4;
const WASM_LIMITS_HAS_MAXIMUM = 1 << 0;
const WASM_LIMITS_SHARED = 1 << 1;
const WASM_LIMITS_MEMORY64 = 1 << 2;

const ERRNO_SUCCESS = 0;
const ERRNO_ACCESS = 2;
const ERRNO_AGAIN = 6;
const ERRNO_BADF = 8;
const ERRNO_CHILD = 12;
const ERRNO_EXIST = 20;
const ERRNO_FAULT = 21;
const ERRNO_INVAL = 28;
const ERRNO_ISDIR = 31;
const ERRNO_NOENT = 44;
const ERRNO_NOTDIR = 54;
const ERRNO_NOTEMPTY = 55;
const ERRNO_NOTSUP = 58;
const ERRNO_OVERFLOW = 61;
const ERRNO_PIPE = 64;
const ERRNO_RANGE = 68;
const ERRNO_NOTCAPABLE = 76;
const STDIN_FD = 0;
const STDOUT_FD = 1;
const STDERR_FD = 2;
const WORKSPACE_FD = 3;
const TMP_FD = 4;
const FIRST_FILE_FD = 5;
const PACKAGE_ROOT_PREOPEN_PATH = "/";
const WASI_CLOCK_REALTIME = 0;
const WASI_CLOCK_MONOTONIC = 1;
const WASI_EVENTTYPE_CLOCK = 0;
const WASI_EVENTTYPE_FD_READ = 1;
const WASI_EVENTTYPE_FD_WRITE = 2;
const WASI_SUBSCRIPTION_SIZE = 48;
const WASI_SUBSCRIPTION_USERDATA_OFFSET = 0;
const WASI_SUBSCRIPTION_TYPE_OFFSET = 8;
const WASI_SUBSCRIPTION_CLOCK_ID_OFFSET = 16;
const WASI_SUBSCRIPTION_CLOCK_FLAGS_OFFSET = 40;
const WASI_SUBSCRIPTION_FD_OFFSET = 16;
const WASI_SUBSCRIPTION_CLOCK_ABSTIME = 1;
const WASI_EVENT_SIZE = 32;
const WASI_EVENT_USERDATA_OFFSET = 0;
const WASI_EVENT_ERROR_OFFSET = 8;
const WASI_EVENT_TYPE_OFFSET = 10;
const WASI_EVENT_FD_NBYTES_OFFSET = 16;
const WASI_EVENT_FD_FLAGS_OFFSET = 24;
const WASI_EVENT_FD_READWRITE_HANGUP = 1;
const WASI_FILETYPE_CHARACTER_DEVICE = 2;
const WASI_FILETYPE_DIRECTORY = 3;
const WASI_FILETYPE_REGULAR_FILE = 4;
const WASI_DIRENT_SIZE = 24;
const WASI_PREOPENTYPE_DIR = 0;
const WASI_OFLAGS_CREAT = 1 << 0;
const WASI_OFLAGS_DIRECTORY = 1 << 1;
const WASI_OFLAGS_EXCL = 1 << 2;
const WASI_OFLAGS_TRUNC = 1 << 3;
const WASI_LOOKUP_SYMLINK_FOLLOW = 1 << 0;
const WASI_FDFLAGS_APPEND = 1 << 0;
const WASIX_FDFLAGSEXT_CLOEXEC = 1 << 0;
const WASIX_FDFLAGSEXT_MASK = WASIX_FDFLAGSEXT_CLOEXEC;
const WASI_WHENCE_SET = 0;
const WASI_WHENCE_CUR = 1;
const WASI_WHENCE_END = 2;
const WASI_FSTFLAGS_ATIM = 1 << 0;
const WASI_FSTFLAGS_ATIM_NOW = 1 << 1;
const WASI_FSTFLAGS_MTIM = 1 << 2;
const WASI_FSTFLAGS_MTIM_NOW = 1 << 3;
const WASI_FSTFLAGS_MASK =
  WASI_FSTFLAGS_ATIM |
  WASI_FSTFLAGS_ATIM_NOW |
  WASI_FSTFLAGS_MTIM |
  WASI_FSTFLAGS_MTIM_NOW;
const WASI_RIGHT_FD_DATASYNC = 1n << 0n;
const WASI_RIGHT_FD_READ = 1n << 1n;
const WASI_RIGHT_FD_SEEK = 1n << 2n;
const WASI_RIGHT_FD_FDSTAT_SET_FLAGS = 1n << 3n;
const WASI_RIGHT_FD_SYNC = 1n << 4n;
const WASI_RIGHT_FD_TELL = 1n << 5n;
const WASI_RIGHT_FD_WRITE = 1n << 6n;
const WASI_RIGHT_FD_ADVISE = 1n << 7n;
const WASI_RIGHT_FD_ALLOCATE = 1n << 8n;
const WASI_RIGHT_PATH_CREATE_DIRECTORY = 1n << 9n;
const WASI_RIGHT_PATH_CREATE_FILE = 1n << 10n;
const WASI_RIGHT_PATH_OPEN = 1n << 13n;
const WASI_RIGHT_FD_READDIR = 1n << 14n;
const WASI_RIGHT_PATH_RENAME_SOURCE = 1n << 16n;
const WASI_RIGHT_PATH_RENAME_TARGET = 1n << 17n;
const WASI_RIGHT_PATH_FILESTAT_GET = 1n << 18n;
const WASI_RIGHT_PATH_FILESTAT_SET_SIZE = 1n << 19n;
const WASI_RIGHT_PATH_FILESTAT_SET_TIMES = 1n << 20n;
const WASI_RIGHT_FD_FILESTAT_GET = 1n << 21n;
const WASI_RIGHT_FD_FILESTAT_SET_SIZE = 1n << 22n;
const WASI_RIGHT_FD_FILESTAT_SET_TIMES = 1n << 23n;
const WASI_RIGHT_PATH_REMOVE_DIRECTORY = 1n << 25n;
const WASI_RIGHT_PATH_UNLINK_FILE = 1n << 26n;
const WASI_STDIN_RIGHTS =
  WASI_RIGHT_FD_READ | WASI_RIGHT_FD_FDSTAT_SET_FLAGS;
const WASI_STDOUT_RIGHTS =
  WASI_RIGHT_FD_WRITE | WASI_RIGHT_FD_FDSTAT_SET_FLAGS;
const WASI_WORKSPACE_RIGHTS =
  WASI_RIGHT_FD_READDIR |
  WASI_RIGHT_PATH_OPEN |
  WASI_RIGHT_PATH_FILESTAT_GET |
  WASI_RIGHT_FD_FILESTAT_GET;
const WASI_TMP_RIGHTS =
  WASI_RIGHT_FD_READDIR |
  WASI_RIGHT_PATH_OPEN |
  WASI_RIGHT_PATH_FILESTAT_GET |
  WASI_RIGHT_PATH_FILESTAT_SET_TIMES |
  WASI_RIGHT_PATH_CREATE_FILE |
  WASI_RIGHT_PATH_CREATE_DIRECTORY |
  WASI_RIGHT_PATH_UNLINK_FILE |
  WASI_RIGHT_PATH_REMOVE_DIRECTORY |
  WASI_RIGHT_PATH_RENAME_SOURCE |
  WASI_RIGHT_PATH_RENAME_TARGET |
  WASI_RIGHT_FD_FILESTAT_GET;
const WASI_REGULAR_FILE_RIGHTS =
  WASI_RIGHT_FD_READ |
  WASI_RIGHT_FD_SEEK |
  WASI_RIGHT_FD_FDSTAT_SET_FLAGS |
  WASI_RIGHT_FD_TELL |
  WASI_RIGHT_FD_ADVISE |
  WASI_RIGHT_FD_FILESTAT_GET;
const WASI_SCRATCH_FILE_RIGHTS =
  WASI_REGULAR_FILE_RIGHTS |
  WASI_RIGHT_FD_WRITE |
  WASI_RIGHT_FD_DATASYNC |
  WASI_RIGHT_FD_SYNC |
  WASI_RIGHT_FD_ALLOCATE |
  WASI_RIGHT_FD_FILESTAT_SET_SIZE |
  WASI_RIGHT_FD_FILESTAT_SET_TIMES;
const WASI_WRITABLE_WORKSPACE_RIGHTS =
  WASI_WORKSPACE_RIGHTS |
  WASI_RIGHT_PATH_FILESTAT_SET_TIMES |
  WASI_RIGHT_PATH_CREATE_FILE |
  WASI_RIGHT_PATH_CREATE_DIRECTORY |
  WASI_RIGHT_PATH_UNLINK_FILE |
  WASI_RIGHT_PATH_REMOVE_DIRECTORY |
  WASI_RIGHT_PATH_RENAME_SOURCE |
  WASI_RIGHT_PATH_RENAME_TARGET;
const WASI_WRITE_RIGHTS =
  WASI_RIGHT_FD_DATASYNC |
  WASI_RIGHT_FD_SYNC |
  WASI_RIGHT_FD_WRITE |
  WASI_RIGHT_FD_ALLOCATE |
  WASI_RIGHT_PATH_CREATE_DIRECTORY |
  WASI_RIGHT_PATH_CREATE_FILE |
  WASI_RIGHT_PATH_FILESTAT_SET_SIZE |
  WASI_RIGHT_PATH_FILESTAT_SET_TIMES |
  WASI_RIGHT_PATH_RENAME_SOURCE |
  WASI_RIGHT_PATH_RENAME_TARGET |
  WASI_RIGHT_FD_FILESTAT_SET_SIZE |
  WASI_RIGHT_FD_FILESTAT_SET_TIMES |
  WASI_RIGHT_PATH_REMOVE_DIRECTORY |
  WASI_RIGHT_PATH_UNLINK_FILE;
const WASI_PIPE_BASE_RIGHTS =
  WASI_RIGHT_FD_FDSTAT_SET_FLAGS | WASI_RIGHT_FD_FILESTAT_GET;
const WASI_PIPE_READ_RIGHTS = WASI_PIPE_BASE_RIGHTS | WASI_RIGHT_FD_READ;
const WASI_PIPE_WRITE_RIGHTS = WASI_PIPE_BASE_RIGHTS | WASI_RIGHT_FD_WRITE;
const WORKSPACE_PREOPEN_PATH = "/workspace";
const TMP_PREOPEN_PATH = "/tmp";
const NANOS_PER_MILLI = 1_000_000n;
const CLOCK_RESOLUTION_NANOS = NANOS_PER_MILLI;
const WASI_ADVICE_NOREUSE = 5;
const RANDOM_GET_CHUNK_SIZE = 65_536;
const PIPE_BUFFER_LIMIT = 1024 * 1024;
const WASIX_STACK_SNAPSHOT_SIZE = 24;
const WASIX_OPTION_PID_SIZE = 8;
const WASIX_JOIN_STATUS_SIZE = 8;
const WASIX_OPTION_TAG_NONE = 0;
const WASIX_OPTION_TAG_SOME = 1;
const WASIX_JOIN_STATUS_NOTHING = 0;
const WASIX_JOIN_STATUS_EXIT_NORMAL = 1;
const WASIX_PROC_JOIN_NON_BLOCKING = 1 << 0;
const WASIX_ROOT_PID = 1;
const WASIX_ROOT_PARENT_PID = 0;
const WASIX_ASYNCIFY_FALLBACK_BUFFER_SIZE = 4 * 1024 * 1024;
const WASIX_ASYNCIFY_FALLBACK_MIN_MEMORY_SIZE = 8 * 1024 * 1024;
const WASIX_ASYNCIFY_EXPORTS = [
  "asyncify_get_state",
  "asyncify_start_rewind",
  "asyncify_start_unwind",
  "asyncify_stop_rewind",
  "asyncify_stop_unwind",
];
const WASIX_ASYNCIFY_STATE_NORMAL = 0;
const WASIX_ASYNCIFY_STATE_UNWINDING = 1;
const WASIX_CONTINUATION_MAX_TURNS = 64;
const WASIX_UNSUPPORTED_NETWORK_IMPORTS = [
  "port_addr_add",
  "port_addr_clear",
  "port_addr_list",
  "port_addr_remove",
  "port_bridge",
  "port_dhcp_acquire",
  "port_gateway_set",
  "port_mac",
  "port_route_add",
  "port_route_clear",
  "port_route_list",
  "port_route_remove",
  "port_unbridge",
  "resolve",
  "sock_accept_v2",
  "sock_addr_local",
  "sock_addr_peer",
  "sock_bind",
  "sock_connect",
  "sock_get_opt_flag",
  "sock_get_opt_size",
  "sock_get_opt_time",
  "sock_join_multicast_v4",
  "sock_join_multicast_v6",
  "sock_leave_multicast_v4",
  "sock_leave_multicast_v6",
  "sock_listen",
  "sock_open",
  "sock_pair",
  "sock_recv_from",
  "sock_send_file",
  "sock_send_to",
  "sock_set_opt_flag",
  "sock_set_opt_size",
  "sock_set_opt_time",
  "sock_status",
];
const WASIX_UNSUPPORTED_THREAD_EVENT_IMPORTS = [
  "context_create",
  "context_destroy",
  "context_switch",
  "epoll_create",
  "epoll_ctl",
  "epoll_wait",
  "fd_event",
  "futex_wait",
  "futex_wake",
  "futex_wake_all",
  "thread_join",
  "thread_local_create",
  "thread_local_destroy",
  "thread_local_get",
  "thread_local_set",
  "thread_signal",
  "thread_spawn",
  "thread_spawn_v2",
];
const WASIX_UNSUPPORTED_THREAD_EXIT_IMPORTS = ["thread_exit"];
const WASIX_UNSUPPORTED_CLOCK_IMPORTS = ["clock_time_set"];
const WASIX_UNSUPPORTED_DYNAMIC_IMPORTS = [
  "call_dynamic",
  "closure_allocate",
  "closure_free",
  "closure_prepare",
  "dl_invalid_handle",
  "dlopen",
  "dlsym",
  "reflect_signature",
];
const WASIX_UNSUPPORTED_PROCESS_IMPORTS = [
  "process_spawn",
  "proc_fork_env",
  "proc_raise_interval",
  "proc_spawn2",
];
const WASIX_TTY_STATE_SIZE = 24;
const WASIX_TTY_COLS_OFFSET = 0;
const WASIX_TTY_ROWS_OFFSET = 4;
const WASIX_TTY_WIDTH_OFFSET = 8;
const WASIX_TTY_HEIGHT_OFFSET = 12;
const WASIX_TTY_STDIN_OFFSET = 16;
const WASIX_TTY_STDOUT_OFFSET = 17;
const WASIX_TTY_STDERR_OFFSET = 18;
const WASIX_TTY_ECHO_OFFSET = 19;
const WASIX_TTY_LINE_BUFFERED_OFFSET = 20;
const DEFAULT_WASIX_TTY_STATE = Object.freeze({
  cols: 80,
  rows: 25,
  width: 800,
  height: 600,
  stdinTty: false,
  stdoutTty: false,
  stderrTty: false,
  echo: false,
  lineBuffered: false,
});
let workerRunCounter = 0;
let workerChildRunCounter = 0;
const workerChildCommandRuns = new Map();

export class BrowserWasiModuleError extends Error {
  constructor(kind, message, stage = "runtime", options = {}) {
    super(message);
    this.name = "BrowserWasiModuleError";
    this.kind = kind;
    this.stage = stage;
    this.exitCode = options.exitCode ?? null;
    this.cancelled = options.cancelled === true;
    this.timedOut = options.timedOut === true;
    this.diagnostics = normalizeRawWasiResultDiagnostics(options.diagnostics);
  }
}

export async function loadRawWasiModulePackage(input = {}) {
  const bytes = toUint8Array(rawWasiBytes(input));
  validateWasmMagic(bytes);
  const sha256 = await sha256Hex(bytes);
  verifyExpectedSha256(
    input.wasiModule?.expectedSha256 ??
      input.expectedSha256 ??
      input.artifactSha256 ??
      input.metadata?.artifactSha256,
    sha256,
  );

  const commands = normalizeCommands(input);
  const defaultCommand = normalizeDefaultCommand(input, commands);
  const entrypoint = nonEmptyString(input.entrypoint ?? DEFAULT_ENTRYPOINT);
  const id = nonEmptyString(input.id ?? input.packageId ?? DEFAULT_PACKAGE_ID);
  const files = normalizeWasiFiles(input.files ?? input.wasiModule?.files);
  const rootFiles = normalizeWasiFiles(
    input.rootFiles ?? input.packageRootFiles ?? input.wasiModule?.rootFiles,
  );
  const source = normalizeSource(input.source);
  const byteLength = bytes.byteLength;

  return {
    artifactKind: RAW_WASI_ARTIFACT_KIND,
    byteLength,
    bytes,
    cache: input.cache ?? null,
    commands,
    contentSha256: sha256,
    defaultCommand,
    entrypoint,
    files,
    id,
    metadata: {
      ...(input.metadata ?? {}),
      artifactKind: RAW_WASI_ARTIFACT_KIND,
      byteLength,
      defaultCommand,
      entrypoint,
      fileCount: files.length,
      rootFileCount: rootFiles.length,
      sha256,
      source,
      wasi: "preview1",
    },
    rootFiles,
    sha256,
    source,
    type: RAW_WASI_ARTIFACT_KIND,
  };
}

export function packageNeedsRawWasiModuleLoader(value) {
  return isRawWasiModulePackage(value) && rawWasiBytes(value) != null;
}

export function createRawWasiModuleExecutor(options = {}) {
  const createWorker =
    options.createWorker ?? defaultRawWasiModuleWorkerFactory();
  if (
    options.worker !== false &&
    !options.workspaceStore &&
    typeof createWorker === "function"
  ) {
    return createRawWasiModuleWorkerExecutor({
      ...options,
      createWorker,
    });
  }
  return {
    async run(request, output) {
      return runRawWasiModule(request, output, options);
    },
  };
}

export function createRawWasiModuleWorkerExecutor(options = {}) {
  return {
    async run(request, output) {
      return runRawWasiModuleInWorker(request, output, options);
    },
  };
}

export async function runRawWasiModule(request, output, options = {}) {
  const packageRecord = request.package;
  if (!packageRecord?.commands?.includes(request.command)) {
    throw new BrowserWasiModuleError(
      "command_not_found",
      `browser command not found: ${request.command}`,
      "command_resolution",
      { exitCode: 127 },
    );
  }
  const bytes = toUint8Array(packageRecord.bytes);
  validateWasmMagic(bytes);
  if (typeof globalThis.WebAssembly?.instantiate !== "function") {
    throw new BrowserWasiModuleError(
      "unsupported",
      "WebAssembly.instantiate is unavailable for raw WASI modules",
    );
  }

  const stdin = request.stdinBytes
    ? toUint8Array(request.stdinBytes)
    : await readAllCommandStdin(request.stdin, request.signal);
  const workspace = await createWasiWorkspaceMount({
    files: packageRecord.files,
    rootFiles: packageRecord.rootFiles,
    workspaceSnapshot: request.workspaceSnapshot ?? options.workspaceSnapshot,
    workspaceStore: request.workspaceStore ?? options.workspaceStore,
  });
  let instance = null;
  let wasi = null;
  wasi = new WasiPreview1Runtime({
    args: [request.command, ...request.args],
    childCommands: request.childCommands,
    copyForkRunner: (fork) =>
      runCopiedForkChild({
        bytes,
        entrypoint:
          packageRecord.entrypoint ??
          packageRecord.metadata?.entrypoint ??
          DEFAULT_ENTRYPOINT,
        fork,
        output,
        parentWasi: wasi,
        request,
        workspace,
      }),
    cwd: request.cwd,
    diagnostics: request.diagnostics ?? options.diagnostics,
    env: request.env,
    getInstance: () => instance,
    output,
    signal: request.signal,
    stdin,
    workspace,
  });

  try {
    instance = await instantiateRawWasiInstance(
      bytes,
      wasi,
      (instantiated) => {
        instance = instantiated;
      },
    );
    const entrypoint =
      packageRecord.entrypoint ?? packageRecord.metadata?.entrypoint ?? DEFAULT_ENTRYPOINT;
    const start = instance.exports?.[entrypoint];
    if (typeof start !== "function") {
      throw new BrowserWasiModuleError(
        "invalid_package",
        `raw WASI module entrypoint not found: ${String(entrypoint)}`,
        "package_load",
      );
    }
    while (true) {
      try {
        throwIfAborted(request.signal);
        await runWasiEntrypoint(start, wasi, request.signal);
        throwIfAborted(request.signal);
        return await workspaceResult(wasi.result({ exitCode: 0 }), workspace);
      } catch (error) {
        if (error instanceof WasixProcExec && wasi.hasActiveVforkChild()) {
          const result = await wasi.runProcessExec(error.request);
          wasi.completeActiveVforkChild(result.exitCode);
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof WasiProcExit) {
      return await workspaceResult(
        wasi.result({ exitCode: error.exitCode }),
        workspace,
      );
    }
    if (error instanceof WasixProcExec) {
      const result = await wasi.runProcessExec(error.request);
      return await workspaceResult(wasi.result(result), workspace);
    }
    if (error instanceof BrowserWasiModuleError) {
      error.diagnostics ??= wasi.resultDiagnostics();
      throw error;
    }
    throw new BrowserWasiModuleError(
      "runtime",
      error?.message ?? "raw WASI module execution failed",
      "runtime",
      { diagnostics: wasi.resultDiagnostics() },
    );
  }
}

async function instantiateRawWasiInstance(
  bytes,
  wasi,
  setInstance,
  memorySnapshot = null,
) {
  const importedMemory = createImportedMemory(bytes);
  if (importedMemory) {
    if (memorySnapshot) {
      copyMemorySnapshotTo(importedMemory.memory, memorySnapshot);
    }
    wasi.setMemory(importedMemory.memory);
  }
  const importObject = wasi.importObject();
  if (importedMemory) {
    attachImportedMemory(importObject, importedMemory);
  }
  const instantiated = await globalThis.WebAssembly.instantiate(
    bytes,
    importObject,
  );
  const instance = instantiated.instance ?? instantiated;
  setInstance(instance);
  const memory = importedMemory?.memory ?? exportedMemory(instance);
  if (!importedMemory && memorySnapshot) {
    copyMemorySnapshotTo(memory, memorySnapshot);
  }
  wasi.setMemory(memory);
  wasi.setContinuationCapabilities(
    wasixContinuationCapabilities(instance, memory),
  );
  return instance;
}

async function runCopiedForkChild({
  bytes,
  entrypoint,
  fork,
  output,
  parentWasi,
  request,
  workspace,
}) {
  let childInstance = null;
  const childWasi = new WasiPreview1Runtime({
    args: parentWasi.args,
    childCommands: request.childCommands,
    cwd: parentWasi.cwd,
    diagnostics: parentWasi.diagnostics,
    env: parentWasi.envObject,
    getInstance: () => childInstance,
    output,
    signal: request.signal,
    stdin: parentWasi.remainingStdinBytes(),
    workspace,
  });
  childWasi.processes.set(fork.childPid, {
    exitCode: null,
    parentPid: fork.parentPid,
    pid: fork.childPid,
    state: "running",
  });
  childWasi.currentProcessId = fork.childPid;
  childInstance = await instantiateRawWasiInstance(
    bytes,
    childWasi,
    (instantiated) => {
      childInstance = instantiated;
    },
    fork.memorySnapshot,
  );
  restoreExportedMutableGlobals(childInstance, fork.globals);
  const start = childInstance.exports?.[entrypoint];
  if (typeof start !== "function") {
    throw new BrowserWasiModuleError(
      "invalid_package",
      `raw WASI module entrypoint not found: ${String(entrypoint)}`,
      "package_load",
    );
  }
  childWasi.beginForkRewind(
    fork.record,
    0,
    ERRNO_SUCCESS,
    fork.childPid,
  );
  try {
    await runWasiEntrypoint(start, childWasi, request.signal);
    return childWasi.result({ exitCode: 0 });
  } catch (error) {
    if (error instanceof WasiProcExit) {
      return childWasi.result({ exitCode: error.exitCode });
    }
    if (error instanceof WasixProcExec) {
      const result = await childWasi.runProcessExec(error.request);
      return childWasi.result(result);
    }
    throw error;
  }
}

async function runWasiEntrypoint(start, wasi, signal) {
  for (let turn = 0; turn < WASIX_CONTINUATION_MAX_TURNS; turn += 1) {
    throwIfAborted(signal);
    start();
    throwIfAborted(signal);
    if (!(await wasi.finishContinuationTurn())) {
      return;
    }
  }
  throw new BrowserWasiModuleError(
    "runtime",
    "WASIX continuation loop exceeded the browser turn limit",
    "runtime",
    { exitCode: 126 },
  );
}

export async function runRawWasiModuleInWorker(request, output, options = {}) {
  if (options.workspaceStore) {
    throw new BrowserWasiModuleError(
      "unsupported",
      "raw WASI workspaceStore cannot be sent to a worker; use worker: false or a workspaceSnapshot",
      "runtime",
    );
  }
  const workerRequest = await workerRunRequest({
    ...request,
    workspaceSnapshot: request.workspaceSnapshot ?? options.workspaceSnapshot,
  });
  let worker;
  try {
    worker = options.createWorker?.();
  } catch (error) {
    throw new BrowserWasiModuleError(
      "unsupported",
      error?.message ?? "raw WASI execution worker could not start",
      "runtime",
    );
  }
  validateExecutionWorker(worker);
  const id = options.id ?? `raw-wasi-run-${nextWorkerRunId()}`;
  const runMessage = {
    type: "wasi.run",
    id,
    request: workerRequest,
  };

  let settled = false;
  let outputChain = Promise.resolve();
  const pendingChildRequests = new Map();
  const enqueueOutput = (write) => {
    outputChain = outputChain.then(write);
    outputChain.catch(() => {});
  };

  return new Promise((resolve, reject) => {
    const finish = (complete) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      outputChain.then(complete, reject);
    };
    const rejectWith = (error) => finish(() => reject(error));
    const resolveWith = (result) => finish(() => resolve(result));
    const postChildReply = (message) => {
      if (!settled) {
        postMessageToChildCommandWorker(worker, message);
      }
    };
    const handleChildRun = (message) => {
      const childId = String(message.childId ?? "");
      if (!childId) {
        return;
      }
      if (pendingChildRequests.has(childId)) {
        postChildReply({
          type: "wasi.child.error",
          id,
          childId,
          error: workerErrorPayload(
            new BrowserWasiModuleError(
              "invalid_request",
              `raw WASI worker child command is already pending: ${childId}`,
              "runtime",
            ),
          ),
        });
        return;
      }
      const childPromise = Promise.resolve().then(async () => {
        if (typeof request.childCommands?.run !== "function") {
          throw new BrowserWasiModuleError(
            "unsupported",
            "raw WASI worker child command bridge is unavailable",
            "runtime",
            { exitCode: 126 },
          );
        }
        return request.childCommands.run(
          workerChildCommandRequest(message.request ?? {}),
        );
      });
      pendingChildRequests.set(childId, childPromise);
      childPromise.then(
        (result) => {
          pendingChildRequests.delete(childId);
          postChildReply({
            type: "wasi.child.complete",
            id,
            childId,
            result: workerChildCommandResult(result),
          });
        },
        (error) => {
          pendingChildRequests.delete(childId);
          postChildReply({
            type: "wasi.child.error",
            id,
            childId,
            error: workerErrorPayload(error),
          });
        },
      );
    };
    const onMessage = (event) => {
      const message = event?.data ?? event;
      if (!message || message.id !== id) {
        return;
      }
      switch (message.type) {
        case "wasi.stdout":
          enqueueOutput(() => output.writeStdout(message.chunk));
          break;
        case "wasi.stderr":
          enqueueOutput(() => output.writeStderr(message.chunk));
          break;
        case "wasi.complete":
          resolveWith(message.result);
          break;
        case "wasi.error":
          rejectWith(workerErrorFromPayload(message.error));
          break;
        case "wasi.child.run":
          handleChildRun(message);
          break;
      }
    };
    const onError = (event) => {
      rejectWith(
        new BrowserWasiModuleError(
          "runtime",
          event?.message ?? "raw WASI execution worker failed",
          "runtime",
        ),
      );
    };
    const onAbort = () => {
      terminateExecutionWorker(worker);
      rejectWith(request.signal.reason ?? abortError());
    };
    const cleanup = () => {
      removeWorkerListener(worker, "message", onMessage);
      removeWorkerListener(worker, "error", onError);
      removeWorkerListener(worker, "messageerror", onError);
      request.signal?.removeEventListener?.("abort", onAbort);
      pendingChildRequests.clear();
      terminateExecutionWorker(worker);
    };

    addWorkerListener(worker, "message", onMessage);
    addWorkerListener(worker, "error", onError);
    addWorkerListener(worker, "messageerror", onError);
    if (request.signal?.aborted) {
      onAbort();
      return;
    }
    request.signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      postMessageToExecutionWorker(worker, runMessage, workerRequest.stdinBytes);
    } catch (error) {
      rejectWith(error);
    }
  });
}

export async function handleRawWasiModuleWorkerMessage(message) {
  if (
    message?.type === "wasi.child.complete" ||
    message?.type === "wasi.child.error"
  ) {
    settleRawWasiWorkerChildCommand(message);
    return;
  }
  if (!message || message.type !== "wasi.run") {
    return;
  }
  const { id, request } = message;
  const childBridge = createRawWasiWorkerChildCommandBridge(id);
  const output = {
    writeStderr(chunk) {
      postMessageToWorkerHost({
        type: "wasi.stderr",
        id,
        chunk: toUint8Array(chunk),
      });
    },
    writeStdout(chunk) {
      postMessageToWorkerHost({
        type: "wasi.stdout",
        id,
        chunk: toUint8Array(chunk),
      });
    },
  };
  try {
    const result = await runRawWasiModule(
      { ...request, childCommands: childBridge.commands },
      output,
      { worker: false },
    );
    postMessageToWorkerHost({ type: "wasi.complete", id, result });
  } catch (error) {
    postMessageToWorkerHost({
      type: "wasi.error",
      id,
      error: workerErrorPayload(error),
    });
  } finally {
    childBridge.close();
  }
}

async function createWasiWorkspaceMount(options = {}) {
  if (options.workspaceStore) {
    validateWorkspaceStore(options.workspaceStore);
    return writableWorkspaceMountFromSnapshot(
      await options.workspaceStore.exportSnapshot(),
      {
        files: options.files,
        rootFiles: options.rootFiles,
        store: options.workspaceStore,
      },
    );
  }
  if (options.workspaceSnapshot) {
    return writableWorkspaceMountFromSnapshot(options.workspaceSnapshot, {
      files: options.files,
      rootFiles: options.rootFiles,
    });
  }
  return {
    dirs: null,
    dirty: false,
    files: new Map(
      (options.files ?? []).map((file) => [
        file.path,
        { bytes: copyBytes(file.bytes), path: file.path },
      ]),
    ),
    packageRoot: readOnlyPackageRootMount(options.rootFiles),
    store: null,
    writable: false,
  };
}

async function writableWorkspaceMountFromSnapshot(snapshot, options = {}) {
  const memory = createMemoryBrowserWorkspaceStore({ snapshot });
  const normalizedSnapshot = await memory.exportSnapshot();
  const dirs = new Set([""]);
  const files = new Map();

  for (const entry of normalizedSnapshot.directories) {
    dirs.add(normalizeWorkspacePath(entry.path).relativePath);
  }
  for (const entry of normalizedSnapshot.files) {
    const normalized = normalizeWorkspacePath(entry.path);
    files.set(normalized.relativePath, {
      bytes: base64ToBytes(entry.contentBase64),
      mtimeMs: entry.mtimeMs,
      path: normalized.relativePath,
    });
  }
  for (const file of options.files ?? []) {
    if (!files.has(file.path)) {
      files.set(file.path, {
        bytes: copyBytes(file.bytes),
        fallback: true,
        path: file.path,
      });
    }
  }

  return {
    dirs,
    dirty: false,
    files,
    packageRoot: readOnlyPackageRootMount(options.rootFiles),
    store: options.store ?? null,
    writable: true,
  };
}

function readOnlyPackageRootMount(files = []) {
  const dirs = new Set(["", "workspace", "tmp"]);
  const records = new Map();
  for (const file of files ?? []) {
    records.set(file.path, {
      bytes: copyBytes(file.bytes),
      path: file.path,
    });
    addParentDirs(dirs, file.path);
  }
  return {
    dirs,
    files: records,
    preopen: records.size > 0,
  };
}

function addParentDirs(dirs, path) {
  const segments = String(path ?? "").split("/");
  let current = "";
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = current ? `${current}/${segments[index]}` : segments[index];
    if (current) {
      dirs.add(current);
    }
  }
}

async function workspaceResult(result, workspace) {
  if (!workspace.writable) {
    return result;
  }
  const workspaceSnapshot = exportWasiWorkspaceSnapshot(workspace);
  if (workspace.store && workspace.dirty) {
    await workspace.store.importSnapshot(workspaceSnapshot);
  }
  return { ...result, workspaceSnapshot };
}

function exportWasiWorkspaceSnapshot(workspace) {
  return {
    directories: Array.from(workspace.dirs, (path) => ({
      mtimeMs: 0,
      path: workspacePath(path),
    })).sort(compareSnapshotPathRecords),
    files: Array.from(workspace.files.values(), (file) => file)
      .filter((file) => !file.fallback)
      .map((file) => ({
        contentBase64: bytesToBase64(file.bytes),
        mtimeMs: file.mtimeMs ?? 0,
        path: workspacePath(file.path),
        size: file.bytes.byteLength,
      }))
      .sort(compareSnapshotPathRecords),
    root: WORKSPACE_PREOPEN_PATH,
    version: 1,
  };
}

function validateWorkspaceStore(store) {
  if (
    typeof store.exportSnapshot !== "function" ||
    typeof store.importSnapshot !== "function"
  ) {
    throw new BrowserWasiModuleError(
      "invalid_request",
      "raw WASI workspaceStore must support snapshot import/export",
      "runtime",
    );
  }
}

class WasiPreview1Runtime {
  constructor(options) {
    this.envObject = normalizeEnvObject(options.env ?? {});
    this.args = normalizeStringList(options.args ?? []);
    this.childCommands = options.childCommands ?? null;
    this.copyForkRunner = options.copyForkRunner ?? null;
    this.cwd = normalizeRuntimeCwd(options.cwd);
    this.diagnostics = normalizeRawWasiDiagnostics(options.diagnostics);
    this.env = envEntries(this.envObject);
    this.getInstance = options.getInstance;
    this.memory = null;
    this.output = options.output;
    this.wasix = new WasixRuntime(this);
    this.workspace = options.workspace;
    this.files = this.workspace.files;
    this.packageRoot = this.workspace.packageRoot ?? readOnlyPackageRootMount();
    this.packageRootFiles = this.packageRoot.files;
    this.packageRootDirs = this.packageRoot.dirs;
    this.packageRootFd = this.packageRoot.preopen ? FIRST_FILE_FD : null;
    this.workspaceDirs = this.workspace.dirs;
    this.fdFlagsExt = new Map();
    this.openFiles = new Map();
    this.scratchDirs = new Set([""]);
    this.scratchFiles = new Map();
    this.nextFileFd =
      this.packageRootFd == null ? FIRST_FILE_FD : FIRST_FILE_FD + 1;
    this.signal = options.signal;
    this.stdin = toUint8Array(options.stdin ?? new Uint8Array());
    this.stdinOffset = 0;
    this.continuationCapabilities = wasixContinuationCapabilities(null);
    this.stackContinuationSnapshots = new Map();
    this.stackContinuationCounter = 0n;
    this.pendingStackUnwind = null;
    this.pendingStackRewindValue = null;
    this.pendingForkRewind = null;
    this.currentProcessId = WASIX_ROOT_PID;
    this.nextProcessId = WASIX_ROOT_PID + 1;
    this.processes = new Map([
      [
        WASIX_ROOT_PID,
        {
          exitCode: null,
          parentPid: WASIX_ROOT_PARENT_PID,
          pid: WASIX_ROOT_PID,
          state: "running",
        },
      ],
    ]);
    this.activeVfork = null;
    this.unsupportedWasixCalls = new Map();
  }

  result(result) {
    const diagnostics = this.resultDiagnostics();
    if (!diagnostics) {
      return result;
    }
    return { ...result, diagnostics };
  }

  resultDiagnostics() {
    if (!this.diagnostics.unsupportedWasixCalls) {
      return null;
    }
    return {
      unsupportedWasixCalls: Array.from(this.unsupportedWasixCalls.values()).sort(
        compareWasixUnsupportedCallDiagnostics,
      ),
    };
  }

  recordUnsupportedWasixCall(group, name) {
    if (!this.diagnostics.unsupportedWasixCalls) {
      return;
    }
    const key = `${group}:${name}`;
    const existing = this.unsupportedWasixCalls.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.unsupportedWasixCalls.set(key, { count: 1, group, name });
  }

  mergeDiagnostics(diagnostics) {
    const normalized = normalizeRawWasiResultDiagnostics(diagnostics);
    if (!normalized?.unsupportedWasixCalls) {
      return;
    }
    for (const entry of normalized.unsupportedWasixCalls) {
      const key = `${entry.group}:${entry.name}`;
      const existing = this.unsupportedWasixCalls.get(key);
      if (existing) {
        existing.count += entry.count;
      } else {
        this.unsupportedWasixCalls.set(key, { ...entry });
      }
    }
  }

  setMemory(memory) {
    this.memory = memory;
  }

  setContinuationCapabilities(capabilities) {
    this.continuationCapabilities = capabilities;
  }

  hasStackContinuationSupport() {
    return (
      this.continuationCapabilities.asyncifyExports &&
      this.continuationCapabilities.stackBounds
    );
  }

  beginStackCheckpoint(snapshotPtr, retValPtr) {
    this.pendingStackUnwind = {
      retValPtr,
      snapshotPtr,
      type: "checkpoint",
    };
    this.startAsyncifyUnwind();
  }

  beginStackRestore(snapshotPtr, value) {
    const snapshot = this.readStackSnapshot(snapshotPtr);
    const key = stackSnapshotKey(snapshot);
    const record = this.stackContinuationSnapshots.get(key);
    if (!record) {
      this.recordUnsupportedWasixCall("thread-event", "stack_restore");
      throw new BrowserWasiModuleError(
        "runtime",
        "WASIX stack_restore snapshot is not available in this browser run",
        "runtime",
        { exitCode: 126 },
      );
    }
    this.pendingStackUnwind = {
      record,
      type: "restore",
      value: BigInt(value),
    };
    this.startAsyncifyUnwind();
  }

  finishStackRewind(retValPtr) {
    if (this.pendingStackRewindValue == null) {
      return false;
    }
    this.stopAsyncifyRewind();
    this.writeU64(retValPtr, this.pendingStackRewindValue);
    this.pendingStackRewindValue = null;
    return true;
  }

  beginVfork(pidPtr) {
    const parentPid = this.currentProcessId;
    const childPid = this.nextProcessId;
    this.nextProcessId += 1;
    this.processes.set(childPid, {
      exitCode: null,
      parentPid,
      pid: childPid,
      state: "running",
    });
    this.pendingStackUnwind = {
      childPid,
      parentPid,
      pidPtr,
      type: "vfork-child",
    };
    this.startAsyncifyUnwind();
    return ERRNO_SUCCESS;
  }

  beginCopyFork(pidPtr) {
    const parentPid = this.currentProcessId;
    const childPid = this.nextProcessId;
    this.nextProcessId += 1;
    this.processes.set(childPid, {
      exitCode: null,
      parentPid,
      pid: childPid,
      state: "running",
    });
    this.pendingStackUnwind = {
      childPid,
      parentPid,
      pidPtr,
      type: "copy-fork-child",
    };
    this.startAsyncifyUnwind();
    return ERRNO_SUCCESS;
  }

  finishForkRewind(pidPtr) {
    if (!this.pendingForkRewind) {
      return null;
    }
    const rewind = this.pendingForkRewind;
    this.pendingForkRewind = null;
    this.stopAsyncifyRewind();
    this.currentProcessId = rewind.processId;
    this.writeU32(pidPtr, rewind.pid);
    return rewind.errno;
  }

  hasActiveVforkChild() {
    return (
      this.activeVfork != null &&
      this.currentProcessId === this.activeVfork.childPid
    );
  }

  beginVforkChildExit(code) {
    if (!this.hasActiveVforkChild()) {
      return false;
    }
    const exitCode = Number(code) >>> 0;
    this.markProcessExited(this.activeVfork.childPid, exitCode);
    this.pendingStackUnwind = {
      childPid: this.activeVfork.childPid,
      type: "vfork-parent",
    };
    this.startAsyncifyUnwind();
    return true;
  }

  completeActiveVforkChild(code) {
    if (!this.hasActiveVforkChild()) {
      return false;
    }
    const childPid = this.activeVfork.childPid;
    this.markProcessExited(childPid, Number(code) >>> 0);
    this.beginVforkParentRewind(childPid);
    return true;
  }

  async finishContinuationTurn() {
    if (!this.pendingStackUnwind) {
      return false;
    }
    if (this.asyncifyState() !== WASIX_ASYNCIFY_STATE_UNWINDING) {
      throw new BrowserWasiModuleError(
        "runtime",
        "WASIX continuation did not unwind before returning to the browser host",
        "runtime",
        { exitCode: 126 },
      );
    }
    const action = this.pendingStackUnwind;
    this.pendingStackUnwind = null;
    const rewindStack = this.finishAsyncifyUnwind();
    if (action.type === "checkpoint") {
      const snapshot = this.createStackSnapshot(
        action.snapshotPtr,
        action.retValPtr,
        rewindStack,
      );
      this.beginStackRewind(snapshot, 0n);
      return true;
    }
    if (action.type === "vfork-child") {
      const record = {
        childPid: action.childPid,
        parentPid: action.parentPid,
        pidPtr: action.pidPtr,
        rewindStack: copyBytes(rewindStack),
      };
      this.activeVfork = {
        childPid: action.childPid,
        forkRecord: record,
        parentPid: action.parentPid,
      };
      this.beginForkRewind(record, 0, ERRNO_SUCCESS, action.childPid);
      return true;
    }
    if (action.type === "copy-fork-child") {
      const record = {
        childPid: action.childPid,
        parentPid: action.parentPid,
        pidPtr: action.pidPtr,
        rewindStack: copyBytes(rewindStack),
      };
      const result = await this.runCopyForkChild({
        childPid: action.childPid,
        globals: snapshotExportedMutableGlobals(this.getInstance?.()),
        memorySnapshot: copyBytes(this.bytes()),
        parentPid: action.parentPid,
        record,
      });
      this.mergeDiagnostics(result?.diagnostics);
      this.markProcessExited(action.childPid, Number(result?.exitCode ?? 0));
      this.beginForkRewind(record, action.childPid, ERRNO_SUCCESS, action.parentPid);
      return true;
    }
    if (action.type === "vfork-parent") {
      this.beginVforkParentRewind(action.childPid);
      return true;
    }
    this.beginStackRewind(action.record, action.value);
    return true;
  }

  startAsyncifyUnwind() {
    const bounds = this.requireStackContinuationBounds();
    this.writeU32(bounds.dataPtr, bounds.dataStart);
    this.writeU32(bounds.dataPtr + 4, bounds.dataEnd);
    this.continuationCapabilities.exports.asyncify_start_unwind(bounds.dataPtr);
  }

  finishAsyncifyUnwind() {
    const bounds = this.requireStackContinuationBounds();
    const finish = this.readU32(bounds.dataPtr);
    if (finish < bounds.dataStart || finish > bounds.dataEnd) {
      throw new BrowserWasiModuleError(
        "runtime",
        "WASIX asyncify unwind wrote an invalid stack range",
        "runtime",
        { exitCode: 126 },
      );
    }
    const rewindStack = this.bytes().slice(bounds.dataStart, finish);
    this.continuationCapabilities.exports.asyncify_stop_unwind();
    return rewindStack;
  }

  beginStackRewind(snapshot, value) {
    const bounds = this.requireStackContinuationBounds();
    const rewindStack = snapshot.rewindStack ?? new Uint8Array();
    const rewindEnd = bounds.dataStart + rewindStack.byteLength;
    if (rewindEnd > bounds.dataEnd) {
      throw new BrowserWasiModuleError(
        "runtime",
        "WASIX asyncify rewind stack exceeds the browser continuation buffer",
        "runtime",
        { exitCode: 126 },
      );
    }
    this.bytes().set(rewindStack, bounds.dataStart);
    this.writeU32(bounds.dataPtr, rewindEnd);
    this.writeU32(bounds.dataPtr + 4, bounds.dataEnd);
    this.pendingStackRewindValue = BigInt(value);
    this.continuationCapabilities.exports.asyncify_start_rewind(bounds.dataPtr);
  }

  beginForkRewind(record, pid, errno, processId) {
    const bounds = this.requireStackContinuationBounds();
    const rewindStack = record.rewindStack ?? new Uint8Array();
    const rewindEnd = bounds.dataStart + rewindStack.byteLength;
    if (rewindEnd > bounds.dataEnd) {
      throw new BrowserWasiModuleError(
        "runtime",
        "WASIX asyncify fork rewind stack exceeds the browser continuation buffer",
        "runtime",
        { exitCode: 126 },
      );
    }
    this.bytes().set(rewindStack, bounds.dataStart);
    this.writeU32(bounds.dataPtr, rewindEnd);
    this.writeU32(bounds.dataPtr + 4, bounds.dataEnd);
    this.pendingForkRewind = {
      errno,
      pid,
      processId,
    };
    this.currentProcessId = processId;
    this.continuationCapabilities.exports.asyncify_start_rewind(bounds.dataPtr);
  }

  beginVforkParentRewind(childPid) {
    if (!this.activeVfork || this.activeVfork.childPid !== childPid) {
      throw new BrowserWasiModuleError(
        "runtime",
        "WASIX vfork parent continuation is not active",
        "runtime",
        { exitCode: 126 },
      );
    }
    const { forkRecord, parentPid } = this.activeVfork;
    this.activeVfork = null;
    this.beginForkRewind(forkRecord, childPid, ERRNO_SUCCESS, parentPid);
  }

  async runCopyForkChild(fork) {
    if (typeof this.copyForkRunner !== "function") {
      throw new BrowserWasiModuleError(
        "unsupported",
        "WASIX copied-memory fork requires a browser child instance runner",
        "runtime",
        { exitCode: 126 },
      );
    }
    return this.copyForkRunner(fork);
  }

  stopAsyncifyRewind() {
    this.continuationCapabilities.exports.asyncify_stop_rewind();
  }

  asyncifyState() {
    return Number(this.continuationCapabilities.exports.asyncify_get_state());
  }

  createStackSnapshot(snapshotPtr, retValPtr, rewindStack) {
    const hash = this.nextStackSnapshotHash();
    const snapshot = {
      hashHigh: hash.high,
      hashLow: hash.low,
      key: stackSnapshotKey({ hashHigh: hash.high, hashLow: hash.low }),
      retValPtr,
      rewindStack: copyBytes(rewindStack),
    };
    this.writeU64(snapshotPtr, BigInt(retValPtr));
    this.writeU64(snapshotPtr + 8, snapshot.hashLow);
    this.writeU64(snapshotPtr + 16, snapshot.hashHigh);
    this.stackContinuationSnapshots.set(snapshot.key, snapshot);
    return snapshot;
  }

  readStackSnapshot(snapshotPtr) {
    return {
      hashLow: this.readU64(snapshotPtr + 8),
      hashHigh: this.readU64(snapshotPtr + 16),
    };
  }

  nextStackSnapshotHash() {
    this.stackContinuationCounter += 1n;
    return {
      high: 0x737461636b000000n,
      low: this.stackContinuationCounter,
    };
  }

  requireStackContinuationBounds() {
    const bounds = this.continuationCapabilities.stackBounds;
    if (!bounds) {
      throw new BrowserWasiModuleError(
        "unsupported",
        wasixStackRestoreUnsupportedMessage(this.continuationCapabilities),
        "runtime",
        { exitCode: 126 },
      );
    }
    return bounds;
  }

  importObject() {
    const imports = {
      [WASI_IMPORT_MODULE]: this.imports(),
    };
    imports[WASI_THREAD_IMPORT_MODULE] = this.wasiThreadImports();
    imports[WASIX_IMPORT_MODULE] = this.wasix.imports();
    return imports;
  }

  wasiThreadImports() {
    return {
      [WASI_THREAD_SPAWN_IMPORT]: (_startArg) => this.wasiThreadSpawn(),
    };
  }

  wasiThreadSpawn() {
    this.throwIfAborted();
    return -ERRNO_NOTSUP;
  }

  async runProcessExec(request) {
    if (typeof this.childCommands?.run !== "function") {
      throw new BrowserWasiModuleError(
        "unsupported",
        "WASIX proc_exec child command bridge is unavailable",
        "runtime",
        { exitCode: 126 },
      );
    }
    const result = await this.childCommands.run(request);
    this.mergeDiagnostics(result?.diagnostics);
    return { exitCode: Number(result?.exitCode ?? 0) };
  }

  markProcessExited(pid, exitCode) {
    const record = this.processes.get(pid);
    if (!record) {
      return;
    }
    record.exitCode = exitCode;
    record.state = "exited";
  }

  processRecord(pid) {
    return this.processes.get(pid >>> 0) ?? null;
  }

  findExitedChild(parentPid) {
    for (const record of this.processes.values()) {
      if (record.parentPid === parentPid && record.state === "exited") {
        return record;
      }
    }
    return null;
  }

  hasChildProcess(parentPid) {
    for (const record of this.processes.values()) {
      if (record.parentPid === parentPid) {
        return true;
      }
    }
    return false;
  }

  reapProcess(pid) {
    if (pid !== WASIX_ROOT_PID) {
      this.processes.delete(pid);
    }
  }

  imports() {
    return {
      args_get: (argvPtr, argvBufPtr) =>
        this.writeStringPointers(this.args, argvPtr, argvBufPtr),
      args_sizes_get: (argcPtr, argvBufSizePtr) =>
        this.writeSizes(this.args, argcPtr, argvBufSizePtr),
      clock_res_get: (clockId, resolutionPtr) =>
        this.clockResGet(clockId, resolutionPtr),
      clock_time_get: (clockId, precision, timePtr) =>
        this.clockTimeGet(clockId, precision, timePtr),
      environ_get: (environPtr, environBufPtr) =>
        this.writeStringPointers(this.env, environPtr, environBufPtr),
      environ_sizes_get: (environCountPtr, environBufSizePtr) =>
        this.writeSizes(this.env, environCountPtr, environBufSizePtr),
      fd_read: (fd, iovsPtr, iovsLen, nreadPtr) =>
        this.fdRead(fd, iovsPtr, iovsLen, nreadPtr),
      fd_pread: (fd, iovsPtr, iovsLen, offset, nreadPtr) =>
        this.fdPread(fd, iovsPtr, iovsLen, offset, nreadPtr),
      fd_pwrite: (fd, iovsPtr, iovsLen, offset, nwrittenPtr) =>
        this.fdPwrite(fd, iovsPtr, iovsLen, offset, nwrittenPtr),
      fd_allocate: (fd, offset, length) =>
        this.fdAllocate(fd, offset, length),
      fd_advise: (fd, offset, length, advice) =>
        this.fdAdvise(fd, offset, length, advice),
      fd_datasync: (fd) => this.fdSync(fd, WASI_RIGHT_FD_DATASYNC),
      fd_readdir: (fd, bufferPtr, bufferLength, cookie, bufferUsedPtr) =>
        this.fdReaddir(fd, bufferPtr, bufferLength, cookie, bufferUsedPtr),
      fd_renumber: (fd, to) => this.fdRenumber(fd, to),
      fd_seek: (fd, offset, whence, newOffsetPtr) =>
        this.fdSeek(fd, offset, whence, newOffsetPtr),
      fd_sync: (fd) => this.fdSync(fd, WASI_RIGHT_FD_SYNC),
      fd_tell: (fd, offsetPtr) => this.fdTell(fd, offsetPtr),
      fd_fdstat_get: (fd, fdstatPtr) => this.fdFdstatGet(fd, fdstatPtr),
      fd_fdstat_set_flags: (fd, flags) => this.fdFdstatSetFlags(fd, flags),
      fd_fdstat_set_rights: (fd, rightsBase, rightsInheriting) =>
        this.fdFdstatSetRights(fd, rightsBase, rightsInheriting),
      fd_close: (fd) => this.fdClose(fd),
      fd_filestat_get: (fd, filestatPtr) =>
        this.fdFilestatGet(fd, filestatPtr),
      fd_filestat_set_size: (fd, size) =>
        this.fdFilestatSetSize(fd, size),
      fd_filestat_set_times: (fd, atim, mtim, fstFlags) =>
        this.fdFilestatSetTimes(fd, atim, mtim, fstFlags),
      fd_prestat_dir_name: (fd, pathPtr, pathLen) =>
        this.fdPrestatDirName(fd, pathPtr, pathLen),
      fd_prestat_get: (fd, prestatPtr) => this.fdPrestatGet(fd, prestatPtr),
      fd_write: (fd, iovsPtr, iovsLen, nwrittenPtr) =>
        this.fdWrite(fd, iovsPtr, iovsLen, nwrittenPtr),
      path_open: (
        fd,
        dirflags,
        pathPtr,
        pathLen,
        oflags,
        rightsBase,
        rightsInheriting,
        fdflags,
        openedFdPtr,
      ) =>
        this.pathOpen(
          fd,
          dirflags,
          pathPtr,
          pathLen,
          oflags,
          rightsBase,
          rightsInheriting,
          fdflags,
          openedFdPtr,
        ),
      path_filestat_get: (fd, flags, pathPtr, pathLen, filestatPtr) =>
        this.pathFilestatGet(fd, flags, pathPtr, pathLen, filestatPtr),
      path_filestat_set_times: (
        fd,
        flags,
        pathPtr,
        pathLen,
        atim,
        mtim,
        fstFlags,
      ) =>
        this.pathFilestatSetTimes(
          fd,
          flags,
          pathPtr,
          pathLen,
          atim,
          mtim,
          fstFlags,
        ),
      path_create_directory: (fd, pathPtr, pathLen) =>
        this.pathCreateDirectory(fd, pathPtr, pathLen),
      path_link: (
        oldFd,
        oldFlags,
        oldPathPtr,
        oldPathLen,
        newFd,
        newPathPtr,
        newPathLen,
      ) =>
        this.pathLink(
          oldFd,
          oldFlags,
          oldPathPtr,
          oldPathLen,
          newFd,
          newPathPtr,
          newPathLen,
        ),
      path_readlink: (fd, pathPtr, pathLen, bufPtr, bufLen, bufUsedPtr) =>
        this.pathReadlink(fd, pathPtr, pathLen, bufPtr, bufLen, bufUsedPtr),
      path_rename: (
        oldFd,
        oldPathPtr,
        oldPathLen,
        newFd,
        newPathPtr,
        newPathLen,
      ) =>
        this.pathRename(
          oldFd,
          oldPathPtr,
          oldPathLen,
          newFd,
          newPathPtr,
          newPathLen,
        ),
      path_remove_directory: (fd, pathPtr, pathLen) =>
        this.pathRemoveDirectory(fd, pathPtr, pathLen),
      path_symlink: (oldPathPtr, oldPathLen, fd, newPathPtr, newPathLen) =>
        this.pathSymlink(oldPathPtr, oldPathLen, fd, newPathPtr, newPathLen),
      path_unlink_file: (fd, pathPtr, pathLen) =>
        this.pathUnlinkFile(fd, pathPtr, pathLen),
      poll_oneoff: (
        subscriptionsPtr,
        eventsPtr,
        subscriptionsLen,
        eventsUsedPtr,
      ) =>
        this.pollOneoff(
          subscriptionsPtr,
          eventsPtr,
          subscriptionsLen,
          eventsUsedPtr,
        ),
      proc_raise: (signal) => this.procRaise(signal),
      random_get: (bufferPtr, bufferLength) =>
        this.randomGet(bufferPtr, bufferLength),
      sched_yield: () => this.schedYield(),
      sock_accept: (fd, flags, acceptedFdPtr) =>
        this.sockAccept(fd, flags, acceptedFdPtr),
      sock_recv: (fd, iovsPtr, iovsLen, flags, nreadPtr, roFlagsPtr) =>
        this.sockRecv(fd, iovsPtr, iovsLen, flags, nreadPtr, roFlagsPtr),
      sock_send: (fd, iovsPtr, iovsLen, flags, nwrittenPtr) =>
        this.sockSend(fd, iovsPtr, iovsLen, flags, nwrittenPtr),
      sock_shutdown: (fd, how) => this.sockShutdown(fd, how),
      proc_exit: (exitCode) => {
        throw new WasiProcExit(exitCode);
      },
    };
  }

  writeSizes(values, countPtr, bufSizePtr) {
    this.throwIfAborted();
    this.writeU32(countPtr, values.length);
    this.writeU32(bufSizePtr, stringListBufferSize(values));
    return ERRNO_SUCCESS;
  }

  writeStringPointers(values, pointersPtr, bufferPtr) {
    this.throwIfAborted();
    let offset = bufferPtr;
    for (let index = 0; index < values.length; index += 1) {
      const encoded = encodeCString(values[index]);
      this.writeU32(pointersPtr + index * 4, offset);
      this.bytes().set(encoded, offset);
      offset += encoded.byteLength;
    }
    return ERRNO_SUCCESS;
  }

  clockResGet(clockId, resolutionPtr) {
    this.throwIfAborted();
    if (!isSupportedClock(clockId)) {
      return ERRNO_INVAL;
    }
    this.writeU64(resolutionPtr, CLOCK_RESOLUTION_NANOS);
    return ERRNO_SUCCESS;
  }

  clockTimeGet(clockId, _precision, timePtr) {
    this.throwIfAborted();
    const time = clockTimeNanos(clockId);
    if (time == null) {
      return ERRNO_INVAL;
    }
    this.writeU64(timePtr, time);
    return ERRNO_SUCCESS;
  }

  randomGet(bufferPtr, bufferLength) {
    this.throwIfAborted();
    const random = cryptoRandom();
    const bytes = this.bytes();
    const start = bufferPtr >>> 0;
    const length = bufferLength >>> 0;
    const end = checkedMemoryRange(start, length, bytes.byteLength);
    if (end == null) {
      return ERRNO_FAULT;
    }
    let offset = 0;
    while (offset < length) {
      this.throwIfAborted();
      const chunkLength = Math.min(RANDOM_GET_CHUNK_SIZE, length - offset);
      const chunk = new Uint8Array(chunkLength);
      random.getRandomValues(chunk);
      bytes.set(chunk, start + offset);
      offset += chunkLength;
    }
    return ERRNO_SUCCESS;
  }

  schedYield() {
    this.throwIfAborted();
    return ERRNO_SUCCESS;
  }

  fdWrite(fd, iovsPtr, iovsLen, nwrittenPtr) {
    this.throwIfAborted();
    const file = this.openFiles.get(fd);
    if (isOpenPipe(file)) {
      return this.fdWritePipe(file, iovsPtr, iovsLen, nwrittenPtr);
    }
    if (isOpenStdio(file)) {
      return this.fdWriteStdio(file, iovsPtr, iovsLen, nwrittenPtr);
    }
    if (fd !== STDOUT_FD && fd !== STDERR_FD && !file) {
      this.writeU32(nwrittenPtr, 0);
      return ERRNO_BADF;
    }
    if (file && !canWriteFile(file)) {
      this.writeU32(nwrittenPtr, 0);
      return ERRNO_NOTCAPABLE;
    }

    const { chunks, total } = this.readIovChunks(iovsPtr, iovsLen);
    this.writeU32(nwrittenPtr, total);

    if (file) {
      this.writeOpenFile(file, chunks);
      return ERRNO_SUCCESS;
    }

    for (const chunk of chunks) {
      if (fd === STDOUT_FD) {
        void this.output.writeStdout(chunk);
      } else {
        void this.output.writeStderr(chunk);
      }
    }
    return ERRNO_SUCCESS;
  }

  fdWriteStdio(file, iovsPtr, iovsLen, nwrittenPtr) {
    if (file.stdioFd !== STDOUT_FD && file.stdioFd !== STDERR_FD) {
      this.writeU32(nwrittenPtr, 0);
      return ERRNO_BADF;
    }
    if ((file.rights & WASI_RIGHT_FD_WRITE) === 0n) {
      this.writeU32(nwrittenPtr, 0);
      return ERRNO_NOTCAPABLE;
    }

    const { chunks, total } = this.readIovChunks(iovsPtr, iovsLen);
    this.writeU32(nwrittenPtr, total);
    for (const chunk of chunks) {
      if (file.stdioFd === STDOUT_FD) {
        void this.output.writeStdout(chunk);
      } else {
        void this.output.writeStderr(chunk);
      }
    }
    return ERRNO_SUCCESS;
  }

  fdWritePipe(file, iovsPtr, iovsLen, nwrittenPtr) {
    this.writeU32(nwrittenPtr, 0);
    if (file.direction !== "write") {
      return ERRNO_BADF;
    }
    if ((file.rights & WASI_RIGHT_FD_WRITE) === 0n) {
      return ERRNO_NOTCAPABLE;
    }
    if (file.pipe.readers <= 0) {
      return ERRNO_PIPE;
    }

    const { chunks, total } = this.readIovChunks(iovsPtr, iovsLen);
    if (file.pipe.bytes.byteLength + total > PIPE_BUFFER_LIMIT) {
      return ERRNO_AGAIN;
    }

    const next = new Uint8Array(file.pipe.bytes.byteLength + total);
    next.set(file.pipe.bytes);
    let offset = file.pipe.bytes.byteLength;
    for (const chunk of chunks) {
      next.set(chunk, offset);
      offset += chunk.byteLength;
    }
    file.pipe.bytes = next;
    this.writeU32(nwrittenPtr, total);
    return ERRNO_SUCCESS;
  }

  fdPwrite(fd, iovsPtr, iovsLen, offset, nwrittenPtr) {
    this.throwIfAborted();
    const file = this.openFiles.get(fd);
    this.writeU32(nwrittenPtr, 0);
    if (
      fd === WORKSPACE_FD ||
      fd === TMP_FD ||
      fd === this.packageRootFd ||
      isOpenDirectory(file)
    ) {
      return ERRNO_ISDIR;
    }
    if (isOpenPipe(file) || isOpenStdio(file)) {
      return ERRNO_BADF;
    }
    if (!file) {
      return this.fdStat(fd) ? ERRNO_NOTCAPABLE : ERRNO_BADF;
    }
    if (!canWriteFile(file)) {
      return ERRNO_NOTCAPABLE;
    }
    const start = resolveFileSize(offset);
    if (start.errno != null) {
      return start.errno;
    }

    const { chunks, total } = this.readIovChunks(iovsPtr, iovsLen);
    const range = resolveFileRange(start.size, total);
    if (range.errno != null) {
      return range.errno;
    }
    this.writeOpenFileAt(file, chunks, start.size);
    this.writeU32(nwrittenPtr, total);
    return ERRNO_SUCCESS;
  }

  readIovChunks(iovsPtr, iovsLen) {
    const chunks = [];
    let total = 0;
    for (let index = 0; index < iovsLen; index += 1) {
      const iovPtr = iovsPtr + index * 8;
      const dataPtr = this.readU32(iovPtr);
      const dataLength = this.readU32(iovPtr + 4);
      const chunk = this.bytes().slice(dataPtr, dataPtr + dataLength);
      chunks.push(chunk);
      total += dataLength;
    }
    return { chunks, total };
  }

  fdRead(fd, iovsPtr, iovsLen, nreadPtr) {
    this.throwIfAborted();
    const file = this.openFiles.get(fd);
    if (isOpenPipe(file)) {
      return this.fdReadPipe(file, iovsPtr, iovsLen, nreadPtr);
    }
    if (isOpenStdio(file)) {
      return this.fdReadStdio(file, iovsPtr, iovsLen, nreadPtr);
    }
    if (
      fd === WORKSPACE_FD ||
      fd === TMP_FD ||
      fd === this.packageRootFd ||
      isOpenDirectory(file)
    ) {
      this.writeU32(nreadPtr, 0);
      return ERRNO_ISDIR;
    }
    if (fd !== STDIN_FD && !file) {
      this.writeU32(nreadPtr, 0);
      return ERRNO_BADF;
    }

    const input = file?.record.bytes ?? this.stdin;
    const inputOffset = file?.offset ?? this.stdinOffset;
    const total = this.readIntoIovs(input, inputOffset, iovsPtr, iovsLen);
    if (file) {
      file.offset += total;
    } else {
      this.stdinOffset += total;
    }
    this.writeU32(nreadPtr, total);
    return ERRNO_SUCCESS;
  }

  fdReadStdio(file, iovsPtr, iovsLen, nreadPtr) {
    this.writeU32(nreadPtr, 0);
    if (file.stdioFd !== STDIN_FD) {
      return ERRNO_BADF;
    }
    if ((file.rights & WASI_RIGHT_FD_READ) === 0n) {
      return ERRNO_NOTCAPABLE;
    }
    const total = this.readIntoIovs(
      this.stdin,
      this.stdinOffset,
      iovsPtr,
      iovsLen,
    );
    this.stdinOffset += total;
    this.writeU32(nreadPtr, total);
    return ERRNO_SUCCESS;
  }

  fdReadPipe(file, iovsPtr, iovsLen, nreadPtr) {
    this.writeU32(nreadPtr, 0);
    if (file.direction !== "read") {
      return ERRNO_BADF;
    }
    if ((file.rights & WASI_RIGHT_FD_READ) === 0n) {
      return ERRNO_NOTCAPABLE;
    }
    if (file.pipe.bytes.byteLength === 0) {
      return file.pipe.writers > 0 ? ERRNO_AGAIN : ERRNO_SUCCESS;
    }

    const total = this.readIntoIovs(file.pipe.bytes, 0, iovsPtr, iovsLen);
    file.pipe.bytes = file.pipe.bytes.slice(total);
    this.writeU32(nreadPtr, total);
    return ERRNO_SUCCESS;
  }

  fdPread(fd, iovsPtr, iovsLen, offset, nreadPtr) {
    this.throwIfAborted();
    const file = this.openFiles.get(fd);
    this.writeU32(nreadPtr, 0);
    if (
      fd === WORKSPACE_FD ||
      fd === TMP_FD ||
      fd === this.packageRootFd ||
      isOpenDirectory(file)
    ) {
      return ERRNO_ISDIR;
    }
    if (isOpenPipe(file) || isOpenStdio(file)) {
      return ERRNO_BADF;
    }
    if (!file) {
      return this.fdStat(fd) ? ERRNO_NOTCAPABLE : ERRNO_BADF;
    }
    if (!canReadFile(file)) {
      return ERRNO_NOTCAPABLE;
    }
    const start = resolveFileSize(offset);
    if (start.errno != null) {
      return start.errno;
    }
    const total = this.readIntoIovs(
      file.record.bytes,
      start.size,
      iovsPtr,
      iovsLen,
    );
    this.writeU32(nreadPtr, total);
    return ERRNO_SUCCESS;
  }

  readIntoIovs(input, inputOffset, iovsPtr, iovsLen) {
    let total = 0;
    let offset = inputOffset;
    for (let index = 0; index < iovsLen; index += 1) {
      if (offset >= input.byteLength) {
        break;
      }
      const iovPtr = iovsPtr + index * 8;
      const dataPtr = this.readU32(iovPtr);
      const dataLength = this.readU32(iovPtr + 4);
      const available = input.byteLength - offset;
      const readLength = Math.min(dataLength, available);
      if (readLength > 0) {
        this.bytes().set(input.subarray(offset, offset + readLength), dataPtr);
        offset += readLength;
        total += readLength;
      }
    }
    return total;
  }

  writeOpenFile(file, chunks) {
    let offset =
      (file.fdflags & WASI_FDFLAGS_APPEND) !== 0
        ? file.record.bytes.byteLength
        : file.offset;
    file.offset = this.writeOpenFileAt(file, chunks, offset);
  }

  writeOpenFileAt(file, chunks, offset) {
    let changed = false;
    for (const chunk of chunks) {
      const end = offset + chunk.byteLength;
      if (end > file.record.bytes.byteLength) {
        const next = new Uint8Array(end);
        next.set(file.record.bytes);
        file.record.bytes = next;
        changed = true;
      }
      file.record.bytes.set(chunk, offset);
      changed ||= chunk.byteLength > 0;
      offset = end;
    }
    if (changed) {
      this.markOpenFileDirty(file);
    }
    return offset;
  }

  fdReaddir(fd, bufferPtr, bufferLength, cookie, bufferUsedPtr) {
    this.throwIfAborted();
    const directory = this.directoryForFd(fd);
    if (!directory) {
      return this.fdStat(fd) ? ERRNO_NOTDIR : ERRNO_BADF;
    }
    const startIndex = readdirStartIndex(cookie);
    if (startIndex == null) {
      return ERRNO_INVAL;
    }

    const entries = directory.entries();
    const bytes = this.bytes();
    const output = bytes.subarray(bufferPtr, bufferPtr + (bufferLength >>> 0));
    let used = 0;
    for (let index = startIndex; index < entries.length; index += 1) {
      const entry = entries[index];
      const dirent = direntBytes(entry, index + 1);
      const wroteDirent = copyPartial(dirent, output, used);
      used += wroteDirent;
      if (wroteDirent !== dirent.byteLength) {
        break;
      }

      const name = encodeText(entry.name);
      const wroteName = copyPartial(name, output, used);
      used += wroteName;
      if (wroteName !== name.byteLength) {
        break;
      }
    }
    this.writeU32(bufferUsedPtr, used);
    return ERRNO_SUCCESS;
  }

  fdSeek(fd, offset, whence, newOffsetPtr) {
    this.throwIfAborted();
    const file = this.openFiles.get(fd);
    if (!file || isOpenPipe(file) || isOpenStdio(file)) {
      return this.fdStat(fd) ? ERRNO_ACCESS : ERRNO_BADF;
    }

    const seek = resolveFileSeekOffset(file, offset, whence);
    if (seek.errno != null) {
      return seek.errno;
    }
    file.offset = seek.offset;
    this.writeU64(newOffsetPtr, BigInt(seek.offset));
    return ERRNO_SUCCESS;
  }

  fdTell(fd, offsetPtr) {
    this.throwIfAborted();
    const file = this.openFiles.get(fd);
    if (!file || isOpenPipe(file) || isOpenStdio(file)) {
      return this.fdStat(fd) ? ERRNO_ACCESS : ERRNO_BADF;
    }

    this.writeU64(offsetPtr, BigInt(file.offset));
    return ERRNO_SUCCESS;
  }

  fdFdstatGet(fd, fdstatPtr) {
    this.throwIfAborted();
    const stat = this.fdStat(fd);
    if (!stat) {
      return ERRNO_BADF;
    }
    this.writeU8(fdstatPtr, stat.filetype);
    this.writeU8(fdstatPtr + 1, 0);
    this.writeU16(fdstatPtr + 2, 0);
    this.writeU32(fdstatPtr + 4, 0);
    this.writeU64(fdstatPtr + 8, stat.rights);
    this.writeU64(fdstatPtr + 16, stat.inheriting ?? 0n);
    return ERRNO_SUCCESS;
  }

  fdFdstatSetFlags(fd, _flags) {
    this.throwIfAborted();
    return this.fdStat(fd) ? ERRNO_SUCCESS : ERRNO_BADF;
  }

  fdFdflagsGet(fd, flagsPtr) {
    this.throwIfAborted();
    if (!this.fdStat(fd)) {
      return ERRNO_BADF;
    }
    this.writeU32(flagsPtr, this.fdFlagsExt.get(fd) ?? 0);
    return ERRNO_SUCCESS;
  }

  fdFdflagsSet(fd, flags) {
    this.throwIfAborted();
    const nextFlags = flags >>> 0;
    if ((nextFlags & ~WASIX_FDFLAGSEXT_MASK) !== 0) {
      return ERRNO_INVAL;
    }
    if (!this.fdStat(fd)) {
      return ERRNO_BADF;
    }
    if (nextFlags === 0) {
      this.fdFlagsExt.delete(fd);
    } else {
      this.fdFlagsExt.set(fd, nextFlags);
    }
    return ERRNO_SUCCESS;
  }

  fdFdstatSetRights(fd, rightsBase, rightsInheriting) {
    this.throwIfAborted();
    const stat = this.fdStat(fd);
    if (!stat) {
      return ERRNO_BADF;
    }

    const nextRights = BigInt(rightsBase);
    const nextInheriting = BigInt(rightsInheriting);
    if (
      !allowsRights(nextRights, stat.rights) ||
      !allowsRights(nextInheriting, stat.inheriting ?? 0n)
    ) {
      return ERRNO_NOTCAPABLE;
    }

    const file = this.openFiles.get(fd);
    if (file) {
      file.rights = nextRights;
      if (isOpenDirectory(file)) {
        file.inheriting = nextInheriting;
      }
    }
    return ERRNO_SUCCESS;
  }

  fdClose(fd) {
    this.throwIfAborted();
    const file = this.openFiles.get(fd);
    if (file) {
      this.closeOpenFile(file);
      this.openFiles.delete(fd);
      this.fdFlagsExt.delete(fd);
      return ERRNO_SUCCESS;
    }
    return ERRNO_BADF;
  }

  fdRenumber(fd, to) {
    this.throwIfAborted();
    const file = this.openFiles.get(fd);
    if (!file) {
      return this.fdStat(fd) ? ERRNO_NOTCAPABLE : ERRNO_BADF;
    }
    if (!isDynamicFileFdNumber(to)) {
      return ERRNO_NOTCAPABLE;
    }
    if (fd === to) {
      return ERRNO_SUCCESS;
    }

    const replaced = this.openFiles.get(to);
    if (replaced) {
      this.closeOpenFile(replaced);
    }
    this.openFiles.delete(fd);
    this.openFiles.set(to, file);
    const fdFlagsExt = this.fdFlagsExt.get(fd);
    this.fdFlagsExt.delete(fd);
    this.fdFlagsExt.delete(to);
    if (fdFlagsExt != null) {
      this.fdFlagsExt.set(to, fdFlagsExt);
    }
    if (to >= this.nextFileFd) {
      this.nextFileFd = to + 1;
    }
    return ERRNO_SUCCESS;
  }

  fdDup(fd, retFdPtr) {
    return this.duplicateFd(fd, FIRST_FILE_FD, 0, retFdPtr);
  }

  fdDup2(fd, minResultFd, cloexec, retFdPtr) {
    const fdFlagsExt =
      Number(cloexec) === 1 ? WASIX_FDFLAGSEXT_CLOEXEC : 0;
    return this.duplicateFd(fd, minResultFd, fdFlagsExt, retFdPtr);
  }

  duplicateFd(fd, minResultFd, fdFlagsExt, retFdPtr) {
    this.throwIfAborted();
    if (!this.canWriteU32(retFdPtr)) {
      return ERRNO_FAULT;
    }
    const file = this.duplicateOpenFileForFd(fd);
    if (!file) {
      return ERRNO_BADF;
    }
    const newFd = this.allocateDynamicFileFd(minResultFd);
    this.retainOpenFile(file);
    this.openFiles.set(newFd, file);
    if (fdFlagsExt === 0) {
      this.fdFlagsExt.delete(newFd);
    } else {
      this.fdFlagsExt.set(newFd, fdFlagsExt);
    }
    this.writeU32(retFdPtr, newFd);
    return ERRNO_SUCCESS;
  }

  duplicateOpenFileForFd(fd) {
    const file = this.openFiles.get(fd);
    if (file) {
      return duplicateOpenFileDescriptor(file);
    }
    const stat = this.fdStat(fd);
    if (!stat) {
      return null;
    }
    const stdioRightsValue = stdioRights(fd);
    if (stdioRightsValue != null) {
      return {
        fdflags: 0,
        kind: "stdio",
        rights: stdioRightsValue,
        stdioFd: fd,
      };
    }
    if (fd === WORKSPACE_FD) {
      return {
        preopenPath: WORKSPACE_PREOPEN_PATH,
        fdflags: 0,
        inheriting: stat.inheriting,
        kind: "directory",
        mount: "workspace",
        offset: 0,
        path: "",
        rights: stat.rights,
      };
    }
    if (fd === TMP_FD) {
      return {
        preopenPath: TMP_PREOPEN_PATH,
        fdflags: 0,
        inheriting: stat.inheriting,
        kind: "directory",
        mount: "scratch",
        offset: 0,
        path: "",
        rights: stat.rights,
      };
    }
    if (fd === this.packageRootFd) {
      return {
        preopenPath: PACKAGE_ROOT_PREOPEN_PATH,
        fdflags: 0,
        inheriting: stat.inheriting,
        kind: "directory",
        mount: "package-root",
        offset: 0,
        path: "",
        rights: stat.rights,
      };
    }
    return null;
  }

  fdPipe(readFdPtr, writeFdPtr) {
    this.throwIfAborted();
    if (!this.canWriteU32(readFdPtr) || !this.canWriteU32(writeFdPtr)) {
      return ERRNO_FAULT;
    }
    const pipe = {
      bytes: new Uint8Array(),
      readers: 1,
      writers: 1,
    };
    const readFd = this.allocateDynamicFileFd(FIRST_FILE_FD);
    this.openFiles.set(readFd, {
      direction: "read",
      fdflags: 0,
      kind: "pipe",
      pipe,
      rights: WASI_PIPE_READ_RIGHTS,
    });
    const writeFd = this.allocateDynamicFileFd(readFd + 1);
    this.openFiles.set(writeFd, {
      direction: "write",
      fdflags: 0,
      kind: "pipe",
      pipe,
      rights: WASI_PIPE_WRITE_RIGHTS,
      writable: true,
    });
    this.writeU32(readFdPtr, readFd);
    this.writeU32(writeFdPtr, writeFd);
    return ERRNO_SUCCESS;
  }

  allocateDynamicFileFd(minResultFd = FIRST_FILE_FD) {
    let fd = Math.max(FIRST_FILE_FD, Number(minResultFd) >>> 0);
    while (this.fdStat(fd)) {
      fd += 1;
    }
    if (fd >= this.nextFileFd) {
      this.nextFileFd = fd + 1;
    }
    return fd;
  }

  retainOpenFile(file) {
    if (!isOpenPipe(file)) {
      return;
    }
    if (file.direction === "read") {
      file.pipe.readers += 1;
    } else {
      file.pipe.writers += 1;
    }
  }

  closeOpenFile(file) {
    if (!isOpenPipe(file)) {
      return;
    }
    if (file.direction === "read") {
      file.pipe.readers = Math.max(0, file.pipe.readers - 1);
    } else {
      file.pipe.writers = Math.max(0, file.pipe.writers - 1);
    }
  }

  canWriteU32(ptr) {
    return checkedMemoryRange(ptr >>> 0, 4, this.bytes().byteLength) != null;
  }

  canReadWrite(ptr, byteLength) {
    return (
      checkedMemoryRange(ptr >>> 0, byteLength, this.bytes().byteLength) != null
    );
  }

  fdFilestatGet(fd, filestatPtr) {
    this.throwIfAborted();
    const stat = this.fdStat(fd);
    if (!stat) {
      return ERRNO_BADF;
    }
    this.writeFilestat(filestatPtr, stat.filetype, stat.size ?? 0);
    return ERRNO_SUCCESS;
  }

  fdFilestatSetSize(fd, size) {
    this.throwIfAborted();
    const file = this.openFiles.get(fd);
    if (!file) {
      const stat = this.fdStat(fd);
      if (!stat) {
        return ERRNO_BADF;
      }
      return stat.filetype === WASI_FILETYPE_DIRECTORY
        ? ERRNO_ISDIR
        : ERRNO_NOTCAPABLE;
    }
    if (isOpenDirectory(file)) {
      return ERRNO_ISDIR;
    }
    if (!canResizeFile(file)) {
      return ERRNO_NOTCAPABLE;
    }
    const nextSize = resolveFileSize(size);
    if (nextSize.errno != null) {
      return nextSize.errno;
    }
    if (resizeOpenFile(file, nextSize.size)) {
      this.markOpenFileDirty(file);
    }
    return ERRNO_SUCCESS;
  }

  fdFilestatSetTimes(fd, _atim, _mtim, fstFlags) {
    this.throwIfAborted();
    if (!isSupportedFilestatSetTimesFlags(fstFlags)) {
      return ERRNO_INVAL;
    }

    const file = this.openFiles.get(fd);
    if (!file) {
      const stat = this.fdStat(fd);
      if (!stat) {
        return ERRNO_BADF;
      }
      return stat.filetype === WASI_FILETYPE_DIRECTORY
        ? ERRNO_ISDIR
        : ERRNO_NOTCAPABLE;
    }
    if (isOpenDirectory(file)) {
      return ERRNO_ISDIR;
    }
    return canSetFileTimes(file) ? ERRNO_SUCCESS : ERRNO_NOTCAPABLE;
  }

  fdAllocate(fd, offset, length) {
    this.throwIfAborted();
    const file = this.openFiles.get(fd);
    if (!file) {
      const stat = this.fdStat(fd);
      if (!stat) {
        return ERRNO_BADF;
      }
      return stat.filetype === WASI_FILETYPE_DIRECTORY
        ? ERRNO_ISDIR
        : ERRNO_NOTCAPABLE;
    }
    if (isOpenDirectory(file)) {
      return ERRNO_ISDIR;
    }
    if (!canAllocateFile(file)) {
      return ERRNO_NOTCAPABLE;
    }
    const allocation = resolveFileAllocation(offset, length);
    if (allocation.errno != null) {
      return allocation.errno;
    }
    if (
      allocation.size != null &&
      allocation.size > file.record.bytes.byteLength
    ) {
      if (resizeOpenFile(file, allocation.size)) {
        this.markOpenFileDirty(file);
      }
    }
    return ERRNO_SUCCESS;
  }

  fdAdvise(fd, offset, length, advice) {
    this.throwIfAborted();
    const file = this.openFiles.get(fd);
    if (!file) {
      const stat = this.fdStat(fd);
      if (!stat) {
        return ERRNO_BADF;
      }
      return stat.filetype === WASI_FILETYPE_DIRECTORY
        ? ERRNO_ISDIR
        : ERRNO_NOTCAPABLE;
    }
    if (isOpenDirectory(file)) {
      return ERRNO_ISDIR;
    }
    if ((file.rights & WASI_RIGHT_FD_ADVISE) === 0n) {
      return ERRNO_NOTCAPABLE;
    }
    if (!isSupportedAdvice(advice)) {
      return ERRNO_INVAL;
    }
    const range = resolveFileRange(offset, length);
    if (range.errno != null) {
      return range.errno;
    }
    return ERRNO_SUCCESS;
  }

  fdSync(fd, requiredRight) {
    this.throwIfAborted();
    const file = this.openFiles.get(fd);
    if (!file) {
      const stat = this.fdStat(fd);
      if (!stat) {
        return ERRNO_BADF;
      }
      return stat.filetype === WASI_FILETYPE_DIRECTORY
        ? ERRNO_ISDIR
        : ERRNO_NOTCAPABLE;
    }
    if (isOpenDirectory(file)) {
      return ERRNO_ISDIR;
    }
    return file.writable && (file.rights & requiredRight) !== 0n
      ? ERRNO_SUCCESS
      : ERRNO_NOTCAPABLE;
  }

  directoryForFd(fd) {
    const packageRootBase = this.packageRootBasePath(fd);
    if (packageRootBase != null) {
      return {
        entries: () => this.packageRootDirectoryEntries(packageRootBase),
      };
    }
    const workspaceBase = this.workspaceBasePath(fd);
    if (workspaceBase != null) {
      return { entries: () => this.workspaceDirectoryEntries(workspaceBase) };
    }
    if (fd === TMP_FD) {
      return { entries: () => this.scratchDirectoryEntries("") };
    }
    const file = this.openFiles.get(fd);
    if (isOpenScratchDirectory(file) && file.path != null) {
      return { entries: () => this.scratchDirectoryEntries(file.path) };
    }
    return null;
  }

  pathFilestatGet(fd, flags, pathPtr, pathLen, filestatPtr) {
    this.throwIfAborted();
    if ((flags & ~WASI_LOOKUP_SYMLINK_FOLLOW) !== 0) {
      return ERRNO_INVAL;
    }

    const path = this.readString(pathPtr, pathLen);
    const stat =
      this.packageRootPathStat(fd, path) ??
      this.workspacePathStat(fd, path) ??
      this.scratchPathStat(fd, path);
    if (stat == null) {
      return this.fdStat(fd) ? ERRNO_ACCESS : ERRNO_BADF;
    }
    if (stat.errno != null) {
      return stat.errno;
    }
    this.writeFilestat(filestatPtr, stat.filetype, stat.size ?? 0);
    return ERRNO_SUCCESS;
  }

  pathFilestatSetTimes(fd, flags, pathPtr, pathLen, _atim, _mtim, fstFlags) {
    this.throwIfAborted();
    if (
      (flags & ~WASI_LOOKUP_SYMLINK_FOLLOW) !== 0 ||
      !isSupportedFilestatSetTimesFlags(fstFlags)
    ) {
      return ERRNO_INVAL;
    }

    const workspaceBase = this.workspace.writable
      ? this.workspaceBasePathForRight(fd, WASI_RIGHT_PATH_FILESTAT_SET_TIMES)
      : { errno: ERRNO_BADF };
    if (workspaceBase.value != null) {
      const path = resolveScratchPath(
        workspaceBase.value,
        this.readString(pathPtr, pathLen),
        { lookup: true },
      );
      if (path.errno != null) {
        return path.errno;
      }
      if (
        this.workspaceDirs.has(path.value) ||
        pathHasChildren(this.files, this.workspaceDirs, path.value)
      ) {
        return ERRNO_ISDIR;
      }
      return this.files.has(path.value) ? ERRNO_SUCCESS : ERRNO_NOENT;
    }

    const base = this.scratchBasePathForRight(fd, WASI_RIGHT_PATH_FILESTAT_SET_TIMES);
    if (base.errno != null) {
      return base.errno;
    }

    const path = resolveScratchPath(
      base.value,
      this.readString(pathPtr, pathLen),
      { lookup: true },
    );
    if (path.errno != null) {
      return path.errno;
    }
    if (
      this.scratchDirs.has(path.value) ||
      pathHasChildren(this.scratchFiles, this.scratchDirs, path.value)
    ) {
      return ERRNO_ISDIR;
    }
    return this.scratchFiles.has(path.value) ? ERRNO_SUCCESS : ERRNO_NOENT;
  }

  pathLink(
    oldFd,
    oldFlags,
    oldPathPtr,
    oldPathLen,
    newFd,
    newPathPtr,
    newPathLen,
  ) {
    this.throwIfAborted();
    if ((oldFlags & ~WASI_LOOKUP_SYMLINK_FOLLOW) !== 0) {
      return ERRNO_INVAL;
    }

    const oldStat = this.pathStatForFd(
      oldFd,
      this.readString(oldPathPtr, oldPathLen),
    );
    if (oldStat.errno != null) {
      return oldStat.errno;
    }
    const targetPath = this.resolvePathForFd(
      newFd,
      this.readString(newPathPtr, newPathLen),
    );
    if (targetPath.errno != null) {
      return targetPath.errno;
    }
    return ERRNO_NOTSUP;
  }

  getcwd(pathPtr, pathLenPtr) {
    this.throwIfAborted();
    const memoryLength = this.bytes().byteLength;
    if (checkedMemoryRange(pathLenPtr >>> 0, 4, memoryLength) == null) {
      return ERRNO_FAULT;
    }

    const maxPathLength = this.readU32(pathLenPtr);
    const cwdBytes = encodeText(this.cwd);
    this.writeU32(pathLenPtr, cwdBytes.byteLength);
    if (cwdBytes.byteLength > maxPathLength) {
      return ERRNO_RANGE;
    }
    if ((pathPtr >>> 0) === 0 || maxPathLength === 0) {
      return ERRNO_INVAL;
    }
    if (checkedMemoryRange(pathPtr >>> 0, maxPathLength, memoryLength) == null) {
      return ERRNO_FAULT;
    }

    this.bytes().set(cwdBytes, pathPtr);
    return ERRNO_SUCCESS;
  }

  chdir(pathPtr, pathLen) {
    this.throwIfAborted();
    const path = resolveWasiVirtualPath(
      this.cwd,
      this.readString(pathPtr, pathLen),
    );
    if (path.errno != null) {
      return path.errno;
    }

    const kind = this.cwdPathKind(path.value);
    if (kind == null) {
      return ERRNO_NOENT;
    }
    if (kind !== "directory") {
      return ERRNO_NOTDIR;
    }

    this.cwd = path.value;
    return ERRNO_SUCCESS;
  }

  cwdPathKind(path) {
    if (path === PACKAGE_ROOT_PREOPEN_PATH) {
      return "directory";
    }

    const workspacePath = mountedRelativePath(path, WORKSPACE_PREOPEN_PATH);
    if (workspacePath != null) {
      return workspacePath === "" ? "directory" : this.workspacePathKind(workspacePath);
    }

    const scratchPath = mountedRelativePath(path, TMP_PREOPEN_PATH);
    if (scratchPath != null) {
      return scratchPath === "" ? "directory" : this.scratchPathKind(scratchPath);
    }

    const packageRootPath = path.startsWith("/")
      ? path.slice(1)
      : path;
    const stat = statPath(
      this.packageRootFiles,
      this.packageRootDirs,
      packageRootPath,
    );
    if (stat.errno != null) {
      return null;
    }
    return stat.filetype === WASI_FILETYPE_DIRECTORY ? "directory" : "file";
  }

  pathReadlink(fd, pathPtr, pathLen, _bufPtr, _bufLen, _bufUsedPtr) {
    this.throwIfAborted();
    const stat = this.pathStatForFd(fd, this.readString(pathPtr, pathLen));
    if (stat.errno != null) {
      return stat.errno;
    }
    return ERRNO_INVAL;
  }

  pathSymlink(oldPathPtr, oldPathLen, fd, newPathPtr, newPathLen) {
    this.throwIfAborted();
    this.readString(oldPathPtr, oldPathLen);
    const targetPath = this.resolvePathForFd(
      fd,
      this.readString(newPathPtr, newPathLen),
    );
    if (targetPath.errno != null) {
      return targetPath.errno;
    }
    return ERRNO_NOTSUP;
  }

  scratchPathStat(fd, pathValue) {
    const base = this.scratchBasePath(fd);
    if (base == null) {
      return null;
    }
    const path = resolveScratchPath(base, pathValue, {
      lookup: true,
    });
    if (path.errno != null) {
      return path;
    }
    return statPath(this.scratchFiles, this.scratchDirs, path.value);
  }

  fdPrestatGet(fd, prestatPtr) {
    this.throwIfAborted();
    const path = this.preopenPath(fd);
    if (!path) {
      return ERRNO_BADF;
    }
    this.writeU32(prestatPtr, WASI_PREOPENTYPE_DIR);
    this.writeU32(prestatPtr + 4, encodeText(path).byteLength);
    return ERRNO_SUCCESS;
  }

  fdPrestatDirName(fd, pathPtr, pathLen) {
    this.throwIfAborted();
    const preopenedPath = this.preopenPath(fd);
    if (!preopenedPath) {
      return ERRNO_BADF;
    }
    const path = encodeText(preopenedPath);
    if ((pathLen >>> 0) < path.byteLength) {
      return ERRNO_INVAL;
    }
    this.bytes().set(path, pathPtr);
    return ERRNO_SUCCESS;
  }

  pathOpen(
    fd,
    dirflags,
    pathPtr,
    pathLen,
    oflags,
    rightsBase,
    rightsInheriting,
    fdflags,
    openedFdPtr,
  ) {
    this.throwIfAborted();
    if ((dirflags & ~WASI_LOOKUP_SYMLINK_FOLLOW) !== 0) {
      return ERRNO_INVAL;
    }
    const workspaceBase = this.mutableWorkspaceBasePath(fd);
    if (workspaceBase != null) {
      return this.openWorkspaceFile(
        workspaceBase,
        pathPtr,
        pathLen,
        oflags,
        rightsBase,
        rightsInheriting,
        fdflags,
        openedFdPtr,
      );
    }
    const scratchBase = this.scratchBasePath(fd);
    if (scratchBase != null) {
      return this.openScratchFile(
        scratchBase,
        pathPtr,
        pathLen,
        oflags,
        rightsBase,
        rightsInheriting,
        fdflags,
        openedFdPtr,
      );
    }
    const packageRootBase = this.packageRootBasePath(fd);
    if (packageRootBase != null) {
      return this.openPackageRootPath(
        packageRootBase,
        pathPtr,
        pathLen,
        oflags,
        rightsBase,
        rightsInheriting,
        fdflags,
        openedFdPtr,
      );
    }
    const readOnlyWorkspaceBase = this.workspaceBasePath(fd);
    if (readOnlyWorkspaceBase == null) {
      return this.fdStat(fd) ? ERRNO_NOTCAPABLE : ERRNO_BADF;
    }
    const path = resolveScratchPath(
      readOnlyWorkspaceBase,
      this.readString(pathPtr, pathLen),
      { lookup: true },
    );
    if (path.errno != null) {
      return path.errno;
    }
    if ((oflags & WASI_OFLAGS_DIRECTORY) !== 0) {
      if (
        (oflags &
          (WASI_OFLAGS_CREAT | WASI_OFLAGS_EXCL | WASI_OFLAGS_TRUNC)) !== 0 ||
        (fdflags & WASI_FDFLAGS_APPEND) !== 0
      ) {
        return ERRNO_NOTCAPABLE;
      }
      return this.openReadOnlyWorkspaceDirectory(
        path.value,
        BigInt(rightsBase),
        rightsInheriting,
        fdflags,
        openedFdPtr,
      );
    }
    if (
      (oflags &
        (WASI_OFLAGS_CREAT |
          WASI_OFLAGS_DIRECTORY |
          WASI_OFLAGS_EXCL |
          WASI_OFLAGS_TRUNC)) !== 0 ||
      (fdflags & WASI_FDFLAGS_APPEND) !== 0 ||
      requestsWriteRights(rightsBase) ||
      requestsWriteRights(rightsInheriting)
    ) {
      return ERRNO_NOTCAPABLE;
    }
    if (!path.value) {
      return ERRNO_NOTCAPABLE;
    }
    const file = this.files.get(path.value);
    if (!file) {
      return ERRNO_NOENT;
    }
    const openedFd = this.nextFileFd;
    this.nextFileFd += 1;
    this.openFiles.set(openedFd, {
      offset: 0,
      path: path.value,
      record: file,
      rights: WASI_REGULAR_FILE_RIGHTS,
      fdflags: 0,
      writable: false,
    });
    this.writeU32(openedFdPtr, openedFd);
    return ERRNO_SUCCESS;
  }

  pathOpen2(
    fd,
    dirflags,
    pathPtr,
    pathLen,
    oflags,
    rightsBase,
    rightsInheriting,
    fdflags,
    fdFlagsExt,
    openedFdPtr,
  ) {
    if ((fdFlagsExt & ~WASIX_FDFLAGSEXT_MASK) !== 0) {
      return ERRNO_INVAL;
    }
    const errno = this.pathOpen(
      fd,
      dirflags,
      pathPtr,
      pathLen,
      oflags,
      rightsBase,
      rightsInheriting,
      fdflags,
      openedFdPtr,
    );
    if (errno === ERRNO_SUCCESS && fdFlagsExt !== 0) {
      this.fdFlagsExt.set(this.readU32(openedFdPtr), fdFlagsExt);
    }
    return errno;
  }

  openPackageRootPath(
    basePath,
    pathPtr,
    pathLen,
    oflags,
    rightsBase,
    rightsInheriting,
    fdflags,
    openedFdPtr,
  ) {
    const requestedRights = BigInt(rightsBase);
    const pathText = this.readString(pathPtr, pathLen);
    const virtualPath = rootVirtualMountPath(basePath, pathText);
    if (virtualPath?.errno != null) {
      return virtualPath.errno;
    }
    if (virtualPath?.mount === "workspace") {
      if ((oflags & WASI_OFLAGS_DIRECTORY) === 0) {
        return ERRNO_NOTCAPABLE;
      }
      if (!this.workspace.writable) {
        return this.openReadOnlyWorkspaceDirectory(
          virtualPath.path,
          requestedRights,
          rightsInheriting,
          fdflags,
          openedFdPtr,
        );
      }
      return this.openWorkspaceDirectory(
        virtualPath.path,
        requestedRights,
        rightsInheriting,
        fdflags,
        openedFdPtr,
      );
    }
    if (virtualPath?.mount === "scratch") {
      if ((oflags & WASI_OFLAGS_DIRECTORY) === 0) {
        return ERRNO_NOTCAPABLE;
      }
      return this.openScratchDirectory(
        virtualPath.path,
        requestedRights,
        rightsInheriting,
        fdflags,
        openedFdPtr,
      );
    }
    const path = resolvePackageRootPath(basePath, pathText);
    if (path.errno != null) {
      return path.errno;
    }
    if ((oflags & WASI_OFLAGS_DIRECTORY) !== 0) {
      return this.openPackageRootDirectory(
        path.value,
        requestedRights,
        rightsInheriting,
        fdflags,
        openedFdPtr,
      );
    }
    if (
      (oflags &
        (WASI_OFLAGS_CREAT | WASI_OFLAGS_EXCL | WASI_OFLAGS_TRUNC)) !== 0 ||
      (fdflags & WASI_FDFLAGS_APPEND) !== 0 ||
      requestsWriteRights(rightsBase) ||
      requestsWriteRights(rightsInheriting)
    ) {
      return ERRNO_NOTCAPABLE;
    }
    if (!allowsRights(requestedRights, WASI_REGULAR_FILE_RIGHTS)) {
      return ERRNO_NOTCAPABLE;
    }
    if (
      this.packageRootDirs.has(path.value) ||
      pathHasChildren(this.packageRootFiles, this.packageRootDirs, path.value)
    ) {
      return ERRNO_ISDIR;
    }
    const file = this.packageRootFiles.get(path.value);
    if (!file) {
      return ERRNO_NOENT;
    }
    const openedFd = this.nextFileFd;
    this.nextFileFd += 1;
    this.openFiles.set(openedFd, {
      fdflags: 0,
      mount: "package-root",
      offset: 0,
      path: path.value,
      record: file,
      rights:
        requestedRights === 0n ? WASI_REGULAR_FILE_RIGHTS : requestedRights,
      writable: false,
    });
    this.writeU32(openedFdPtr, openedFd);
    return ERRNO_SUCCESS;
  }

  openPackageRootDirectory(
    path,
    requestedRights,
    rightsInheriting,
    fdflags,
    openedFdPtr,
  ) {
    if (fdflags !== 0) {
      return ERRNO_INVAL;
    }
    if (
      !allowsRights(requestedRights, WASI_WORKSPACE_RIGHTS) ||
      !allowsRights(BigInt(rightsInheriting), WASI_REGULAR_FILE_RIGHTS)
    ) {
      return ERRNO_NOTCAPABLE;
    }
    if (this.packageRootFiles.has(path)) {
      return ERRNO_NOTDIR;
    }
    if (
      !this.packageRootDirs.has(path) &&
      !pathHasChildren(this.packageRootFiles, this.packageRootDirs, path)
    ) {
      return ERRNO_NOENT;
    }

    const openedFd = this.nextFileFd;
    this.nextFileFd += 1;
    this.openFiles.set(openedFd, {
      fdflags,
      inheriting: BigInt(rightsInheriting),
      kind: "directory",
      mount: "package-root",
      offset: 0,
      path,
      rights: requestedRights,
    });
    this.writeU32(openedFdPtr, openedFd);
    return ERRNO_SUCCESS;
  }

  openScratchFile(
    basePath,
    pathPtr,
    pathLen,
    oflags,
    rightsBase,
    rightsInheriting,
    fdflags,
    openedFdPtr,
  ) {
    if ((fdflags & ~WASI_FDFLAGS_APPEND) !== 0) {
      return ERRNO_INVAL;
    }
    const requestedRights = BigInt(rightsBase);
    const path = resolveScratchPath(
      basePath,
      this.readString(pathPtr, pathLen),
    );
    if (path.errno != null) {
      return path.errno;
    }
    if ((oflags & WASI_OFLAGS_DIRECTORY) !== 0) {
      return this.openScratchDirectory(
        path.value,
        requestedRights,
        rightsInheriting,
        fdflags,
        openedFdPtr,
      );
    }
    if (
      !allowsRights(requestedRights, WASI_SCRATCH_FILE_RIGHTS) ||
      !allowsRights(BigInt(rightsInheriting), WASI_SCRATCH_FILE_RIGHTS)
    ) {
      return ERRNO_NOTCAPABLE;
    }
    const wantsWrite =
      (requestedRights & (WASI_RIGHT_FD_WRITE | WASI_RIGHT_FD_ALLOCATE)) !== 0n;
    const wantsCreate = (oflags & WASI_OFLAGS_CREAT) !== 0;
    const wantsTruncate = (oflags & WASI_OFLAGS_TRUNC) !== 0;
    if ((wantsCreate || wantsTruncate) && !wantsWrite) {
      return ERRNO_NOTCAPABLE;
    }

    if (
      this.scratchDirs.has(path.value) ||
      pathHasChildren(this.scratchFiles, this.scratchDirs, path.value)
    ) {
      return ERRNO_ISDIR;
    }
    const parent = scratchParentStatus(
      this.scratchFiles,
      this.scratchDirs,
      path.value,
    );
    if (parent.errno != null) {
      return parent.errno;
    }
    let file = this.scratchFiles.get(path.value);
    if (!file) {
      if (!wantsCreate) {
        return ERRNO_NOENT;
      }
      file = { bytes: new Uint8Array(), path: path.value };
      this.scratchFiles.set(path.value, file);
    } else if (wantsCreate && (oflags & WASI_OFLAGS_EXCL) !== 0) {
      return ERRNO_EXIST;
    }
    if (wantsTruncate) {
      file.bytes = new Uint8Array();
    }

    const openedFd = this.nextFileFd;
    this.nextFileFd += 1;
    this.openFiles.set(openedFd, {
      fdflags,
      offset:
        (fdflags & WASI_FDFLAGS_APPEND) !== 0 ? file.bytes.byteLength : 0,
      path: path.value,
      record: file,
      rights: requestedRights,
      writable: true,
    });
    this.writeU32(openedFdPtr, openedFd);
    return ERRNO_SUCCESS;
  }

  openScratchDirectory(
    path,
    requestedRights,
    rightsInheriting,
    fdflags,
    openedFdPtr,
  ) {
    if (fdflags !== 0) {
      return ERRNO_INVAL;
    }
    if (
      !allowsRights(requestedRights, WASI_TMP_RIGHTS) ||
      !allowsRights(BigInt(rightsInheriting), WASI_SCRATCH_FILE_RIGHTS)
    ) {
      return ERRNO_NOTCAPABLE;
    }
    if (this.scratchFiles.has(path)) {
      return ERRNO_NOTDIR;
    }
    if (
      !this.scratchDirs.has(path) &&
      !pathHasChildren(this.scratchFiles, this.scratchDirs, path)
    ) {
      return ERRNO_NOENT;
    }

    const openedFd = this.nextFileFd;
    this.nextFileFd += 1;
    this.openFiles.set(openedFd, {
      fdflags,
      kind: "directory",
      inheriting: BigInt(rightsInheriting),
      offset: 0,
      path,
      rights: requestedRights,
    });
    this.writeU32(openedFdPtr, openedFd);
    return ERRNO_SUCCESS;
  }

  openWorkspaceFile(
    basePath,
    pathPtr,
    pathLen,
    oflags,
    rightsBase,
    rightsInheriting,
    fdflags,
    openedFdPtr,
  ) {
    if ((fdflags & ~WASI_FDFLAGS_APPEND) !== 0) {
      return ERRNO_INVAL;
    }
    const requestedRights = BigInt(rightsBase);
    const path = resolveScratchPath(
      basePath,
      this.readString(pathPtr, pathLen),
    );
    if (path.errno != null) {
      return path.errno;
    }
    if ((oflags & WASI_OFLAGS_DIRECTORY) !== 0) {
      return this.openWorkspaceDirectory(
        path.value,
        requestedRights,
        rightsInheriting,
        fdflags,
        openedFdPtr,
      );
    }
    if (
      !allowsRights(requestedRights, WASI_SCRATCH_FILE_RIGHTS) ||
      !allowsRights(BigInt(rightsInheriting), WASI_SCRATCH_FILE_RIGHTS)
    ) {
      return ERRNO_NOTCAPABLE;
    }
    const wantsWrite =
      (requestedRights & (WASI_RIGHT_FD_WRITE | WASI_RIGHT_FD_ALLOCATE)) !== 0n;
    const wantsCreate = (oflags & WASI_OFLAGS_CREAT) !== 0;
    const wantsTruncate = (oflags & WASI_OFLAGS_TRUNC) !== 0;
    if ((wantsCreate || wantsTruncate) && !wantsWrite) {
      return ERRNO_NOTCAPABLE;
    }

    if (
      this.workspaceDirs.has(path.value) ||
      pathHasChildren(this.files, this.workspaceDirs, path.value)
    ) {
      return ERRNO_ISDIR;
    }
    const parent = scratchParentStatus(
      this.files,
      this.workspaceDirs,
      path.value,
    );
    if (parent.errno != null) {
      return parent.errno;
    }
    let file = this.files.get(path.value);
    let mutated = false;
    if (!file) {
      if (!wantsCreate) {
        return ERRNO_NOENT;
      }
      file = { bytes: new Uint8Array(), path: path.value };
      this.files.set(path.value, file);
      mutated = true;
    } else if (wantsCreate && (oflags & WASI_OFLAGS_EXCL) !== 0) {
      return ERRNO_EXIST;
    }
    if (wantsTruncate) {
      file.bytes = new Uint8Array();
      file.fallback = false;
      mutated = true;
    }
    if (mutated) {
      this.markWorkspaceDirty();
    }

    const openedFd = this.nextFileFd;
    this.nextFileFd += 1;
    this.openFiles.set(openedFd, {
      fdflags,
      mount: "workspace",
      offset:
        (fdflags & WASI_FDFLAGS_APPEND) !== 0 ? file.bytes.byteLength : 0,
      path: path.value,
      record: file,
      rights: requestedRights,
      writable: true,
    });
    this.writeU32(openedFdPtr, openedFd);
    return ERRNO_SUCCESS;
  }

  openWorkspaceDirectory(
    path,
    requestedRights,
    rightsInheriting,
    fdflags,
    openedFdPtr,
  ) {
    if (fdflags !== 0) {
      return ERRNO_INVAL;
    }
    if (
      !allowsRights(requestedRights, WASI_WRITABLE_WORKSPACE_RIGHTS) ||
      !allowsRights(BigInt(rightsInheriting), WASI_SCRATCH_FILE_RIGHTS)
    ) {
      return ERRNO_NOTCAPABLE;
    }
    if (this.files.has(path)) {
      return ERRNO_NOTDIR;
    }
    if (
      path !== "" &&
      !(this.workspaceDirs?.has(path) ?? false) &&
      !pathHasChildren(this.files, this.workspaceDirs, path)
    ) {
      return ERRNO_NOENT;
    }

    const openedFd = this.nextFileFd;
    this.nextFileFd += 1;
    this.openFiles.set(openedFd, {
      fdflags,
      kind: "directory",
      mount: "workspace",
      inheriting: BigInt(rightsInheriting),
      offset: 0,
      path,
      rights: requestedRights,
    });
    this.writeU32(openedFdPtr, openedFd);
    return ERRNO_SUCCESS;
  }

  openReadOnlyWorkspaceDirectory(
    path,
    requestedRights,
    rightsInheriting,
    fdflags,
    openedFdPtr,
  ) {
    if (fdflags !== 0) {
      return ERRNO_INVAL;
    }
    if (this.files.has(path)) {
      return ERRNO_NOTDIR;
    }
    if (
      path !== "" &&
      !(this.workspaceDirs?.has(path) ?? false) &&
      !pathHasChildren(this.files, this.workspaceDirs, path)
    ) {
      return ERRNO_NOENT;
    }

    const openedFd = this.nextFileFd;
    this.nextFileFd += 1;
    this.openFiles.set(openedFd, {
      fdflags,
      inheriting: BigInt(rightsInheriting) & WASI_REGULAR_FILE_RIGHTS,
      kind: "directory",
      mount: "workspace",
      offset: 0,
      path,
      rights:
        requestedRights === 0n
          ? WASI_WORKSPACE_RIGHTS
          : requestedRights & WASI_WORKSPACE_RIGHTS,
    });
    this.writeU32(openedFdPtr, openedFd);
    return ERRNO_SUCCESS;
  }

  pathCreateDirectory(fd, pathPtr, pathLen) {
    this.throwIfAborted();
    const workspaceBase = this.mutableWorkspaceBasePath(fd);
    if (workspaceBase != null) {
      return this.createWorkspaceDirectory(workspaceBase, pathPtr, pathLen);
    }
    const base = this.scratchBasePath(fd);
    if (base == null) {
      return this.fdStat(fd) ? ERRNO_NOTCAPABLE : ERRNO_BADF;
    }
    const path = resolveScratchPath(base, this.readString(pathPtr, pathLen));
    if (path.errno != null) {
      return path.errno;
    }
    if (this.scratchDirs.has(path.value) || this.scratchFiles.has(path.value)) {
      return ERRNO_EXIST;
    }
    const parent = scratchParentStatus(
      this.scratchFiles,
      this.scratchDirs,
      path.value,
    );
    if (parent.errno != null) {
      return parent.errno;
    }
    this.scratchDirs.add(path.value);
    return ERRNO_SUCCESS;
  }

  createWorkspaceDirectory(base, pathPtr, pathLen) {
    const path = resolveScratchPath(base, this.readString(pathPtr, pathLen));
    if (path.errno != null) {
      return path.errno;
    }
    if (this.workspaceDirs.has(path.value) || this.files.has(path.value)) {
      return ERRNO_EXIST;
    }
    const parent = scratchParentStatus(
      this.files,
      this.workspaceDirs,
      path.value,
    );
    if (parent.errno != null) {
      return parent.errno;
    }
    this.workspaceDirs.add(path.value);
    this.markWorkspaceDirty();
    return ERRNO_SUCCESS;
  }

  pathUnlinkFile(fd, pathPtr, pathLen) {
    this.throwIfAborted();
    const workspaceBase = this.mutableWorkspaceBasePath(fd);
    if (workspaceBase != null) {
      return this.unlinkWorkspaceFile(workspaceBase, pathPtr, pathLen);
    }
    const base = this.scratchBasePath(fd);
    if (base == null) {
      return this.fdStat(fd) ? ERRNO_NOTCAPABLE : ERRNO_BADF;
    }
    const path = resolveScratchPath(base, this.readString(pathPtr, pathLen));
    if (path.errno != null) {
      return path.errno;
    }
    if (
      this.scratchDirs.has(path.value) ||
      pathHasChildren(this.scratchFiles, this.scratchDirs, path.value)
    ) {
      return ERRNO_ISDIR;
    }
    if (!this.scratchFiles.has(path.value)) {
      return ERRNO_NOENT;
    }
    this.scratchFiles.delete(path.value);
    return ERRNO_SUCCESS;
  }

  unlinkWorkspaceFile(base, pathPtr, pathLen) {
    const path = resolveScratchPath(base, this.readString(pathPtr, pathLen));
    if (path.errno != null) {
      return path.errno;
    }
    if (
      this.workspaceDirs.has(path.value) ||
      pathHasChildren(this.files, this.workspaceDirs, path.value)
    ) {
      return ERRNO_ISDIR;
    }
    if (!this.files.has(path.value)) {
      return ERRNO_NOENT;
    }
    this.detachOpenWorkspaceFile(path.value);
    this.files.delete(path.value);
    this.markWorkspaceDirty();
    return ERRNO_SUCCESS;
  }

  pathRemoveDirectory(fd, pathPtr, pathLen) {
    this.throwIfAborted();
    const workspaceBase = this.mutableWorkspaceBasePath(fd);
    if (workspaceBase != null) {
      return this.removeWorkspaceDirectory(workspaceBase, pathPtr, pathLen);
    }
    const base = this.scratchBasePath(fd);
    if (base == null) {
      return this.fdStat(fd) ? ERRNO_NOTCAPABLE : ERRNO_BADF;
    }
    const path = resolveScratchPath(base, this.readString(pathPtr, pathLen));
    if (path.errno != null) {
      return path.errno;
    }
    if (path.value === base) {
      return ERRNO_NOTCAPABLE;
    }
    if (this.scratchFiles.has(path.value)) {
      return ERRNO_NOTDIR;
    }
    const parent = scratchParentStatus(
      this.scratchFiles,
      this.scratchDirs,
      path.value,
    );
    if (parent.errno != null) {
      return parent.errno;
    }
    const hasChildren = pathHasChildren(
      this.scratchFiles,
      this.scratchDirs,
      path.value,
    );
    if (!this.scratchDirs.has(path.value)) {
      return hasChildren ? ERRNO_NOTEMPTY : ERRNO_NOENT;
    }
    if (hasChildren) {
      return ERRNO_NOTEMPTY;
    }
    this.scratchDirs.delete(path.value);
    return ERRNO_SUCCESS;
  }

  removeWorkspaceDirectory(base, pathPtr, pathLen) {
    const path = resolveScratchPath(base, this.readString(pathPtr, pathLen));
    if (path.errno != null) {
      return path.errno;
    }
    if (path.value === base) {
      return ERRNO_NOTCAPABLE;
    }
    if (this.files.has(path.value)) {
      return ERRNO_NOTDIR;
    }
    const parent = scratchParentStatus(
      this.files,
      this.workspaceDirs,
      path.value,
    );
    if (parent.errno != null) {
      return parent.errno;
    }
    const hasChildren = pathHasChildren(
      this.files,
      this.workspaceDirs,
      path.value,
    );
    if (!this.workspaceDirs.has(path.value)) {
      return hasChildren ? ERRNO_NOTEMPTY : ERRNO_NOENT;
    }
    if (hasChildren) {
      return ERRNO_NOTEMPTY;
    }
    this.detachOpenWorkspaceDirectory(path.value);
    this.workspaceDirs.delete(path.value);
    this.markWorkspaceDirty();
    return ERRNO_SUCCESS;
  }

  pathRename(oldFd, oldPathPtr, oldPathLen, newFd, newPathPtr, newPathLen) {
    this.throwIfAborted();
    const workspaceRename = this.renameWorkspacePath(
      oldFd,
      oldPathPtr,
      oldPathLen,
      newFd,
      newPathPtr,
      newPathLen,
    );
    if (workspaceRename != null) {
      return workspaceRename;
    }
    const sourceBase = this.scratchBasePathForRight(
      oldFd,
      WASI_RIGHT_PATH_RENAME_SOURCE,
    );
    if (sourceBase.errno != null) {
      return sourceBase.errno;
    }
    const targetBase = this.scratchBasePathForRight(
      newFd,
      WASI_RIGHT_PATH_RENAME_TARGET,
    );
    if (targetBase.errno != null) {
      return targetBase.errno;
    }

    const source = resolveScratchPath(
      sourceBase.value,
      this.readString(oldPathPtr, oldPathLen),
    );
    if (source.errno != null) {
      return source.errno;
    }
    const target = resolveScratchPath(
      targetBase.value,
      this.readString(newPathPtr, newPathLen),
    );
    if (target.errno != null) {
      return target.errno;
    }
    if (source.value === target.value) {
      return this.scratchPathExists(source.value) ? ERRNO_SUCCESS : ERRNO_NOENT;
    }

    const sourceKind = this.scratchPathKind(source.value);
    if (sourceKind == null) {
      return ERRNO_NOENT;
    }
    if (
      sourceKind === "directory" &&
      target.value.startsWith(`${source.value}/`)
    ) {
      return ERRNO_INVAL;
    }

    const targetKind = this.scratchPathKind(target.value);
    if (targetKind == null) {
      const targetParent = scratchParentStatus(
        this.scratchFiles,
        this.scratchDirs,
        target.value,
      );
      if (targetParent.errno != null) {
        return targetParent.errno;
      }
    } else if (sourceKind === "file") {
      if (targetKind === "directory") {
        return ERRNO_ISDIR;
      }
    } else if (targetKind === "file") {
      return ERRNO_NOTDIR;
    } else if (
      pathHasChildren(this.scratchFiles, this.scratchDirs, target.value)
    ) {
      return ERRNO_NOTEMPTY;
    }

    if (sourceKind === "file") {
      this.renameScratchFile(source.value, target.value);
    } else {
      this.renameScratchDirectory(source.value, target.value);
    }
    return ERRNO_SUCCESS;
  }

  renameWorkspacePath(
    oldFd,
    oldPathPtr,
    oldPathLen,
    newFd,
    newPathPtr,
    newPathLen,
  ) {
    if (
      !this.workspace.writable ||
      (!this.isWorkspaceFd(oldFd) && !this.isWorkspaceFd(newFd))
    ) {
      return null;
    }
    if (!this.isWorkspaceFd(oldFd) || !this.isWorkspaceFd(newFd)) {
      return this.fdStat(oldFd) && this.fdStat(newFd)
        ? ERRNO_NOTCAPABLE
        : ERRNO_BADF;
    }

    const sourceBase = this.workspaceBasePathForRight(
      oldFd,
      WASI_RIGHT_PATH_RENAME_SOURCE,
    );
    if (sourceBase.errno != null) {
      return sourceBase.errno;
    }
    const targetBase = this.workspaceBasePathForRight(
      newFd,
      WASI_RIGHT_PATH_RENAME_TARGET,
    );
    if (targetBase.errno != null) {
      return targetBase.errno;
    }

    const source = resolveScratchPath(
      sourceBase.value,
      this.readString(oldPathPtr, oldPathLen),
    );
    if (source.errno != null) {
      return source.errno;
    }
    const target = resolveScratchPath(
      targetBase.value,
      this.readString(newPathPtr, newPathLen),
    );
    if (target.errno != null) {
      return target.errno;
    }
    if (!source.value || !target.value) {
      return ERRNO_NOTCAPABLE;
    }
    if (source.value === target.value) {
      return this.workspacePathExists(source.value) ? ERRNO_SUCCESS : ERRNO_NOENT;
    }

    const sourceKind = this.workspacePathKind(source.value);
    if (sourceKind == null) {
      return ERRNO_NOENT;
    }
    if (
      sourceKind === "directory" &&
      target.value.startsWith(`${source.value}/`)
    ) {
      return ERRNO_INVAL;
    }

    const targetKind = this.workspacePathKind(target.value);
    if (targetKind == null) {
      const targetParent = scratchParentStatus(
        this.files,
        this.workspaceDirs,
        target.value,
      );
      if (targetParent.errno != null) {
        return targetParent.errno;
      }
    } else if (sourceKind === "file") {
      if (targetKind === "directory") {
        return ERRNO_ISDIR;
      }
    } else if (targetKind === "file") {
      return ERRNO_NOTDIR;
    } else if (pathHasChildren(this.files, this.workspaceDirs, target.value)) {
      return ERRNO_NOTEMPTY;
    }

    if (sourceKind === "file") {
      this.renameWorkspaceFile(source.value, target.value);
    } else {
      this.renameWorkspaceDirectory(source.value, target.value);
    }
    this.markWorkspaceDirty();
    return ERRNO_SUCCESS;
  }

  scratchBasePathForRight(fd, right) {
    if (fd === TMP_FD) {
      return { value: "" };
    }
    const file = this.openFiles.get(fd);
    if (isOpenScratchDirectory(file)) {
      if (file.path == null) {
        return { errno: ERRNO_NOTCAPABLE };
      }
      if ((file.rights & right) === 0n) {
        return { errno: ERRNO_NOTCAPABLE };
      }
      return { value: file.path };
    }
    return { errno: this.fdStat(fd) ? ERRNO_NOTCAPABLE : ERRNO_BADF };
  }

  workspaceBasePathForRight(fd, right) {
    if (fd === WORKSPACE_FD) {
      return this.workspace.writable ? { value: "" } : { errno: ERRNO_NOTCAPABLE };
    }
    const file = this.openFiles.get(fd);
    if (isOpenWorkspaceDirectory(file)) {
      if (file.path == null) {
        return { errno: ERRNO_NOTCAPABLE };
      }
      if ((file.rights & right) === 0n) {
        return { errno: ERRNO_NOTCAPABLE };
      }
      return { value: file.path };
    }
    return { errno: this.fdStat(fd) ? ERRNO_NOTCAPABLE : ERRNO_BADF };
  }

  scratchPathExists(path) {
    return this.scratchPathKind(path) != null;
  }

  scratchPathKind(path) {
    if (this.scratchFiles.has(path)) {
      return "file";
    }
    if (
      this.scratchDirs.has(path) ||
      pathHasChildren(this.scratchFiles, this.scratchDirs, path)
    ) {
      return "directory";
    }
    return null;
  }

  workspacePathExists(path) {
    return this.workspacePathKind(path) != null;
  }

  workspacePathKind(path) {
    if (this.files.has(path)) {
      return "file";
    }
    if (
      this.workspaceDirs?.has(path) ||
      pathHasChildren(this.files, this.workspaceDirs, path)
    ) {
      return "directory";
    }
    return null;
  }

  packageRootPathStat(fd, pathValue) {
    const base = this.packageRootBasePath(fd);
    if (base == null) {
      return null;
    }
    const pathText = String(pathValue ?? "");
    if (pathText === "") {
      return { errno: ERRNO_NOENT };
    }
    const virtualPath = rootVirtualMountPath(base, pathText);
    if (virtualPath?.errno != null) {
      return virtualPath;
    }
    if (virtualPath?.mount === "workspace") {
      if (virtualPath.path === "") {
        return { filetype: WASI_FILETYPE_DIRECTORY, size: 0 };
      }
      return statPath(this.files, this.workspaceDirs, virtualPath.path);
    }
    if (virtualPath?.mount === "scratch") {
      if (virtualPath.path === "") {
        return { filetype: WASI_FILETYPE_DIRECTORY, size: 0 };
      }
      return statPath(this.scratchFiles, this.scratchDirs, virtualPath.path);
    }
    const path = resolvePackageRootPath(base, pathText);
    if (path.errno != null) {
      return path;
    }
    if (path.value === "") {
      return {
        filetype: WASI_FILETYPE_DIRECTORY,
        size: 0,
      };
    }
    return statPath(this.packageRootFiles, this.packageRootDirs, path.value);
  }

  renameScratchFile(sourcePath, targetPath) {
    const file = this.scratchFiles.get(sourcePath);
    const replacedFile = this.scratchFiles.get(targetPath);
    if (replacedFile && replacedFile !== file) {
      replacedFile.path = null;
    }
    this.scratchFiles.delete(sourcePath);
    file.path = targetPath;
    this.scratchFiles.set(targetPath, file);
    for (const openFile of this.openFiles.values()) {
      if (isOpenDirectory(openFile)) {
        continue;
      }
      if (openFile.record === file) {
        openFile.path = targetPath;
      } else if (openFile.record === replacedFile) {
        openFile.path = null;
      }
    }
  }

  renameWorkspaceFile(sourcePath, targetPath) {
    const file = this.files.get(sourcePath);
    const replacedFile = this.files.get(targetPath);
    if (replacedFile && replacedFile !== file) {
      replacedFile.path = null;
    }
    this.files.delete(sourcePath);
    file.fallback = false;
    file.path = targetPath;
    this.files.set(targetPath, file);
    for (const openFile of this.openFiles.values()) {
      if (isOpenDirectory(openFile) || openFile.mount !== "workspace") {
        continue;
      }
      if (openFile.record === file) {
        openFile.path = targetPath;
      } else if (openFile.record === replacedFile) {
        openFile.path = null;
      }
    }
  }

  renameScratchDirectory(sourcePath, targetPath) {
    this.detachOpenScratchDirectory(targetPath);
    this.scratchDirs.delete(targetPath);

    const movedDirs = new Set();
    for (const dir of this.scratchDirs) {
      if (dir === sourcePath || dir.startsWith(`${sourcePath}/`)) {
        movedDirs.add(replacePathPrefix(dir, sourcePath, targetPath));
      } else {
        movedDirs.add(dir);
      }
    }
    this.scratchDirs = movedDirs;

    const movedFiles = new Map();
    for (const [path, file] of this.scratchFiles) {
      if (path === sourcePath || path.startsWith(`${sourcePath}/`)) {
        const nextPath = replacePathPrefix(path, sourcePath, targetPath);
        file.path = nextPath;
        movedFiles.set(nextPath, file);
      } else {
        movedFiles.set(path, file);
      }
    }
    this.scratchFiles = movedFiles;

    for (const openFile of this.openFiles.values()) {
      if (
        openFile.path === sourcePath ||
        openFile.path?.startsWith(`${sourcePath}/`)
      ) {
        openFile.path = replacePathPrefix(openFile.path, sourcePath, targetPath);
      }
    }
  }

  renameWorkspaceDirectory(sourcePath, targetPath) {
    this.detachOpenWorkspaceDirectory(targetPath);
    this.workspaceDirs.delete(targetPath);

    const movedDirs = new Set();
    for (const dir of this.workspaceDirs) {
      if (dir === sourcePath || dir.startsWith(`${sourcePath}/`)) {
        movedDirs.add(replacePathPrefix(dir, sourcePath, targetPath));
      } else {
        movedDirs.add(dir);
      }
    }
    this.workspaceDirs = movedDirs;
    this.workspace.dirs = movedDirs;

    const movedFiles = new Map();
    for (const [path, file] of this.files) {
      if (path === sourcePath || path.startsWith(`${sourcePath}/`)) {
        const nextPath = replacePathPrefix(path, sourcePath, targetPath);
        file.path = nextPath;
        movedFiles.set(nextPath, file);
      } else {
        movedFiles.set(path, file);
      }
    }
    this.files = movedFiles;
    this.workspace.files = movedFiles;

    for (const openFile of this.openFiles.values()) {
      if (
        openFile.mount === "workspace" &&
        (openFile.path === sourcePath ||
          openFile.path?.startsWith(`${sourcePath}/`))
      ) {
        openFile.path = replacePathPrefix(openFile.path, sourcePath, targetPath);
      }
    }
  }

  detachOpenScratchDirectory(path) {
    for (const openFile of this.openFiles.values()) {
      if (isOpenScratchDirectory(openFile) && openFile.path === path) {
        openFile.path = null;
      }
    }
  }

  detachOpenWorkspaceDirectory(path) {
    for (const openFile of this.openFiles.values()) {
      if (isOpenWorkspaceDirectory(openFile) && openFile.path === path) {
        openFile.path = null;
      }
    }
  }

  detachOpenWorkspaceFile(path) {
    for (const openFile of this.openFiles.values()) {
      if (
        openFile.mount === "workspace" &&
        !isOpenDirectory(openFile) &&
        openFile.path === path
      ) {
        openFile.path = null;
      }
    }
  }

  scratchBasePath(fd) {
    if (fd === TMP_FD) {
      return "";
    }
    const file = this.openFiles.get(fd);
    return isOpenScratchDirectory(file) && file.path != null ? file.path : null;
  }

  packageRootBasePath(fd) {
    if (fd === this.packageRootFd) {
      return "";
    }
    const file = this.openFiles.get(fd);
    return isOpenPackageRootDirectory(file) && file.path != null
      ? file.path
      : null;
  }

  workspaceBasePath(fd) {
    if (fd === WORKSPACE_FD) {
      return "";
    }
    const file = this.openFiles.get(fd);
    return isOpenWorkspaceDirectory(file) && file.path != null ? file.path : null;
  }

  mutableWorkspaceBasePath(fd) {
    if (!this.workspace.writable) {
      return null;
    }
    return this.workspaceBasePath(fd);
  }

  isWorkspaceFd(fd) {
    return fd === WORKSPACE_FD || isOpenWorkspaceDirectory(this.openFiles.get(fd));
  }

  pathStat(fd, pathValue) {
    const packageRootStat = this.packageRootPathStat(fd, pathValue);
    if (packageRootStat != null) {
      return packageRootStat;
    }
    const workspaceStat = this.workspacePathStat(fd, pathValue);
    if (workspaceStat != null) {
      return workspaceStat;
    }
    const scratchStat = this.scratchPathStat(fd, pathValue);
    if (scratchStat != null) {
      return scratchStat;
    }
    return { errno: this.fdStat(fd) ? ERRNO_NOTCAPABLE : ERRNO_BADF };
  }

  workspacePathStat(fd, pathValue) {
    const base = this.workspaceBasePath(fd);
    if (base == null) {
      return null;
    }
    const pathText = String(pathValue ?? "");
    if (pathText === "") {
      return { errno: ERRNO_NOENT };
    }
    const path = resolveScratchPath(base, pathText, { lookup: true });
    if (path.errno != null) {
      return path;
    }
    if (path.value === "") {
      return {
        filetype: WASI_FILETYPE_DIRECTORY,
        size: 0,
      };
    }
    return statPath(this.files, this.workspaceDirs, path.value);
  }

  workspaceDirectoryEntries(path = "") {
    return directoryEntries(this.files, this.workspaceDirs, path);
  }

  scratchDirectoryEntries(path) {
    return directoryEntries(this.scratchFiles, this.scratchDirs, path);
  }

  fdStat(fd) {
    const stdioRightsValue = stdioRights(fd);
    if (stdioRightsValue != null) {
      return {
        filetype: WASI_FILETYPE_CHARACTER_DEVICE,
        inheriting: 0n,
        rights: stdioRightsValue,
        size: 0,
      };
    }
    if (fd === WORKSPACE_FD) {
      return {
        filetype: WASI_FILETYPE_DIRECTORY,
        inheriting: this.workspace.writable
          ? WASI_SCRATCH_FILE_RIGHTS
          : WASI_REGULAR_FILE_RIGHTS,
        rights: this.workspace.writable
          ? WASI_WRITABLE_WORKSPACE_RIGHTS
          : WASI_WORKSPACE_RIGHTS,
        size: 0,
      };
    }
    if (fd === TMP_FD) {
      return {
        filetype: WASI_FILETYPE_DIRECTORY,
        inheriting: WASI_SCRATCH_FILE_RIGHTS,
        rights: WASI_TMP_RIGHTS,
        size: 0,
      };
    }
    if (fd === this.packageRootFd) {
      return {
        filetype: WASI_FILETYPE_DIRECTORY,
        inheriting: WASI_REGULAR_FILE_RIGHTS,
        rights: WASI_WORKSPACE_RIGHTS,
        size: 0,
      };
    }
    const file = this.openFiles.get(fd);
    if (file) {
      if (isOpenStdio(file) || isOpenPipe(file)) {
        return {
          filetype: WASI_FILETYPE_CHARACTER_DEVICE,
          inheriting: 0n,
          rights: file.rights,
          size:
            isOpenPipe(file) && file.direction === "read"
              ? file.pipe.bytes.byteLength
              : 0,
        };
      }
      if (isOpenDirectory(file)) {
        return {
          filetype: WASI_FILETYPE_DIRECTORY,
          inheriting: file.inheriting ?? WASI_SCRATCH_FILE_RIGHTS,
          rights: file.rights,
          size: 0,
        };
      }
      return {
        filetype: WASI_FILETYPE_REGULAR_FILE,
        inheriting: 0n,
        rights: file.rights,
        size: file.record.bytes.byteLength,
      };
    }
    return null;
  }

  pathStatForFd(fd, pathValue) {
    const stat = this.pathStat(fd, pathValue);
    if (stat == null) {
      return { errno: this.fdStat(fd) ? ERRNO_NOTCAPABLE : ERRNO_BADF };
    }
    return stat;
  }

  resolvePathForFd(fd, pathValue) {
    const packageRootBase = this.packageRootBasePath(fd);
    if (packageRootBase != null) {
      return resolvePackageRootPath(packageRootBase, pathValue);
    }
    const workspaceBase = this.workspaceBasePath(fd);
    if (workspaceBase != null) {
      return resolveScratchPath(workspaceBase, pathValue, { lookup: true });
    }
    const base = this.scratchBasePath(fd);
    if (base == null) {
      return { errno: this.fdStat(fd) ? ERRNO_NOTCAPABLE : ERRNO_BADF };
    }
    return resolveScratchPath(base, pathValue, { lookup: true });
  }

  markWorkspaceDirty() {
    if (this.workspace.writable) {
      this.workspace.dirty = true;
    }
  }

  packageRootDirectoryEntries(path = "") {
    return directoryEntries(this.packageRootFiles, this.packageRootDirs, path);
  }

  preopenPath(fd) {
    if (fd === this.packageRootFd) {
      return PACKAGE_ROOT_PREOPEN_PATH;
    }
    const file = this.openFiles.get(fd);
    if (isOpenDirectory(file) && file.preopenPath) {
      return file.preopenPath;
    }
    return preopenPath(fd);
  }

  markOpenFileDirty(file) {
    if (file?.mount === "workspace") {
      file.record.fallback = false;
      this.markWorkspaceDirty();
    }
  }

  readString(ptr, length) {
    return decodeText(this.bytes().slice(ptr, ptr + (length >>> 0)));
  }

  remainingStdinBytes() {
    return this.stdin.slice(this.stdinOffset);
  }

  writeFilestat(ptr, filetype, size) {
    this.writeU64(ptr, 0n);
    this.writeU64(ptr + 8, 0n);
    this.writeU8(ptr + 16, filetype);
    this.writeU8(ptr + 17, 0);
    this.writeU16(ptr + 18, 0);
    this.writeU32(ptr + 20, 0);
    this.writeU64(ptr + 24, 1n);
    this.writeU64(ptr + 32, BigInt(size));
    this.writeU64(ptr + 40, 0n);
    this.writeU64(ptr + 48, 0n);
    this.writeU64(ptr + 56, 0n);
  }

  readU32(ptr) {
    return this.view().getUint32(ptr, true);
  }

  readU8(ptr) {
    return this.view().getUint8(ptr);
  }

  readU16(ptr) {
    return this.view().getUint16(ptr, true);
  }

  readU64(ptr) {
    return this.view().getBigUint64(ptr, true);
  }

  writeU8(ptr, value) {
    this.view().setUint8(ptr, value);
  }

  writeU16(ptr, value) {
    this.view().setUint16(ptr, value, true);
  }

  writeU32(ptr, value) {
    this.view().setUint32(ptr, value >>> 0, true);
  }

  writeU64(ptr, value) {
    this.view().setBigUint64(ptr, BigInt(value), true);
  }

  view() {
    return new DataView(this.memoryForImport().buffer);
  }

  bytes() {
    return new Uint8Array(this.memoryForImport().buffer);
  }

  memoryForImport() {
    if (this.memory) {
      return this.memory;
    }
    const instance = this.getInstance?.();
    const memory = exportedMemory(instance);
    this.memory = memory;
    return memory;
  }

  throwIfAborted() {
    throwIfAborted(this.signal);
  }

  pollOneoff(subscriptionsPtr, eventsPtr, subscriptionsLen, eventsUsedPtr) {
    this.throwIfAborted();
    const subscriptionCount = subscriptionsLen >>> 0;
    if (subscriptionCount === 0) {
      return ERRNO_INVAL;
    }
    const memoryLength = this.bytes().byteLength;
    if (
      checkedMemoryRange(
        subscriptionsPtr >>> 0,
        subscriptionCount * WASI_SUBSCRIPTION_SIZE,
        memoryLength,
      ) == null ||
      checkedMemoryRange(
        eventsPtr >>> 0,
        subscriptionCount * WASI_EVENT_SIZE,
        memoryLength,
      ) == null ||
      checkedMemoryRange(eventsUsedPtr >>> 0, 4, memoryLength) == null
    ) {
      return ERRNO_FAULT;
    }

    const events = [];
    for (let index = 0; index < subscriptionCount; index += 1) {
      const subscriptionPtr =
        (subscriptionsPtr >>> 0) + index * WASI_SUBSCRIPTION_SIZE;
      const event = this.pollEvent(subscriptionPtr);
      if (event.errno != null) {
        return event.errno;
      }
      events.push(event);
    }
    for (let index = 0; index < events.length; index += 1) {
      this.writePollEvent(
        (eventsPtr >>> 0) + index * WASI_EVENT_SIZE,
        events[index],
      );
    }
    this.writeU32(eventsUsedPtr, subscriptionCount);
    return ERRNO_SUCCESS;
  }

  pollEvent(subscriptionPtr) {
    const userdata = this.readU64(
      subscriptionPtr + WASI_SUBSCRIPTION_USERDATA_OFFSET,
    );
    const type = this.readU8(subscriptionPtr + WASI_SUBSCRIPTION_TYPE_OFFSET);
    if (type === WASI_EVENTTYPE_CLOCK) {
      return this.pollClockEvent(subscriptionPtr, userdata);
    }
    if (type === WASI_EVENTTYPE_FD_READ) {
      return this.pollFdReadEvent(subscriptionPtr, userdata);
    }
    if (type === WASI_EVENTTYPE_FD_WRITE) {
      return this.pollFdWriteEvent(subscriptionPtr, userdata);
    }
    return { errno: ERRNO_INVAL };
  }

  pollClockEvent(subscriptionPtr, userdata) {
    const clockId = this.readU32(
      subscriptionPtr + WASI_SUBSCRIPTION_CLOCK_ID_OFFSET,
    );
    const flags = this.readU16(
      subscriptionPtr + WASI_SUBSCRIPTION_CLOCK_FLAGS_OFFSET,
    );
    const error =
      isSupportedClock(clockId) &&
      (flags & ~WASI_SUBSCRIPTION_CLOCK_ABSTIME) === 0
        ? ERRNO_SUCCESS
        : ERRNO_INVAL;
    return { error, type: WASI_EVENTTYPE_CLOCK, userdata };
  }

  pollFdReadEvent(subscriptionPtr, userdata) {
    const fd = this.readU32(subscriptionPtr + WASI_SUBSCRIPTION_FD_OFFSET);
    const readiness = this.fdReadReadiness(fd);
    return {
      error: readiness.error,
      flags: readiness.flags,
      nbytes: readiness.nbytes,
      type: WASI_EVENTTYPE_FD_READ,
      userdata,
    };
  }

  pollFdWriteEvent(subscriptionPtr, userdata) {
    const fd = this.readU32(subscriptionPtr + WASI_SUBSCRIPTION_FD_OFFSET);
    const readiness = this.fdWriteReadiness(fd);
    return {
      error: readiness.error,
      flags: readiness.flags,
      nbytes: readiness.nbytes,
      type: WASI_EVENTTYPE_FD_WRITE,
      userdata,
    };
  }

  fdReadReadiness(fd) {
    const file = this.openFiles.get(fd);
    if (fd === STDIN_FD) {
      const remaining = Math.max(0, this.stdin.byteLength - this.stdinOffset);
      return {
        error: ERRNO_SUCCESS,
        flags: remaining === 0 ? WASI_EVENT_FD_READWRITE_HANGUP : 0,
        nbytes: BigInt(remaining),
      };
    }
    if (isOpenStdio(file)) {
      if (file.stdioFd !== STDIN_FD) {
        return { error: ERRNO_BADF };
      }
      if ((file.rights & WASI_RIGHT_FD_READ) === 0n) {
        return { error: ERRNO_NOTCAPABLE };
      }
      const remaining = Math.max(0, this.stdin.byteLength - this.stdinOffset);
      return {
        error: ERRNO_SUCCESS,
        flags: remaining === 0 ? WASI_EVENT_FD_READWRITE_HANGUP : 0,
        nbytes: BigInt(remaining),
      };
    }
    if (isOpenPipe(file)) {
      if (file.direction !== "read") {
        return { error: ERRNO_BADF };
      }
      if ((file.rights & WASI_RIGHT_FD_READ) === 0n) {
        return { error: ERRNO_NOTCAPABLE };
      }
      const remaining = file.pipe.bytes.byteLength;
      return {
        error: ERRNO_SUCCESS,
        flags:
          remaining === 0 && file.pipe.writers === 0
            ? WASI_EVENT_FD_READWRITE_HANGUP
            : 0,
        nbytes: BigInt(remaining),
      };
    }
    if (
      fd === WORKSPACE_FD ||
      fd === TMP_FD ||
      fd === this.packageRootFd ||
      isOpenDirectory(file)
    ) {
      return { error: ERRNO_ISDIR };
    }
    if (!file) {
      return { error: ERRNO_BADF };
    }
    if (!canReadFile(file)) {
      return { error: ERRNO_NOTCAPABLE };
    }
    const remaining = Math.max(0, file.record.bytes.byteLength - file.offset);
    return {
      error: ERRNO_SUCCESS,
      flags: remaining === 0 ? WASI_EVENT_FD_READWRITE_HANGUP : 0,
      nbytes: BigInt(remaining),
    };
  }

  fdWriteReadiness(fd) {
    const file = this.openFiles.get(fd);
    if (fd === STDOUT_FD || fd === STDERR_FD) {
      return { error: ERRNO_SUCCESS };
    }
    if (isOpenStdio(file)) {
      if (file.stdioFd !== STDOUT_FD && file.stdioFd !== STDERR_FD) {
        return { error: ERRNO_BADF };
      }
      return (file.rights & WASI_RIGHT_FD_WRITE) !== 0n
        ? { error: ERRNO_SUCCESS }
        : { error: ERRNO_NOTCAPABLE };
    }
    if (isOpenPipe(file)) {
      if (file.direction !== "write") {
        return { error: ERRNO_BADF };
      }
      if ((file.rights & WASI_RIGHT_FD_WRITE) === 0n) {
        return { error: ERRNO_NOTCAPABLE };
      }
      return file.pipe.readers > 0
        ? { error: ERRNO_SUCCESS }
        : { error: ERRNO_PIPE };
    }
    if (!file) {
      return { error: ERRNO_BADF };
    }
    if (!canWriteFile(file)) {
      return { error: ERRNO_NOTCAPABLE };
    }
    return { error: ERRNO_SUCCESS };
  }

  writePollEvent(eventPtr, event) {
    this.writeU64(eventPtr + WASI_EVENT_USERDATA_OFFSET, event.userdata);
    this.writeU16(eventPtr + WASI_EVENT_ERROR_OFFSET, event.error);
    this.writeU8(eventPtr + WASI_EVENT_TYPE_OFFSET, event.type);
    this.writeU8(eventPtr + 11, 0);
    this.writeU32(eventPtr + 12, 0);
    this.writeU64(eventPtr + WASI_EVENT_FD_NBYTES_OFFSET, event.nbytes ?? 0n);
    this.writeU16(eventPtr + WASI_EVENT_FD_FLAGS_OFFSET, event.flags ?? 0);
    this.writeU16(eventPtr + 26, 0);
    this.writeU32(eventPtr + 28, 0);
  }

  procRaise(_signal) {
    this.throwIfAborted();
    return ERRNO_SUCCESS;
  }

  sockAccept(fd, _flags, _acceptedFdPtr) {
    this.throwIfAborted();
    return this.fdStat(fd) ? ERRNO_NOTSUP : ERRNO_BADF;
  }

  sockRecv(fd, _iovsPtr, _iovsLen, _flags, _nreadPtr, _roFlagsPtr) {
    this.throwIfAborted();
    return this.fdStat(fd) ? ERRNO_NOTSUP : ERRNO_BADF;
  }

  sockSend(fd, _iovsPtr, _iovsLen, _flags, _nwrittenPtr) {
    this.throwIfAborted();
    return this.fdStat(fd) ? ERRNO_NOTSUP : ERRNO_BADF;
  }

  sockShutdown(fd, how) {
    this.throwIfAborted();
    if (how !== 1 && how !== 2 && how !== 3) {
      return ERRNO_INVAL;
    }
    return this.fdStat(fd) ? ERRNO_NOTSUP : ERRNO_BADF;
  }
}

class WasixRuntime {
  constructor(host) {
    this.host = host;
  }

  imports() {
    const imports = {
      ...this.host.imports(),
      chdir: (pathPtr, pathLen) => this.host.chdir(pathPtr, pathLen),
      fd_dup: (fd, retFdPtr) => this.host.fdDup(fd, retFdPtr),
      fd_dup2: (fd, minResultFd, cloexec, retFdPtr) =>
        this.host.fdDup2(fd, minResultFd, cloexec, retFdPtr),
      fd_fdflags_get: (fd, flagsPtr) =>
        this.host.fdFdflagsGet(fd, flagsPtr),
      fd_fdflags_set: (fd, flags) => this.host.fdFdflagsSet(fd, flags),
      fd_pipe: (readFdPtr, writeFdPtr) =>
        this.host.fdPipe(readFdPtr, writeFdPtr),
      getcwd: (pathPtr, pathLenPtr) => this.host.getcwd(pathPtr, pathLenPtr),
      getpid: (pidPtr) => this.procId(pidPtr),
      path_open2: (
        fd,
        dirflags,
        pathPtr,
        pathLen,
        oflags,
        rightsBase,
        rightsInheriting,
        fdflags,
        fdFlagsExt,
        openedFdPtr,
      ) =>
        this.host.pathOpen2(
          fd,
          dirflags,
          pathPtr,
          pathLen,
          oflags,
          rightsBase,
          rightsInheriting,
          fdflags,
          fdFlagsExt,
          openedFdPtr,
        ),
      proc_signals_get: (_signalsPtr) => this.procSignalsGet(),
      proc_signals_sizes_get: (signalCountPtr) =>
        this.procSignalsSizesGet(signalCountPtr),
      proc_exec: (namePtr, nameLen, argsPtr, argsLen) =>
        this.procExec(namePtr, nameLen, argsPtr, argsLen),
      proc_exec2: (namePtr, nameLen, argsPtr, argsLen, envPtr, envLen) =>
        this.procExec2(namePtr, nameLen, argsPtr, argsLen, envPtr, envLen),
      proc_exec3: (
        namePtr,
        nameLen,
        argsPtr,
        argsLen,
        envPtr,
        envLen,
        searchPath,
        pathPtr,
        pathLen,
      ) =>
        this.procExec3(
          namePtr,
          nameLen,
          argsPtr,
          argsLen,
          envPtr,
          envLen,
          searchPath,
          pathPtr,
          pathLen,
        ),
      proc_exit2: (code) => this.procExit2(code),
      proc_fork: (copyMemory, pidPtr) => this.procFork(copyMemory, pidPtr),
      proc_id: (pidPtr) => this.procId(pidPtr),
      proc_join: (pidPtr, flags, statusPtr) =>
        this.procJoin(pidPtr, flags, statusPtr),
      proc_parent: (pid, parentPidPtr) => this.procParent(pid, parentPidPtr),
      proc_signal: (_pid, _signal) =>
        this.unsupportedProcessCapability("proc_signal"),
      proc_spawn: () => this.unsupportedProcessCapability("proc_spawn"),
      proc_snapshot: () => this.procSnapshot(),
      pipe: (readFdPtr, writeFdPtr) =>
        this.host.fdPipe(readFdPtr, writeFdPtr),
      callback_signal: (_namePtr, _nameLen) => this.callbackSignal(),
      sock_accept: (fd, flags, acceptedFdPtr) =>
        this.networkSocketStub("sock_accept", () =>
          this.host.sockAccept(fd, flags, acceptedFdPtr),
        ),
      sock_recv: (fd, iovsPtr, iovsLen, flags, nreadPtr, roFlagsPtr) =>
        this.networkSocketStub("sock_recv", () =>
          this.host.sockRecv(fd, iovsPtr, iovsLen, flags, nreadPtr, roFlagsPtr),
        ),
      sock_send: (fd, iovsPtr, iovsLen, flags, nwrittenPtr) =>
        this.networkSocketStub("sock_send", () =>
          this.host.sockSend(fd, iovsPtr, iovsLen, flags, nwrittenPtr),
        ),
      sock_shutdown: (fd, how) =>
        this.networkSocketStub("sock_shutdown", () =>
          this.host.sockShutdown(fd, how),
        ),
      thread_id: (threadIdPtr) => this.threadId(threadIdPtr),
      thread_parallelism: (parallelismPtr) =>
        this.threadParallelism(parallelismPtr),
      thread_sleep: (duration) => this.threadSleep(duration),
      stack_checkpoint: (snapshotPtr, retValPtr) =>
        this.stackCheckpoint(snapshotPtr, retValPtr),
      stack_restore: (snapshotPtr, value) =>
        this.stackRestore(snapshotPtr, value),
      tty_get: (ttyStatePtr) => this.ttyGet(ttyStatePtr),
      tty_set: (ttyStatePtr) => this.ttySet(ttyStatePtr),
    };

    for (const name of WASIX_UNSUPPORTED_NETWORK_IMPORTS) {
      imports[name] = () => this.unsupportedNetworkCapability(name);
    }
    for (const name of WASIX_UNSUPPORTED_THREAD_EVENT_IMPORTS) {
      imports[name] = () => this.unsupportedThreadEventCapability(name);
    }
    for (const name of WASIX_UNSUPPORTED_THREAD_EXIT_IMPORTS) {
      imports[name] = () => this.unsupportedThreadExitCapability(name);
    }
    for (const name of WASIX_UNSUPPORTED_CLOCK_IMPORTS) {
      imports[name] = () => this.unsupportedUtilityCapability("clock", name);
    }
    for (const name of WASIX_UNSUPPORTED_DYNAMIC_IMPORTS) {
      imports[name] = () => this.unsupportedUtilityCapability("dynamic", name);
    }
    for (const name of WASIX_UNSUPPORTED_PROCESS_IMPORTS) {
      imports[name] = () => this.unsupportedProcessCapability(name);
    }

    return imports;
  }

  ttyGet(ttyStatePtr) {
    this.host.throwIfAborted();
    const ptr = ttyStatePtr >>> 0;
    if (!this.host.canReadWrite(ptr, WASIX_TTY_STATE_SIZE)) {
      return ERRNO_FAULT;
    }
    writeWasixTtyState(this.host, ptr, DEFAULT_WASIX_TTY_STATE);
    return ERRNO_SUCCESS;
  }

  ttySet(ttyStatePtr) {
    this.host.throwIfAborted();
    const ptr = ttyStatePtr >>> 0;
    if (!this.host.canReadWrite(ptr, WASIX_TTY_STATE_SIZE)) {
      return ERRNO_FAULT;
    }
    return ERRNO_SUCCESS;
  }

  procExec(namePtr, nameLen, argsPtr, argsLen) {
    this.throwProcExec(
      namePtr,
      nameLen,
      argsPtr,
      argsLen,
      this.host.envObject,
    );
  }

  procExec2(namePtr, nameLen, argsPtr, argsLen, envPtr, envLen) {
    const env = this.wasixEnv(envPtr, envLen);
    if (env == null) {
      throw new WasiProcExit(ERRNO_INVAL);
    }
    this.throwProcExec(namePtr, nameLen, argsPtr, argsLen, env);
  }

  procExec3(
    namePtr,
    nameLen,
    argsPtr,
    argsLen,
    envPtr,
    envLen,
    searchPath,
    pathPtr,
    pathLen,
  ) {
    const env = this.wasixEnv(envPtr, envLen);
    if (env == null) {
      return ERRNO_INVAL;
    }
    if (searchPath) {
      env.PATH =
        pathPtr !== 0 && pathLen !== 0
          ? this.readString(pathPtr, pathLen)
          : DEFAULT_WASIX_PROC_SEARCH_PATH;
    }
    this.throwProcExec(namePtr, nameLen, argsPtr, argsLen, env);
    return ERRNO_SUCCESS;
  }

  throwProcExec(namePtr, nameLen, argsPtr, argsLen, env) {
    this.host.throwIfAborted();
    const command = this.readString(namePtr, nameLen).trim();
    if (!command) {
      throw new BrowserWasiModuleError(
        "invalid_request",
        "WASIX proc_exec command is required",
        "runtime",
        { exitCode: 126 },
      );
    }
    const stderr = "inherit";
    const stdout = "inherit";
    const args = wasixLineList(this.readString(argsPtr, argsLen));
    const request = {
      args,
      command,
      cwd: this.host.cwd,
      env,
      packageId: null,
      stderr,
      stdin: this.host.remainingStdinBytes(),
      stdout,
      wasixExecArgv0: true,
    };
    if (this.host.diagnostics.unsupportedWasixCalls) {
      request.diagnostics = this.host.diagnostics;
    }
    throw new WasixProcExec(request);
  }

  wasixEnv(envPtr, envLen) {
    const env = { ...this.host.envObject };
    if (envPtr === 0 || envLen === 0) {
      return env;
    }
    for (const entry of wasixLineList(this.readString(envPtr, envLen))) {
      const separator = entry.indexOf("=");
      if (separator < 0) {
        return null;
      }
      env[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
    return env;
  }

  procExit2(code) {
    this.host.throwIfAborted();
    if (this.host.beginVforkChildExit(code)) {
      return;
    }
    throw new WasiProcExit(code);
  }

  procFork(copyMemory, pidPtr) {
    this.host.throwIfAborted();
    const ptr = pidPtr >>> 0;
    if (!this.host.canReadWrite(ptr, 4)) {
      return ERRNO_FAULT;
    }
    const rewindResult = this.host.finishForkRewind(ptr);
    if (rewindResult != null) {
      return rewindResult;
    }
    if ((copyMemory >>> 0) !== 0) {
      if (
        !this.host.hasStackContinuationSupport() ||
        this.host.activeVfork ||
        typeof this.host.copyForkRunner !== "function"
      ) {
        return this.unsupportedProcessCapability("proc_fork");
      }
      return this.host.beginCopyFork(ptr);
    }
    if (!this.host.hasStackContinuationSupport() || this.host.activeVfork) {
      return this.unsupportedProcessCapability("proc_fork");
    }
    return this.host.beginVfork(ptr);
  }

  procId(pidPtr) {
    this.host.throwIfAborted();
    const ptr = pidPtr >>> 0;
    if (!this.host.canReadWrite(ptr, 4)) {
      return ERRNO_FAULT;
    }
    this.host.writeU32(ptr, this.host.currentProcessId);
    return ERRNO_SUCCESS;
  }

  procParent(pid, parentPidPtr) {
    this.host.throwIfAborted();
    const ptr = parentPidPtr >>> 0;
    if (!this.host.canReadWrite(ptr, 4)) {
      return ERRNO_FAULT;
    }
    const record = this.host.processRecord(pid);
    if (!record) {
      return ERRNO_BADF;
    }
    this.host.writeU32(ptr, record.parentPid);
    return ERRNO_SUCCESS;
  }

  procJoin(pidPtr, flags, statusPtr) {
    this.host.throwIfAborted();
    const pid = pidPtr >>> 0;
    const status = statusPtr >>> 0;
    if (
      !this.host.canReadWrite(pid, WASIX_OPTION_PID_SIZE) ||
      !this.host.canReadWrite(status, WASIX_JOIN_STATUS_SIZE)
    ) {
      return ERRNO_FAULT;
    }
    if ((flags >>> 0) & ~WASIX_PROC_JOIN_NON_BLOCKING) {
      return ERRNO_INVAL;
    }
    const tag = this.host.readU8(pid);
    if (tag !== WASIX_OPTION_TAG_NONE && tag !== WASIX_OPTION_TAG_SOME) {
      return ERRNO_INVAL;
    }
    const requestedPid = this.host.readU32(pid + 4);
    writeWasixOptionPid(this.host, pid, WASIX_OPTION_TAG_NONE, 0);
    writeWasixJoinStatusNothing(this.host, status);
    if (tag === WASIX_OPTION_TAG_NONE) {
      const child = this.host.findExitedChild(this.host.currentProcessId);
      if (child) {
        this.writeJoinedChild(pid, status, child);
        return ERRNO_SUCCESS;
      }
      if (this.host.hasChildProcess(this.host.currentProcessId)) {
        return this.unsupportedProcessCapability("proc_join");
      }
      return ERRNO_CHILD;
    }

    const child = this.host.processRecord(requestedPid);
    if (!child || child.parentPid !== this.host.currentProcessId) {
      return ERRNO_SUCCESS;
    }
    writeWasixOptionPid(this.host, pid, WASIX_OPTION_TAG_SOME, child.pid);
    if (child.state === "exited") {
      this.writeJoinedChild(pid, status, child);
      return ERRNO_SUCCESS;
    }
    if ((flags >>> 0) & WASIX_PROC_JOIN_NON_BLOCKING) {
      return ERRNO_SUCCESS;
    }
    return this.unsupportedProcessCapability("proc_join");
  }

  writeJoinedChild(pidPtr, statusPtr, child) {
    writeWasixOptionPid(this.host, pidPtr, WASIX_OPTION_TAG_SOME, child.pid);
    writeWasixJoinStatusExitNormal(this.host, statusPtr, child.exitCode ?? 0);
    this.host.reapProcess(child.pid);
  }

  procSnapshot() {
    this.host.throwIfAborted();
    return ERRNO_SUCCESS;
  }

  procSignalsSizesGet(signalCountPtr) {
    this.host.throwIfAborted();
    this.host.writeU32(signalCountPtr, 0);
    return ERRNO_SUCCESS;
  }

  procSignalsGet() {
    this.host.throwIfAborted();
    return ERRNO_SUCCESS;
  }

  threadId(threadIdPtr) {
    this.host.throwIfAborted();
    const ptr = threadIdPtr >>> 0;
    if (!this.host.canReadWrite(ptr, 4)) {
      return ERRNO_FAULT;
    }
    this.host.writeU32(ptr, 1);
    return ERRNO_SUCCESS;
  }

  threadParallelism(parallelismPtr) {
    this.host.throwIfAborted();
    const ptr = parallelismPtr >>> 0;
    if (!this.host.canReadWrite(ptr, 4)) {
      return ERRNO_FAULT;
    }
    this.host.writeU32(ptr, 1);
    return ERRNO_SUCCESS;
  }

  threadSleep(duration) {
    this.host.throwIfAborted();
    const nanos = duration == null ? 0n : BigInt(duration);
    if (nanos === 0n) {
      return ERRNO_SUCCESS;
    }
    return this.unsupportedThreadEventCapability("thread_sleep");
  }

  stackCheckpoint(snapshotPtr, retValPtr) {
    this.host.throwIfAborted();
    const snapshot = snapshotPtr >>> 0;
    const retVal = retValPtr >>> 0;
    if (
      !this.host.canReadWrite(snapshot, WASIX_STACK_SNAPSHOT_SIZE) ||
      !this.host.canReadWrite(retVal, 8)
    ) {
      return ERRNO_FAULT;
    }
    if (this.host.finishStackRewind(retVal)) {
      return ERRNO_SUCCESS;
    }
    this.host.writeU64(snapshot, 0n);
    this.host.writeU64(snapshot + 8, 0n);
    this.host.writeU64(snapshot + 16, 0n);
    this.host.writeU64(retVal, 0n);
    if (!this.host.hasStackContinuationSupport()) {
      return ERRNO_SUCCESS;
    }
    this.host.beginStackCheckpoint(snapshot, retVal);
    return ERRNO_SUCCESS;
  }

  stackRestore(snapshotPtr, _value) {
    this.host.throwIfAborted();
    const snapshot = snapshotPtr >>> 0;
    if (!this.host.canReadWrite(snapshot, WASIX_STACK_SNAPSHOT_SIZE)) {
      throw new BrowserWasiModuleError(
        "runtime",
        "WASIX stack_restore received an invalid stack snapshot pointer",
        "runtime",
        { exitCode: ERRNO_FAULT },
      );
    }
    if (this.host.hasStackContinuationSupport()) {
      this.host.beginStackRestore(snapshot, _value);
      return;
    }
    this.host.recordUnsupportedWasixCall("thread-event", "stack_restore");
    throw new BrowserWasiModuleError(
      "runtime",
      wasixStackRestoreUnsupportedMessage(
        this.host.continuationCapabilities,
      ),
      "runtime",
      { exitCode: 126 },
    );
  }

  unsupportedNetworkCapability(name) {
    return this.unsupportedWasixCapability("network", name);
  }

  networkSocketStub(name, delegate) {
    this.host.recordUnsupportedWasixCall("network", name);
    return delegate();
  }

  callbackSignal() {
    this.host.throwIfAborted();
    this.host.recordUnsupportedWasixCall("dynamic", "callback_signal");
  }

  unsupportedThreadEventCapability(name) {
    return this.unsupportedWasixCapability("thread-event", name);
  }

  unsupportedProcessCapability(name) {
    return this.unsupportedWasixCapability("process", name);
  }

  unsupportedUtilityCapability(group, name) {
    return this.unsupportedWasixCapability(group, name);
  }

  unsupportedWasixCapability(group, name) {
    this.host.throwIfAborted();
    this.host.recordUnsupportedWasixCall(group, name);
    return ERRNO_NOTSUP;
  }

  unsupportedThreadExitCapability(name) {
    this.host.throwIfAborted();
    this.host.recordUnsupportedWasixCall("thread-event", name);
    throw new BrowserWasiModuleError(
      "unsupported",
      "WASIX thread_exit requires browser thread runtime support",
      "runtime",
      { exitCode: 126 },
    );
  }

  readString(ptr, length) {
    return this.host.readString(ptr, length);
  }
}

function wasixLineList(value) {
  const text = String(value ?? "");
  if (!text) {
    return [];
  }
  return text.split(/[\r\n]/).filter((item) => item.length > 0);
}

function normalizeRawWasiDiagnostics(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return { unsupportedWasixCalls: false };
  }
  return { unsupportedWasixCalls: value.unsupportedWasixCalls === true };
}

function normalizeRawWasiResultDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (!Array.isArray(value.unsupportedWasixCalls)) {
    return null;
  }
  return {
    unsupportedWasixCalls: value.unsupportedWasixCalls
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({
        count: Number(entry.count ?? 0),
        group: String(entry.group ?? ""),
        name: String(entry.name ?? ""),
      }))
      .filter((entry) => entry.count > 0 && entry.group && entry.name)
      .sort(compareWasixUnsupportedCallDiagnostics),
  };
}

function compareWasixUnsupportedCallDiagnostics(left, right) {
  return (
    left.group.localeCompare(right.group) || left.name.localeCompare(right.name)
  );
}

function wasixContinuationCapabilities(instance, memory = null) {
  const exports = instance?.exports ?? {};
  const missingAsyncifyExports = WASIX_ASYNCIFY_EXPORTS.filter(
    (name) => typeof exports[name] !== "function",
  );
  const stackLow = exportedI32Global(exports, "__stack_low");
  const stackHigh = exportedI32Global(exports, "__stack_high");
  const missingStackExports = [];
  if (stackLow == null) {
    missingStackExports.push("__stack_low");
  }
  if (stackHigh == null) {
    missingStackExports.push("__stack_high");
  }
  const memoryLength = memory?.buffer?.byteLength ?? 0;
  const stackBoundsError =
    missingStackExports.length === 0
      ? validateAsyncifyStackBounds(stackLow, stackHigh, memoryLength)
      : null;
  const explicitStackBounds =
    missingStackExports.length === 0 && !stackBoundsError
      ? {
          dataEnd: stackHigh,
          dataPtr: stackLow,
          dataStart: stackLow + 8,
          source: "exports",
        }
      : null;
  const fallbackStackBounds =
    !explicitStackBounds &&
    missingStackExports.length > 0 &&
    missingAsyncifyExports.length === 0
      ? fallbackAsyncifyStackBounds(memoryLength)
      : null;
  return {
    asyncifyExports: missingAsyncifyExports.length === 0,
    exports,
    fallbackStackBounds: fallbackStackBounds != null,
    missingAsyncifyExports,
    missingStackExports,
    stackBounds: explicitStackBounds ?? fallbackStackBounds,
    stackBoundsError,
  };
}

function wasixStackRestoreUnsupportedMessage(capabilities) {
  if (!capabilities?.asyncifyExports) {
    const missing = capabilities?.missingAsyncifyExports ?? WASIX_ASYNCIFY_EXPORTS;
    return `WASIX stack_restore requires asyncify continuation exports; missing: ${missing.join(", ")}`;
  }
  if (capabilities?.missingStackExports?.length > 0) {
    if (capabilities?.fallbackStackBounds) {
      return "WASIX stack_restore uses a host-owned browser asyncify buffer for this module";
    }
    return `WASIX stack_restore requires browser stack bounds; missing: ${capabilities.missingStackExports.join(", ")}`;
  }
  if (capabilities?.stackBoundsError) {
    return `WASIX stack_restore requires usable browser stack bounds; ${capabilities.stackBoundsError}`;
  }
  return "WASIX stack_restore requires browser stack rewind support";
}

function fallbackAsyncifyStackBounds(memoryLength) {
  if (memoryLength < WASIX_ASYNCIFY_FALLBACK_MIN_MEMORY_SIZE) {
    return null;
  }
  const dataStart = memoryLength - WASIX_ASYNCIFY_FALLBACK_BUFFER_SIZE;
  if (dataStart < 8) {
    return null;
  }
  return {
    dataEnd: memoryLength,
    dataPtr: dataStart - 8,
    dataStart,
    source: "host-buffer",
  };
}

function snapshotExportedMutableGlobals(instance) {
  const snapshot = [];
  for (const [name, value] of Object.entries(instance?.exports ?? {})) {
    if (!(value instanceof WebAssembly.Global)) {
      continue;
    }
    try {
      const current = value.value;
      value.value = current;
      snapshot.push({ name, value: current });
    } catch {
      // Immutable globals cannot be restored in a copied child instance.
    }
  }
  return snapshot;
}

function restoreExportedMutableGlobals(instance, snapshot) {
  for (const entry of snapshot ?? []) {
    const target = instance?.exports?.[entry.name];
    if (!(target instanceof WebAssembly.Global)) {
      continue;
    }
    try {
      target.value = entry.value;
    } catch {
      // Keep immutable or type-mismatched globals at their module defaults.
    }
  }
}

function stackSnapshotKey(snapshot) {
  return `${BigInt(snapshot.hashHigh).toString(16)}:${BigInt(
    snapshot.hashLow,
  ).toString(16)}`;
}

function exportedI32Global(exports, name) {
  const value = exports?.[name];
  const raw =
    value instanceof WebAssembly.Global
      ? value.value
      : typeof value === "number"
        ? value
        : null;
  if (raw == null) {
    return null;
  }
  const number = Number(raw);
  if (!Number.isInteger(number) || number < 0 || number > 0xffffffff) {
    return null;
  }
  return number >>> 0;
}

function validateAsyncifyStackBounds(stackLow, stackHigh, memoryLength) {
  if (memoryLength <= 0) {
    return "linear memory is unavailable";
  }
  if (stackLow + 8 >= stackHigh) {
    return "__stack_low must leave room for asyncify metadata";
  }
  if (checkedMemoryRange(stackLow, stackHigh - stackLow, memoryLength) == null) {
    return "__stack_low and __stack_high must be inside linear memory";
  }
  return null;
}

function isSupportedClock(clockId) {
  return clockId === WASI_CLOCK_REALTIME || clockId === WASI_CLOCK_MONOTONIC;
}

function isSupportedAdvice(advice) {
  return (
    Number.isInteger(advice) && advice >= 0 && advice <= WASI_ADVICE_NOREUSE
  );
}

function isSupportedFilestatSetTimesFlags(flags) {
  if (!Number.isInteger(flags) || (flags & ~WASI_FSTFLAGS_MASK) !== 0) {
    return false;
  }
  if (
    (flags & WASI_FSTFLAGS_ATIM) !== 0 &&
    (flags & WASI_FSTFLAGS_ATIM_NOW) !== 0
  ) {
    return false;
  }
  return !(
    (flags & WASI_FSTFLAGS_MTIM) !== 0 &&
    (flags & WASI_FSTFLAGS_MTIM_NOW) !== 0
  );
}

function clockTimeNanos(clockId) {
  switch (clockId) {
    case WASI_CLOCK_REALTIME:
      return BigInt(Date.now()) * NANOS_PER_MILLI;
    case WASI_CLOCK_MONOTONIC:
      return monotonicClockNanos();
    default:
      return null;
  }
}

function monotonicClockNanos() {
  const performance = globalThis.performance;
  if (performance && typeof performance.now === "function") {
    const nanos = BigInt(Math.floor(performance.now() * 1_000_000));
    return nanos > 0n ? nanos : 1n;
  }
  return BigInt(Date.now()) * NANOS_PER_MILLI;
}

function cryptoRandom() {
  const crypto = globalThis.crypto;
  if (!crypto || typeof crypto.getRandomValues !== "function") {
    throw new BrowserWasiModuleError(
      "unsupported",
      "Web Crypto random values are unavailable for raw WASI modules",
      "runtime",
    );
  }
  return crypto;
}

function checkedMemoryRange(start, length, memoryLength) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length)) {
    return null;
  }
  const end = start + length;
  if (start < 0 || length < 0 || end > memoryLength) {
    return null;
  }
  return end;
}

function writeWasixTtyState(host, ptr, state) {
  host.writeU32(ptr + WASIX_TTY_COLS_OFFSET, state.cols);
  host.writeU32(ptr + WASIX_TTY_ROWS_OFFSET, state.rows);
  host.writeU32(ptr + WASIX_TTY_WIDTH_OFFSET, state.width);
  host.writeU32(ptr + WASIX_TTY_HEIGHT_OFFSET, state.height);
  host.writeU8(ptr + WASIX_TTY_STDIN_OFFSET, boolByte(state.stdinTty));
  host.writeU8(ptr + WASIX_TTY_STDOUT_OFFSET, boolByte(state.stdoutTty));
  host.writeU8(ptr + WASIX_TTY_STDERR_OFFSET, boolByte(state.stderrTty));
  host.writeU8(ptr + WASIX_TTY_ECHO_OFFSET, boolByte(state.echo));
  host.writeU8(
    ptr + WASIX_TTY_LINE_BUFFERED_OFFSET,
    boolByte(state.lineBuffered),
  );
  host.writeU8(ptr + 21, 0);
  host.writeU8(ptr + 22, 0);
  host.writeU8(ptr + 23, 0);
}

function writeWasixOptionPid(host, ptr, tag, pid) {
  host.writeU8(ptr, tag);
  host.writeU8(ptr + 1, 0);
  host.writeU16(ptr + 2, 0);
  host.writeU32(ptr + 4, pid);
}

function writeWasixJoinStatusNothing(host, ptr) {
  host.writeU8(ptr, WASIX_JOIN_STATUS_NOTHING);
  host.writeU8(ptr + 1, 0);
  host.writeU16(ptr + 2, 0);
  host.writeU32(ptr + 4, 0);
}

function writeWasixJoinStatusExitNormal(host, ptr, exitCode) {
  host.writeU8(ptr, WASIX_JOIN_STATUS_EXIT_NORMAL);
  host.writeU8(ptr + 1, 0);
  host.writeU16(ptr + 2, 0);
  host.writeU32(ptr + 4, exitCode);
}

function boolByte(value) {
  return value ? 1 : 0;
}

function requestsWriteRights(rights) {
  return (BigInt(rights) & WASI_WRITE_RIGHTS) !== 0n;
}

function allowsRights(requested, allowed) {
  return (requested & ~allowed) === 0n;
}

function canWriteFile(file) {
  return file.writable && (file.rights & WASI_RIGHT_FD_WRITE) !== 0n;
}

function canReadFile(file) {
  return (file.rights & WASI_RIGHT_FD_READ) !== 0n;
}

function canResizeFile(file) {
  return (
    file.writable && (file.rights & WASI_RIGHT_FD_FILESTAT_SET_SIZE) !== 0n
  );
}

function canSetFileTimes(file) {
  return (
    file.writable && (file.rights & WASI_RIGHT_FD_FILESTAT_SET_TIMES) !== 0n
  );
}

function canAllocateFile(file) {
  return file.writable && (file.rights & WASI_RIGHT_FD_ALLOCATE) !== 0n;
}

function duplicateOpenFileDescriptor(file) {
  const descriptor = { ...file };
  if (hasOpenFileOffset(file)) {
    attachOpenFileOffset(descriptor, openFileOffsetRef(file));
  }
  return descriptor;
}

function hasOpenFileOffset(file) {
  return Object.prototype.hasOwnProperty.call(file, "offset");
}

function openFileOffsetRef(file) {
  if (file.offsetRef) {
    return file.offsetRef;
  }
  const offsetRef = { value: Number(file.offset ?? 0) };
  attachOpenFileOffset(file, offsetRef);
  return offsetRef;
}

function attachOpenFileOffset(file, offsetRef) {
  Object.defineProperty(file, "offsetRef", {
    configurable: true,
    value: offsetRef,
    writable: true,
  });
  Object.defineProperty(file, "offset", {
    configurable: true,
    enumerable: true,
    get() {
      return this.offsetRef.value;
    },
    set(value) {
      this.offsetRef.value = Number(value);
    },
  });
}

function isOpenDirectory(file) {
  return file?.kind === "directory";
}

function isOpenStdio(file) {
  return file?.kind === "stdio";
}

function isOpenPipe(file) {
  return file?.kind === "pipe";
}

function isOpenScratchDirectory(file) {
  return isOpenDirectory(file) && (file.mount == null || file.mount === "scratch");
}

function isOpenWorkspaceDirectory(file) {
  return isOpenDirectory(file) && file.mount === "workspace";
}

function isOpenPackageRootDirectory(file) {
  return isOpenDirectory(file) && file.mount === "package-root";
}

function isDynamicFileFdNumber(fd) {
  return Number.isInteger(fd) && fd >= FIRST_FILE_FD;
}

function resizeOpenFile(file, size) {
  if (file.record.bytes.byteLength === size) {
    return false;
  }
  const next = new Uint8Array(size);
  next.set(file.record.bytes.subarray(0, size));
  file.record.bytes = next;
  return true;
}

function resolveFileSize(size) {
  const value = BigInt(size);
  if (value < 0n) {
    return { errno: ERRNO_INVAL };
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { errno: ERRNO_OVERFLOW };
  }
  return { size: Number(value) };
}

function resolveFileAllocation(offset, length) {
  const range = resolveFileRange(offset, length);
  if (range.errno != null) {
    return range;
  }
  return { size: range.length === 0 ? null : Number(range.end) };
}

function resolveFileRange(offset, length) {
  const start = BigInt(offset);
  const size = BigInt(length);
  if (start < 0n || size < 0n) {
    return { errno: ERRNO_INVAL };
  }
  const maxSize = BigInt(Number.MAX_SAFE_INTEGER);
  if (start > maxSize || size > maxSize) {
    return { errno: ERRNO_OVERFLOW };
  }
  if (size === 0n) {
    return { size: null };
  }
  const end = start + size;
  if (end > maxSize) {
    return { errno: ERRNO_OVERFLOW };
  }
  return { length: Number(size), end };
}

function resolveFileSeekOffset(file, offset, whence) {
  let base;
  switch (whence) {
    case WASI_WHENCE_SET:
      base = 0n;
      break;
    case WASI_WHENCE_CUR:
      base = BigInt(file.offset);
      break;
    case WASI_WHENCE_END:
      base = BigInt(file.record.bytes.byteLength);
      break;
    default:
      return { errno: ERRNO_INVAL };
  }

  const nextOffset = base + BigInt(offset);
  if (nextOffset < 0n) {
    return { errno: ERRNO_INVAL };
  }
  if (nextOffset > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { errno: ERRNO_OVERFLOW };
  }
  return { offset: Number(nextOffset) };
}

function readdirStartIndex(cookie) {
  const value = BigInt(cookie);
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(value);
}

function direntBytes(entry, nextCookie) {
  const bytes = new Uint8Array(WASI_DIRENT_SIZE);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(nextCookie), true);
  view.setBigUint64(8, BigInt(nextCookie), true);
  view.setUint32(16, encodeText(entry.name).byteLength, true);
  view.setUint8(20, entry.filetype);
  return bytes;
}

function copyPartial(source, target, offset) {
  const writable = Math.min(source.byteLength, target.byteLength - offset);
  if (writable <= 0) {
    return 0;
  }
  target.set(source.subarray(0, writable), offset);
  return writable;
}

function compareStrings(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function directoryEntries(files, dirs = null, path = "") {
  const entries = new Map();
  const prefix = path ? `${path}/` : "";
  for (const dir of dirs ?? []) {
    if (!dir || !dir.startsWith(prefix)) {
      continue;
    }
    const rest = dir.slice(prefix.length);
    if (!rest) {
      continue;
    }
    const [name] = rest.split("/");
    entries.set(name, {
      filetype: WASI_FILETYPE_DIRECTORY,
      name,
    });
  }
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) {
      continue;
    }
    const relativePath = path.slice(prefix.length);
    const [name, ...rest] = relativePath.split("/");
    if (!name) {
      continue;
    }
    if (rest.length > 0) {
      entries.set(name, {
        filetype: WASI_FILETYPE_DIRECTORY,
        name,
      });
    } else if (!entries.has(name)) {
      entries.set(name, {
        filetype: WASI_FILETYPE_REGULAR_FILE,
        name,
      });
    }
  }
  return [...entries.values()].sort((left, right) =>
    compareStrings(left.name, right.name),
  );
}

function pathHasChildren(files, dirs, path) {
  const prefix = `${path}/`;
  for (const dir of dirs ?? []) {
    if (dir.startsWith(prefix)) {
      return true;
    }
  }
  for (const filePath of files.keys()) {
    if (filePath.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function replacePathPrefix(path, sourcePath, targetPath) {
  return path === sourcePath
    ? targetPath
    : `${targetPath}${path.slice(sourcePath.length)}`;
}

function resolveScratchPath(basePath, pathValue, options = {}) {
  const normalized = (options.lookup ? normalizeWasiLookupPath : normalizeWasiPath)(
    pathValue,
  );
  if (normalized == null) {
    return { errno: ERRNO_NOTCAPABLE };
  }
  if (normalized === "") {
    return { value: basePath };
  }
  return {
    value: basePath ? `${basePath}/${normalized}` : normalized,
  };
}

function resolvePackageRootPath(basePath, pathValue) {
  let path = String(pathValue ?? "");
  if (basePath === "" && path.startsWith("/")) {
    path = path.replace(/^\/+/, "");
  }
  return resolveScratchPath(basePath, path, { lookup: true });
}

function rootVirtualMountPath(basePath, pathValue) {
  if (basePath !== "") {
    return null;
  }
  let path = String(pathValue ?? "");
  if (path.startsWith("/")) {
    path = path.replace(/^\/+/, "");
  }
  const normalized = normalizeWasiLookupPath(path);
  if (normalized == null) {
    return { errno: ERRNO_NOTCAPABLE };
  }
  if (normalized === "workspace" || normalized.startsWith("workspace/")) {
    return {
      mount: "workspace",
      path:
        normalized === "workspace"
          ? ""
          : normalized.slice("workspace/".length),
    };
  }
  if (normalized === "tmp" || normalized.startsWith("tmp/")) {
    return {
      mount: "scratch",
      path: normalized === "tmp" ? "" : normalized.slice("tmp/".length),
    };
  }
  return null;
}

function statPath(files, dirs, path) {
  if (
    (dirs?.has(path) ?? false) ||
    pathHasChildren(files, dirs, path)
  ) {
    return {
      filetype: WASI_FILETYPE_DIRECTORY,
      size: 0,
    };
  }
  const file = files.get(path);
  if (!file) {
    return { errno: ERRNO_NOENT };
  }
  return {
    filetype: WASI_FILETYPE_REGULAR_FILE,
    size: file.bytes.byteLength,
  };
}

function scratchParentStatus(files, dirs, path) {
  const separator = path.lastIndexOf("/");
  if (separator < 0) {
    return {};
  }
  const parent = path.slice(0, separator);
  if (files.has(parent)) {
    return { errno: ERRNO_NOTDIR };
  }
  if (!dirs.has(parent)) {
    return { errno: ERRNO_NOENT };
  }
  return {};
}

function preopenPath(fd) {
  switch (fd) {
    case WORKSPACE_FD:
      return WORKSPACE_PREOPEN_PATH;
    case TMP_FD:
      return TMP_PREOPEN_PATH;
    default:
      return null;
  }
}

function stdioRights(fd) {
  switch (fd) {
    case STDIN_FD:
      return WASI_STDIN_RIGHTS;
    case STDOUT_FD:
    case STDERR_FD:
      return WASI_STDOUT_RIGHTS;
    default:
      return null;
  }
}

class WasiProcExit extends Error {
  constructor(exitCode) {
    super(`WASI proc_exit(${exitCode})`);
    this.name = "WasiProcExit";
    this.exitCode = Number(exitCode) || 0;
  }
}

class WasixProcExec extends Error {
  constructor(request) {
    super("WASIX proc_exec");
    this.name = "WasixProcExec";
    this.request = request;
  }
}

function isRawWasiModulePackage(value) {
  return (
    value?.artifactKind === RAW_WASI_ARTIFACT_KIND ||
    value?.type === RAW_WASI_ARTIFACT_KIND ||
    value?.executorType === RAW_WASI_ARTIFACT_KIND
  );
}

function rawWasiBytes(value) {
  return value?.wasiModule?.bytes ?? value?.source?.bytes ?? value?.bytes ?? null;
}

function exportedMemory(instance) {
  const memory = instance?.exports?.memory;
  if (!(memory instanceof globalThis.WebAssembly.Memory)) {
    throw new BrowserWasiModuleError(
      "invalid_package",
      "raw WASI module must export memory",
      "package_load",
    );
  }
  return memory;
}

function createImportedMemory(bytes) {
  const memoryImport = importedMemoryImport(bytes);
  if (!memoryImport) {
    return null;
  }
  if (
    memoryImport.module !== ENV_IMPORT_MODULE ||
    memoryImport.name !== MEMORY_IMPORT_NAME
  ) {
    throw new BrowserWasiModuleError(
      "invalid_package",
      `raw WASI module imports unsupported memory ${memoryImport.module}.${memoryImport.name}`,
      "package_load",
    );
  }
  if (memoryImport.shared && memoryImport.maximum == null) {
    throw new BrowserWasiModuleError(
      "invalid_package",
      "raw WASI shared memory import must declare a maximum",
      "package_load",
    );
  }

  const descriptor = { initial: memoryImport.initial };
  if (memoryImport.maximum != null) {
    descriptor.maximum = memoryImport.maximum;
  }
  if (memoryImport.shared) {
    descriptor.shared = true;
  }

  try {
    return {
      ...memoryImport,
      memory: new globalThis.WebAssembly.Memory(descriptor),
    };
  } catch (error) {
    throw new BrowserWasiModuleError(
      "unsupported",
      `raw WASI imported memory could not be created: ${
        error?.message ?? "WebAssembly.Memory construction failed"
      }`,
      "package_load",
    );
  }
}

function copyMemorySnapshotTo(memory, snapshot) {
  const source = toUint8Array(snapshot);
  const requiredPages = Math.ceil(source.byteLength / WASM_PAGE_SIZE);
  const currentPages = Math.floor(memory.buffer.byteLength / WASM_PAGE_SIZE);
  if (requiredPages > currentPages) {
    try {
      memory.grow(requiredPages - currentPages);
    } catch (error) {
      throw new BrowserWasiModuleError(
        "unsupported",
        `raw WASI copied fork memory could not grow: ${
          error?.message ?? "WebAssembly.Memory.grow failed"
        }`,
        "runtime",
        { exitCode: 126 },
      );
    }
  }
  const target = new Uint8Array(memory.buffer);
  if (target.byteLength < source.byteLength) {
    throw new BrowserWasiModuleError(
      "unsupported",
      "raw WASI copied fork memory snapshot exceeds child memory",
      "runtime",
      { exitCode: 126 },
    );
  }
  target.set(source);
}

function attachImportedMemory(importObject, memoryImport) {
  importObject[memoryImport.module] ??= {};
  importObject[memoryImport.module][memoryImport.name] = memoryImport.memory;
}

function importedMemoryImport(bytes) {
  const imports = importedMemoryImports(bytes);
  if (imports.length === 0) {
    return null;
  }
  if (imports.length > 1) {
    throw new BrowserWasiModuleError(
      "invalid_package",
      "raw WASI module imports multiple memories",
      "package_load",
    );
  }
  return imports[0];
}

function importedMemoryImports(bytes) {
  const data = toUint8Array(bytes);
  validateWasmMagic(data);
  const imports = [];
  let offset = WASM_MAGIC.byteLength + 4;
  while (offset < data.byteLength) {
    const sectionId = data[offset];
    offset += 1;
    const length = readWasmVarUint32(data, offset);
    offset = length.offset;
    const sectionEnd = offset + length.value;
    requireWasmRange(data, offset, length.value);
    if (sectionId === WASM_IMPORT_SECTION_ID) {
      parseWasmImportSection(data, offset, sectionEnd, imports);
    }
    offset = sectionEnd;
  }
  return imports;
}

function parseWasmImportSection(data, offset, sectionEnd, imports) {
  const count = readWasmVarUint32(data, offset);
  let cursor = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    const moduleName = readWasmName(data, cursor, sectionEnd);
    cursor = moduleName.offset;
    const importName = readWasmName(data, cursor, sectionEnd);
    cursor = importName.offset;
    requireWasmRange(data, cursor, 1, sectionEnd);
    const kind = data[cursor];
    cursor += 1;
    if (kind === WASM_IMPORT_KIND_MEMORY) {
      const memory = readWasmMemoryType(data, cursor, sectionEnd);
      cursor = memory.offset;
      imports.push({
        module: moduleName.value,
        name: importName.value,
        initial: memory.initial,
        maximum: memory.maximum,
        shared: memory.shared,
      });
      continue;
    }
    cursor = skipWasmImportDescriptor(data, cursor, sectionEnd, kind);
  }
}

function skipWasmImportDescriptor(data, offset, sectionEnd, kind) {
  if (kind === WASM_IMPORT_KIND_FUNCTION) {
    return readWasmVarUint32(data, offset, sectionEnd).offset;
  }
  if (kind === WASM_IMPORT_KIND_TAG) {
    const attribute = readWasmVarUint32(data, offset, sectionEnd);
    return readWasmVarUint32(data, attribute.offset, sectionEnd).offset;
  }
  if (kind === WASM_IMPORT_KIND_TABLE) {
    requireWasmRange(data, offset, 1, sectionEnd);
    return readWasmLimits(data, offset + 1, sectionEnd).offset;
  }
  if (kind === WASM_IMPORT_KIND_GLOBAL) {
    requireWasmRange(data, offset, 2, sectionEnd);
    return offset + 2;
  }
  throw new BrowserWasiModuleError(
    "invalid_package",
    `raw WASI module imports unsupported descriptor kind ${kind}`,
    "package_load",
  );
}

function readWasmMemoryType(data, offset, sectionEnd) {
  const limits = readWasmLimits(data, offset, sectionEnd);
  if ((limits.flags & WASM_LIMITS_MEMORY64) !== 0) {
    throw new BrowserWasiModuleError(
      "unsupported",
      "raw WASI memory64 imports are not supported in the browser runner",
      "package_load",
    );
  }
  return limits;
}

function readWasmLimits(data, offset, sectionEnd = data.byteLength) {
  const flags = readWasmVarUint32(data, offset, sectionEnd);
  const initial = readWasmVarUint32(data, flags.offset, sectionEnd);
  let maximum = null;
  let cursor = initial.offset;
  if ((flags.value & WASM_LIMITS_HAS_MAXIMUM) !== 0) {
    const maximumValue = readWasmVarUint32(data, cursor, sectionEnd);
    maximum = maximumValue.value;
    cursor = maximumValue.offset;
  }
  return {
    flags: flags.value,
    initial: initial.value,
    maximum,
    offset: cursor,
    shared: (flags.value & WASM_LIMITS_SHARED) !== 0,
  };
}

function readWasmName(data, offset, sectionEnd) {
  const length = readWasmVarUint32(data, offset, sectionEnd);
  requireWasmRange(data, length.offset, length.value, sectionEnd);
  const end = length.offset + length.value;
  return {
    offset: end,
    value: decodeText(data.subarray(length.offset, end)),
  };
}

function readWasmVarUint32(data, offset, sectionEnd = data.byteLength) {
  let result = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < sectionEnd) {
    const byte = data[cursor];
    cursor += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { offset: cursor, value: result >>> 0 };
    }
    shift += 7;
    if (shift >= 35) {
      break;
    }
  }
  throw new BrowserWasiModuleError(
    "invalid_package",
    "raw WASI module contains an invalid varuint32",
    "package_load",
  );
}

function requireWasmRange(data, offset, length, end = data.byteLength) {
  if (
    offset < 0 ||
    length < 0 ||
    offset + length > end ||
    end > data.byteLength
  ) {
    throw new BrowserWasiModuleError(
      "invalid_package",
      "raw WASI module import section is truncated",
      "package_load",
    );
  }
}

function validateWasmMagic(bytes) {
  if (!startsWithBytes(bytes, WASM_MAGIC)) {
    throw new BrowserWasiModuleError(
      "invalid_package",
      "raw WASI module bytes must start with Wasm magic",
      "package_load",
    );
  }
}

function normalizeWasiFiles(value) {
  if (value == null) {
    return [];
  }
  const entries = Array.isArray(value)
    ? value
    : Object.entries(value).map(([path, bytes]) => ({ bytes, path }));
  return entries.map((entry) => {
    const path = normalizePackageFilePath(entry.path ?? entry.name);
    if (!path) {
      throw new BrowserWasiModuleError(
        "invalid_package",
        "raw WASI module file paths must be relative to /workspace",
        "package_load",
      );
    }
    return {
      bytes: wasiFileBytes(entry),
      path,
    };
  });
}

function wasiFileBytes(entry) {
  const value =
    entry.bytes ?? entry.content ?? entry.contents ?? entry.data ?? entry;
  if (typeof value === "string") {
    return encodeText(value);
  }
  return copyBytes(value);
}

function normalizePackageFilePath(value) {
  let path = String(value ?? "");
  if (path === WORKSPACE_PREOPEN_PATH) {
    return null;
  }
  if (path.startsWith(`${WORKSPACE_PREOPEN_PATH}/`)) {
    path = path.slice(WORKSPACE_PREOPEN_PATH.length + 1);
  }
  if (path.startsWith("/")) {
    return null;
  }
  return normalizeRelativeWasiPath(path);
}

function normalizeWasiPath(value) {
  const path = String(value ?? "");
  if (path.startsWith("/")) {
    return null;
  }
  return normalizeRelativeWasiPath(path);
}

function normalizeWasiLookupPath(value) {
  const path = String(value ?? "");
  if (path === ".") {
    return "";
  }
  return normalizeWasiPath(path);
}

function normalizeRuntimeCwd(value) {
  const path = resolveWasiVirtualPath(
    WORKSPACE_PREOPEN_PATH,
    value ?? WORKSPACE_PREOPEN_PATH,
  );
  return path.value ?? WORKSPACE_PREOPEN_PATH;
}

function resolveWasiVirtualPath(cwd, value) {
  const path = String(value ?? "");
  if (path.includes("\0")) {
    return { errno: ERRNO_INVAL };
  }
  if (!path) {
    return { errno: ERRNO_NOENT };
  }

  const segments = path.startsWith("/")
    ? []
    : absolutePathSegments(cwd || WORKSPACE_PREOPEN_PATH);
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return { errno: ERRNO_NOTCAPABLE };
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return {
    value:
      segments.length === 0
        ? PACKAGE_ROOT_PREOPEN_PATH
        : `${PACKAGE_ROOT_PREOPEN_PATH}${segments.join("/")}`,
  };
}

function absolutePathSegments(value) {
  const path = String(value ?? "");
  if (!path.startsWith("/")) {
    return absolutePathSegments(WORKSPACE_PREOPEN_PATH);
  }
  return path.split("/").filter(Boolean);
}

function mountedRelativePath(path, mountPath) {
  if (path === mountPath) {
    return "";
  }
  const prefix = `${mountPath}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

function normalizeRelativeWasiPath(path) {
  if (!path || path.includes("\0")) {
    return null;
  }
  const segments = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return null;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : null;
}

function normalizeCommands(input) {
  const commands = input.commands ?? (input.command ? [input.command] : null);
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new BrowserWasiModuleError(
      "invalid_package",
      "raw WASI module commands must be a non-empty array",
      "package_load",
    );
  }
  return commands.map(normalizeCommandName);
}

function normalizeDefaultCommand(input, commands) {
  const defaultCommand = input.defaultCommand ?? commands[0];
  const normalized = nonEmptyString(defaultCommand);
  if (!commands.includes(normalized)) {
    throw new BrowserWasiModuleError(
      "invalid_package",
      "raw WASI module default command must be listed in commands",
      "package_load",
    );
  }
  return normalized;
}

function normalizeCommandName(value) {
  const command = nonEmptyString(value);
  if (command.includes("\0") || command.includes("/")) {
    throw new BrowserWasiModuleError(
      "invalid_package",
      "raw WASI module command names must not contain NUL or /",
      "package_load",
    );
  }
  return command;
}

function normalizeSource(source) {
  if (!source) {
    return { kind: "bytes", label: "explicit-bytes" };
  }
  return {
    kind: nonEmptyString(source.kind ?? "bytes"),
    label: nonEmptyString(source.label ?? source.kind ?? "explicit-bytes"),
  };
}

function normalizeStringList(value) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new BrowserWasiModuleError(
      "invalid_request",
      "raw WASI module string lists must be arrays of strings",
      "startup",
    );
  }
  return [...value];
}

function normalizeEnvObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserWasiModuleError(
      "invalid_request",
      "raw WASI module env must be an object",
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

function envEntries(value) {
  return Object.entries(value).map(([key, envValue]) => `${key}=${envValue}`);
}

function defaultRawWasiModuleWorkerFactory() {
  if (typeof Worker !== "function") {
    return null;
  }
  return () =>
    new Worker(new URL("./wasi-module-worker-entry.js", import.meta.url), {
      name: "wasm-host-raw-wasi",
      type: "module",
    });
}

function nextWorkerRunId() {
  workerRunCounter += 1;
  return workerRunCounter;
}

function nextWorkerChildRunId() {
  workerChildRunCounter += 1;
  return workerChildRunCounter;
}

function validateExecutionWorker(worker) {
  if (
    !worker ||
    typeof worker.postMessage !== "function" ||
    typeof worker.addEventListener !== "function"
  ) {
    throw new BrowserWasiModuleError(
      "unsupported",
      "raw WASI execution worker is unavailable",
      "runtime",
    );
  }
}

async function readAllCommandStdin(stdin, signal) {
  throwIfAborted(signal);
  if (!stdin) {
    return new Uint8Array();
  }

  const chunks = [];
  let total = 0;
  const readChunk =
    typeof stdin.readChunk === "function" ? () => stdin.readChunk() : null;
  if (readChunk) {
    while (true) {
      throwIfAborted(signal);
      const chunk = await readChunk();
      throwIfAborted(signal);
      if (chunk == null) {
        break;
      }
      const bytes = toUint8Array(chunk);
      chunks.push(bytes);
      total += bytes.byteLength;
    }
    return concatBytes(chunks, total);
  }

  if (typeof stdin[Symbol.asyncIterator] === "function") {
    for await (const chunk of stdin) {
      throwIfAborted(signal);
      const bytes = toUint8Array(chunk);
      chunks.push(bytes);
      total += bytes.byteLength;
    }
    throwIfAborted(signal);
    return concatBytes(chunks, total);
  }

  return toUint8Array(stdin);
}

async function workerRunRequest(request) {
  if (request.workspaceStore) {
    throw new BrowserWasiModuleError(
      "unsupported",
      "raw WASI workspaceStore cannot be sent to a worker; use worker: false or a workspaceSnapshot",
      "runtime",
    );
  }
  const stdinBytes =
    request.stdinBytes != null
      ? copyBytes(request.stdinBytes)
      : await readAllCommandStdin(request.stdin, request.signal);
  return {
    args: normalizeStringList(request.args ?? []),
    command: nonEmptyString(request.command),
    cwd: String(request.cwd ?? "/workspace"),
    diagnostics: normalizeRawWasiDiagnostics(request.diagnostics),
    env: { ...(request.env ?? {}) },
    package: request.package,
    stdinBytes,
    terminal: { ...(request.terminal ?? {}) },
    workspaceSnapshot: request.workspaceSnapshot
      ? cloneWorkspaceSnapshot(request.workspaceSnapshot)
      : undefined,
  };
}

function createRawWasiWorkerChildCommandBridge(id) {
  const pending = new Map();
  workerChildCommandRuns.set(id, pending);
  return {
    commands: {
      run(request = {}) {
        const childId = `raw-wasi-child-${nextWorkerChildRunId()}`;
        const childRequest = workerChildCommandRequest(request);
        return new Promise((resolve, reject) => {
          pending.set(childId, { reject, resolve });
          try {
            postMessageToWorkerHost({
              type: "wasi.child.run",
              id,
              childId,
              request: childRequest,
            });
          } catch (error) {
            pending.delete(childId);
            reject(error);
          }
        });
      },
    },
    close(error) {
      workerChildCommandRuns.delete(id);
      const closeError =
        error ??
        new BrowserWasiModuleError(
          "cancelled",
          "raw WASI worker child command bridge closed",
          "runtime",
          { exitCode: 130 },
        );
      for (const { reject } of pending.values()) {
        reject(closeError);
      }
      pending.clear();
    },
  };
}

function settleRawWasiWorkerChildCommand(message) {
  const pendingByChildId = workerChildCommandRuns.get(message.id);
  if (!pendingByChildId) {
    return;
  }
  const childId = String(message.childId ?? "");
  const pending = pendingByChildId.get(childId);
  if (!pending) {
    return;
  }
  pendingByChildId.delete(childId);
  if (message.type === "wasi.child.complete") {
    pending.resolve(workerChildCommandResult(message.result));
    return;
  }
  pending.reject(workerErrorFromPayload(message.error));
}

function workerChildCommandRequest(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserWasiModuleError(
      "invalid_request",
      "raw WASI worker child command request must be an object",
      "runtime",
    );
  }
  const request = {
    args: normalizeStringList(value.args ?? []),
    command: nonEmptyString(
      value.command,
      "raw WASI worker child command is required",
    ),
  };
  if (value.packageId === null) {
    request.packageId = null;
  } else if (value.packageId != null) {
    request.packageId = nonEmptyString(
      value.packageId,
      "raw WASI worker child package id is required",
    );
  }
  if (value.cwd != null) {
    request.cwd = String(value.cwd);
  }
  if (value.env != null) {
    request.env = cloneChildCommandEnv(value.env);
  }
  if (value.diagnostics != null) {
    request.diagnostics = normalizeRawWasiDiagnostics(value.diagnostics);
  }
  if (value.stdin != null) {
    request.stdin = cloneChildCommandInput(value.stdin);
  }
  if (value.stdinChunks != null) {
    request.stdinChunks = value.stdinChunks.map(cloneChildCommandInput);
  }
  if (value.stdout != null) {
    request.stdout = String(value.stdout);
  }
  if (value.stderr != null) {
    request.stderr = String(value.stderr);
  }
  if (value.timeoutMs != null) {
    request.timeoutMs = Number(value.timeoutMs);
  }
  if (value.wasixExecArgv0 === true) {
    request.wasixExecArgv0 = true;
  }
  return request;
}

function cloneChildCommandEnv(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserWasiModuleError(
      "invalid_request",
      "raw WASI worker child command env must be an object",
      "runtime",
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, envValue]) => [
      String(key),
      String(envValue),
    ]),
  );
}

function cloneChildCommandInput(value) {
  if (typeof value === "string") {
    return value;
  }
  return copyBytes(value);
}

function workerChildCommandResult(result = {}) {
  const childResult = {
    command: String(result.command ?? ""),
    exitCode: Number(result.exitCode ?? 0),
    packageId: String(result.packageId ?? ""),
    stderr: result.stderr == null ? new Uint8Array() : copyBytes(result.stderr),
    stderrBytes: Number(result.stderrBytes ?? result.stderr?.byteLength ?? 0),
    stdout: result.stdout == null ? new Uint8Array() : copyBytes(result.stdout),
    stdoutBytes: Number(result.stdoutBytes ?? result.stdout?.byteLength ?? 0),
  };
  const diagnostics = normalizeRawWasiResultDiagnostics(result.diagnostics);
  if (diagnostics) {
    childResult.diagnostics = diagnostics;
  }
  return childResult;
}

function concatBytes(chunks, size) {
  const total =
    size ?? chunks.reduce((current, chunk) => current + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function addWorkerListener(worker, type, listener) {
  worker.addEventListener?.(type, listener);
}

function removeWorkerListener(worker, type, listener) {
  worker.removeEventListener?.(type, listener);
}

function terminateExecutionWorker(worker) {
  try {
    void worker.terminate?.();
  } catch {
    // Termination is best effort; the run is already settled.
  }
}

function postMessageToExecutionWorker(worker, message, stdinBytes) {
  const transfer =
    stdinBytes?.byteLength > 0 && stdinBytes.buffer instanceof ArrayBuffer
      ? [stdinBytes.buffer]
      : [];
  worker.postMessage(message, transfer);
}

function postMessageToChildCommandWorker(worker, message) {
  worker.postMessage(message);
}

function workerErrorPayload(error) {
  if (error instanceof BrowserWasiModuleError || typeof error?.kind === "string") {
    return {
      cancelled: error.cancelled === true,
      diagnostics: normalizeRawWasiResultDiagnostics(error.diagnostics),
      exitCode: error.exitCode ?? null,
      kind: error.kind,
      message: error.message ?? "raw WASI module execution failed",
      stage: error.stage ?? "runtime",
      timedOut: error.timedOut === true,
    };
  }
  return {
    cancelled: false,
    diagnostics: null,
    exitCode: null,
    kind: "runtime",
    message: error?.message ?? "raw WASI module execution failed",
    stage: "runtime",
    timedOut: false,
  };
}

function workerErrorFromPayload(error = {}) {
  return new BrowserWasiModuleError(
    error.kind ?? "runtime",
    error.message ?? "raw WASI module execution failed",
    error.stage ?? "runtime",
    {
      cancelled: error.cancelled,
      diagnostics: error.diagnostics,
      exitCode: error.exitCode,
      timedOut: error.timedOut,
    },
  );
}

function abortError() {
  return new DOMException("The operation was aborted", "AbortError");
}

function postMessageToWorkerHost(message) {
  globalThis.postMessage(message);
}

function stringListBufferSize(values) {
  return values.reduce(
    (total, value) => total + encodeText(value).byteLength + 1,
    0,
  );
}

function encodeCString(value) {
  const text = encodeText(value);
  const result = new Uint8Array(text.byteLength + 1);
  result.set(text);
  return result;
}

function encodeText(value) {
  return new TextEncoder().encode(String(value));
}

function decodeText(value) {
  return new TextDecoder().decode(value);
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let text = "";
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return globalThis.btoa(text);
}

function base64ToBytes(value) {
  const text = String(value ?? "");
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(text, "base64"));
  }
  const decoded = globalThis.atob(text);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function workspacePath(path) {
  return path ? `${WORKSPACE_PREOPEN_PATH}/${path}` : WORKSPACE_PREOPEN_PATH;
}

function compareSnapshotPathRecords(left, right) {
  return left.path.localeCompare(right.path);
}

function cloneWorkspaceSnapshot(snapshot) {
  return {
    directories: (snapshot.directories ?? []).map((entry) => ({ ...entry })),
    files: (snapshot.files ?? []).map((entry) => ({ ...entry })),
    root: snapshot.root,
    version: snapshot.version,
  };
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new BrowserWasiModuleError(
      "unsupported",
      "Web Crypto SHA-256 is unavailable for raw WASI module loading",
      "package_load",
    );
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

function normalizeSha256(value) {
  const text = String(value ?? "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw new BrowserWasiModuleError(
      "invalid_package",
      "raw WASI module sha256 must be a 64-character hex digest",
      "package_load",
    );
  }
  return text;
}

function verifyExpectedSha256(expected, actual) {
  if (expected == null) {
    return;
  }
  const normalized = normalizeSha256(expected);
  if (normalized !== actual) {
    throw new BrowserWasiModuleError(
      "invalid_package",
      `raw WASI module sha256 mismatch: expected ${normalized}, got ${actual}`,
      "package_load",
    );
  }
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function startsWithBytes(bytes, prefix) {
  if (bytes.byteLength < prefix.byteLength) {
    return false;
  }
  return prefix.every((byte, index) => bytes[index] === byte);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
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
  throw new BrowserWasiModuleError(
    "invalid_package",
    "raw WASI module bytes must be a byte buffer",
    "package_load",
  );
}

function copyBytes(value) {
  const bytes = toUint8Array(value);
  return new Uint8Array(bytes);
}

function nonEmptyString(value, message = "raw WASI module fields are required") {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new BrowserWasiModuleError("invalid_package", message, "package_load");
  }
  return text;
}
