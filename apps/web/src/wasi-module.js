import {
  createMemoryBrowserWorkspaceStore,
  normalizeWorkspacePath,
} from "./workspace.js";

const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
const DEFAULT_PACKAGE_ID = "default";
const DEFAULT_ENTRYPOINT = "_start";
const RAW_WASI_ARTIFACT_KIND = "wasi-module";
const WASI_IMPORT_MODULE = "wasi_snapshot_preview1";

const ERRNO_SUCCESS = 0;
const ERRNO_ACCESS = 2;
const ERRNO_BADF = 8;
const ERRNO_EXIST = 20;
const ERRNO_FAULT = 21;
const ERRNO_INVAL = 28;
const ERRNO_ISDIR = 31;
const ERRNO_NOENT = 44;
const ERRNO_NOTDIR = 54;
const ERRNO_NOTEMPTY = 55;
const ERRNO_NOTSUP = 58;
const ERRNO_OVERFLOW = 61;
const ERRNO_NOTCAPABLE = 76;
const STDIN_FD = 0;
const STDOUT_FD = 1;
const STDERR_FD = 2;
const WORKSPACE_FD = 3;
const TMP_FD = 4;
const FIRST_FILE_FD = 5;
const WASI_CLOCK_REALTIME = 0;
const WASI_CLOCK_MONOTONIC = 1;
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
const WORKSPACE_PREOPEN_PATH = "/workspace";
const TMP_PREOPEN_PATH = "/tmp";
const NANOS_PER_MILLI = 1_000_000n;
const CLOCK_RESOLUTION_NANOS = NANOS_PER_MILLI;
const WASI_ADVICE_NOREUSE = 5;
const RANDOM_GET_CHUNK_SIZE = 65_536;
let workerRunCounter = 0;

export class BrowserWasiModuleError extends Error {
  constructor(kind, message, stage = "runtime", options = {}) {
    super(message);
    this.name = "BrowserWasiModuleError";
    this.kind = kind;
    this.stage = stage;
    this.exitCode = options.exitCode ?? null;
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
      sha256,
      source,
      wasi: "preview1",
    },
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
    workspaceSnapshot: request.workspaceSnapshot ?? options.workspaceSnapshot,
    workspaceStore: request.workspaceStore ?? options.workspaceStore,
  });
  let instance = null;
  const wasi = new WasiPreview1Runtime({
    args: [request.command, ...request.args],
    env: request.env,
    getInstance: () => instance,
    output,
    signal: request.signal,
    stdin,
    workspace,
  });

  try {
    const instantiated = await globalThis.WebAssembly.instantiate(bytes, {
      [WASI_IMPORT_MODULE]: wasi.imports(),
    });
    instance = instantiated.instance ?? instantiated;
    const memory = exportedMemory(instance);
    wasi.setMemory(memory);
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
    throwIfAborted(request.signal);
    start();
    throwIfAborted(request.signal);
    return await workspaceResult({ exitCode: 0 }, workspace);
  } catch (error) {
    if (error instanceof WasiProcExit) {
      return await workspaceResult({ exitCode: error.exitCode }, workspace);
    }
    if (error instanceof BrowserWasiModuleError) {
      throw error;
    }
    throw new BrowserWasiModuleError(
      "runtime",
      error?.message ?? "raw WASI module execution failed",
      "runtime",
    );
  }
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
  if (!message || message.type !== "wasi.run") {
    return;
  }
  const { id, request } = message;
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
    const result = await runRawWasiModule(request, output, { worker: false });
    postMessageToWorkerHost({ type: "wasi.complete", id, result });
  } catch (error) {
    postMessageToWorkerHost({
      type: "wasi.error",
      id,
      error: workerErrorPayload(error),
    });
  }
}

async function createWasiWorkspaceMount(options = {}) {
  if (options.workspaceStore) {
    validateWorkspaceStore(options.workspaceStore);
    return writableWorkspaceMountFromSnapshot(
      await options.workspaceStore.exportSnapshot(),
      { files: options.files, store: options.workspaceStore },
    );
  }
  if (options.workspaceSnapshot) {
    return writableWorkspaceMountFromSnapshot(options.workspaceSnapshot, {
      files: options.files,
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
    store: options.store ?? null,
    writable: true,
  };
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
    this.args = normalizeStringList(options.args ?? []);
    this.env = normalizeEnv(options.env ?? {});
    this.getInstance = options.getInstance;
    this.memory = null;
    this.output = options.output;
    this.workspace = options.workspace;
    this.files = this.workspace.files;
    this.workspaceDirs = this.workspace.dirs;
    this.openFiles = new Map();
    this.scratchDirs = new Set([""]);
    this.scratchFiles = new Map();
    this.nextFileFd = FIRST_FILE_FD;
    this.signal = options.signal;
    this.stdin = toUint8Array(options.stdin ?? new Uint8Array());
    this.stdinOffset = 0;
  }

  setMemory(memory) {
    this.memory = memory;
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
      random.getRandomValues(
        bytes.subarray(start + offset, start + offset + chunkLength),
      );
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

  fdPwrite(fd, iovsPtr, iovsLen, offset, nwrittenPtr) {
    this.throwIfAborted();
    const file = this.openFiles.get(fd);
    this.writeU32(nwrittenPtr, 0);
    if (fd === WORKSPACE_FD || fd === TMP_FD || isOpenDirectory(file)) {
      return ERRNO_ISDIR;
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
    if (fd === WORKSPACE_FD || fd === TMP_FD || isOpenDirectory(file)) {
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

  fdPread(fd, iovsPtr, iovsLen, offset, nreadPtr) {
    this.throwIfAborted();
    const file = this.openFiles.get(fd);
    this.writeU32(nreadPtr, 0);
    if (fd === WORKSPACE_FD || fd === TMP_FD || isOpenDirectory(file)) {
      return ERRNO_ISDIR;
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
    if (!file) {
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
    if (!file) {
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
    if (this.openFiles.delete(fd)) {
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

    this.openFiles.delete(fd);
    this.openFiles.set(to, file);
    if (to >= this.nextFileFd) {
      this.nextFileFd = to + 1;
    }
    return ERRNO_SUCCESS;
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
    const stat = this.workspacePathStat(fd, path) ?? this.scratchPathStat(fd, path);
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
    const path = preopenPath(fd);
    if (!path) {
      return ERRNO_BADF;
    }
    this.writeU32(prestatPtr, WASI_PREOPENTYPE_DIR);
    this.writeU32(prestatPtr + 4, encodeText(path).byteLength);
    return ERRNO_SUCCESS;
  }

  fdPrestatDirName(fd, pathPtr, pathLen) {
    this.throwIfAborted();
    const preopenedPath = preopenPath(fd);
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
    if (fd !== WORKSPACE_FD) {
      return this.fdStat(fd) ? ERRNO_NOTCAPABLE : ERRNO_BADF;
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
    const path = normalizeWasiPath(this.readString(pathPtr, pathLen));
    if (!path) {
      return ERRNO_NOTCAPABLE;
    }
    const file = this.files.get(path);
    if (!file) {
      return ERRNO_NOENT;
    }
    const openedFd = this.nextFileFd;
    this.nextFileFd += 1;
    this.openFiles.set(openedFd, {
      offset: 0,
      path,
      record: file,
      rights: WASI_REGULAR_FILE_RIGHTS,
      fdflags: 0,
      writable: false,
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
      !this.workspaceDirs.has(path) &&
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
    const file = this.openFiles.get(fd);
    if (file) {
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

  markOpenFileDirty(file) {
    if (file?.mount === "workspace") {
      file.record.fallback = false;
      this.markWorkspaceDirty();
    }
  }

  readString(ptr, length) {
    return decodeText(this.bytes().slice(ptr, ptr + (length >>> 0)));
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

  pollOneoff(_subscriptionsPtr, _eventsPtr, subscriptionsLen, _eventsUsedPtr) {
    this.throwIfAborted();
    return subscriptionsLen === 0 ? ERRNO_INVAL : ERRNO_NOTSUP;
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

function isOpenDirectory(file) {
  return file?.kind === "directory";
}

function isOpenScratchDirectory(file) {
  return isOpenDirectory(file) && file.mount !== "workspace";
}

function isOpenWorkspaceDirectory(file) {
  return isOpenDirectory(file) && file.mount === "workspace";
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

function normalizeEnv(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserWasiModuleError(
      "invalid_request",
      "raw WASI module env must be an object",
      "startup",
    );
  }
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
    env: { ...(request.env ?? {}) },
    package: request.package,
    stdinBytes,
    terminal: { ...(request.terminal ?? {}) },
    workspaceSnapshot: request.workspaceSnapshot
      ? cloneWorkspaceSnapshot(request.workspaceSnapshot)
      : undefined,
  };
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

function workerErrorPayload(error) {
  if (error instanceof BrowserWasiModuleError || typeof error?.kind === "string") {
    return {
      exitCode: error.exitCode ?? null,
      kind: error.kind,
      message: error.message ?? "raw WASI module execution failed",
      stage: error.stage ?? "runtime",
    };
  }
  return {
    exitCode: null,
    kind: "runtime",
    message: error?.message ?? "raw WASI module execution failed",
    stage: "runtime",
  };
}

function workerErrorFromPayload(error = {}) {
  return new BrowserWasiModuleError(
    error.kind ?? "runtime",
    error.message ?? "raw WASI module execution failed",
    error.stage ?? "runtime",
    { exitCode: error.exitCode },
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
