const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
const DEFAULT_PACKAGE_ID = "default";
const DEFAULT_ENTRYPOINT = "_start";
const RAW_WASI_ARTIFACT_KIND = "wasi-module";
const WASI_IMPORT_MODULE = "wasi_snapshot_preview1";

const ERRNO_SUCCESS = 0;
const ERRNO_ACCESS = 2;
const ERRNO_BADF = 8;
const ERRNO_FAULT = 21;
const ERRNO_INVAL = 28;
const ERRNO_ISDIR = 31;
const ERRNO_NOENT = 44;
const ERRNO_OVERFLOW = 61;
const ERRNO_NOTCAPABLE = 76;
const STDIN_FD = 0;
const STDOUT_FD = 1;
const STDERR_FD = 2;
const WORKSPACE_FD = 3;
const FIRST_FILE_FD = 4;
const WASI_CLOCK_REALTIME = 0;
const WASI_CLOCK_MONOTONIC = 1;
const WASI_FILETYPE_CHARACTER_DEVICE = 2;
const WASI_FILETYPE_DIRECTORY = 3;
const WASI_FILETYPE_REGULAR_FILE = 4;
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
const WASI_RIGHT_FD_DATASYNC = 1n << 0n;
const WASI_RIGHT_FD_READ = 1n << 1n;
const WASI_RIGHT_FD_SEEK = 1n << 2n;
const WASI_RIGHT_FD_FDSTAT_SET_FLAGS = 1n << 3n;
const WASI_RIGHT_FD_SYNC = 1n << 4n;
const WASI_RIGHT_FD_TELL = 1n << 5n;
const WASI_RIGHT_FD_WRITE = 1n << 6n;
const WASI_RIGHT_FD_ALLOCATE = 1n << 8n;
const WASI_RIGHT_PATH_CREATE_DIRECTORY = 1n << 9n;
const WASI_RIGHT_PATH_CREATE_FILE = 1n << 10n;
const WASI_RIGHT_PATH_OPEN = 1n << 13n;
const WASI_RIGHT_PATH_FILESTAT_GET = 1n << 18n;
const WASI_RIGHT_PATH_FILESTAT_SET_SIZE = 1n << 19n;
const WASI_RIGHT_PATH_FILESTAT_SET_TIMES = 1n << 20n;
const WASI_RIGHT_FD_FILESTAT_GET = 1n << 21n;
const WASI_RIGHT_FD_FILESTAT_SET_SIZE = 1n << 22n;
const WASI_RIGHT_FD_FILESTAT_SET_TIMES = 1n << 23n;
const WASI_RIGHT_PATH_UNLINK_FILE = 1n << 26n;
const WASI_STDIN_RIGHTS =
  WASI_RIGHT_FD_READ | WASI_RIGHT_FD_FDSTAT_SET_FLAGS;
const WASI_STDOUT_RIGHTS =
  WASI_RIGHT_FD_WRITE | WASI_RIGHT_FD_FDSTAT_SET_FLAGS;
const WASI_WORKSPACE_RIGHTS =
  WASI_RIGHT_PATH_OPEN |
  WASI_RIGHT_PATH_FILESTAT_GET |
  WASI_RIGHT_FD_FILESTAT_GET;
const WASI_REGULAR_FILE_RIGHTS =
  WASI_RIGHT_FD_READ |
  WASI_RIGHT_FD_SEEK |
  WASI_RIGHT_FD_FDSTAT_SET_FLAGS |
  WASI_RIGHT_FD_TELL |
  WASI_RIGHT_FD_FILESTAT_GET;
const WASI_WRITE_RIGHTS =
  WASI_RIGHT_FD_DATASYNC |
  WASI_RIGHT_FD_SYNC |
  WASI_RIGHT_FD_WRITE |
  WASI_RIGHT_FD_ALLOCATE |
  WASI_RIGHT_PATH_CREATE_DIRECTORY |
  WASI_RIGHT_PATH_CREATE_FILE |
  WASI_RIGHT_PATH_FILESTAT_SET_SIZE |
  WASI_RIGHT_PATH_FILESTAT_SET_TIMES |
  WASI_RIGHT_FD_FILESTAT_SET_SIZE |
  WASI_RIGHT_FD_FILESTAT_SET_TIMES |
  WASI_RIGHT_PATH_UNLINK_FILE;
const WORKSPACE_PREOPEN_PATH = "/workspace";
const NANOS_PER_MILLI = 1_000_000n;
const CLOCK_RESOLUTION_NANOS = NANOS_PER_MILLI;
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
  if (options.worker !== false && typeof createWorker === "function") {
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
  let instance = null;
  const wasi = new WasiPreview1Runtime({
    args: [request.command, ...request.args],
    env: request.env,
    files: packageRecord.files,
    getInstance: () => instance,
    output,
    signal: request.signal,
    stdin,
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
    return { exitCode: 0 };
  } catch (error) {
    if (error instanceof WasiProcExit) {
      return { exitCode: error.exitCode };
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
  const workerRequest = await workerRunRequest(request);
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

class WasiPreview1Runtime {
  constructor(options) {
    this.args = normalizeStringList(options.args ?? []);
    this.env = normalizeEnv(options.env ?? {});
    this.getInstance = options.getInstance;
    this.memory = null;
    this.output = options.output;
    this.files = new Map(
      (options.files ?? []).map((file) => [
        file.path,
        { bytes: toUint8Array(file.bytes), path: file.path },
      ]),
    );
    this.openFiles = new Map();
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
      fd_seek: (fd, offset, whence, newOffsetPtr) =>
        this.fdSeek(fd, offset, whence, newOffsetPtr),
      fd_tell: (fd, offsetPtr) => this.fdTell(fd, offsetPtr),
      fd_fdstat_get: (fd, fdstatPtr) => this.fdFdstatGet(fd, fdstatPtr),
      fd_fdstat_set_flags: (fd, flags) => this.fdFdstatSetFlags(fd, flags),
      fd_close: (fd) => this.fdClose(fd),
      fd_filestat_get: (fd, filestatPtr) =>
        this.fdFilestatGet(fd, filestatPtr),
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
      random_get: (bufferPtr, bufferLength) =>
        this.randomGet(bufferPtr, bufferLength),
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

  fdWrite(fd, iovsPtr, iovsLen, nwrittenPtr) {
    this.throwIfAborted();
    if (fd !== STDOUT_FD && fd !== STDERR_FD) {
      this.writeU32(nwrittenPtr, 0);
      return ERRNO_BADF;
    }

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
    this.writeU32(nwrittenPtr, total);

    for (const chunk of chunks) {
      if (fd === STDOUT_FD) {
        void this.output.writeStdout(chunk);
      } else {
        void this.output.writeStderr(chunk);
      }
    }
    return ERRNO_SUCCESS;
  }

  fdRead(fd, iovsPtr, iovsLen, nreadPtr) {
    this.throwIfAborted();
    if (fd === WORKSPACE_FD) {
      this.writeU32(nreadPtr, 0);
      return ERRNO_ISDIR;
    }
    const file = this.openFiles.get(fd);
    if (fd !== STDIN_FD && !file) {
      this.writeU32(nreadPtr, 0);
      return ERRNO_BADF;
    }

    let total = 0;
    for (let index = 0; index < iovsLen; index += 1) {
      const input = file?.bytes ?? this.stdin;
      const inputOffset = file?.offset ?? this.stdinOffset;
      if (inputOffset >= input.byteLength) {
        break;
      }
      const iovPtr = iovsPtr + index * 8;
      const dataPtr = this.readU32(iovPtr);
      const dataLength = this.readU32(iovPtr + 4);
      const available = input.byteLength - inputOffset;
      const readLength = Math.min(dataLength, available);
      if (readLength > 0) {
        this.bytes().set(
          input.subarray(inputOffset, inputOffset + readLength),
          dataPtr,
        );
        if (file) {
          file.offset += readLength;
        } else {
          this.stdinOffset += readLength;
        }
        total += readLength;
      }
    }
    this.writeU32(nreadPtr, total);
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

  fdClose(fd) {
    this.throwIfAborted();
    if (this.openFiles.delete(fd)) {
      return ERRNO_SUCCESS;
    }
    return ERRNO_BADF;
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

  pathFilestatGet(fd, flags, pathPtr, pathLen, filestatPtr) {
    this.throwIfAborted();
    if (fd !== WORKSPACE_FD) {
      return this.fdStat(fd) ? ERRNO_ACCESS : ERRNO_BADF;
    }
    if ((flags & ~WASI_LOOKUP_SYMLINK_FOLLOW) !== 0) {
      return ERRNO_INVAL;
    }

    const stat = this.pathStat(this.readString(pathPtr, pathLen));
    if (stat.errno != null) {
      return stat.errno;
    }
    this.writeFilestat(filestatPtr, stat.filetype, stat.size ?? 0);
    return ERRNO_SUCCESS;
  }

  fdPrestatGet(fd, prestatPtr) {
    this.throwIfAborted();
    if (fd !== WORKSPACE_FD) {
      return ERRNO_BADF;
    }
    this.writeU32(prestatPtr, WASI_PREOPENTYPE_DIR);
    this.writeU32(prestatPtr + 4, encodeText(WORKSPACE_PREOPEN_PATH).byteLength);
    return ERRNO_SUCCESS;
  }

  fdPrestatDirName(fd, pathPtr, pathLen) {
    this.throwIfAborted();
    if (fd !== WORKSPACE_FD) {
      return ERRNO_BADF;
    }
    const path = encodeText(WORKSPACE_PREOPEN_PATH);
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
    if (fd !== WORKSPACE_FD) {
      return this.fdStat(fd) ? ERRNO_NOTCAPABLE : ERRNO_BADF;
    }
    if ((dirflags & ~WASI_LOOKUP_SYMLINK_FOLLOW) !== 0) {
      return ERRNO_INVAL;
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
      bytes: file.bytes,
      offset: 0,
      path,
    });
    this.writeU32(openedFdPtr, openedFd);
    return ERRNO_SUCCESS;
  }

  pathStat(pathValue) {
    const pathText = String(pathValue ?? "");
    if (pathText === "") {
      return { errno: ERRNO_NOENT };
    }
    const path = normalizeWasiLookupPath(pathText);
    if (path == null) {
      return { errno: ERRNO_NOTCAPABLE };
    }
    if (path === "") {
      return {
        filetype: WASI_FILETYPE_DIRECTORY,
        size: 0,
      };
    }
    const file = this.files.get(path);
    if (!file) {
      return { errno: ERRNO_NOENT };
    }
    return {
      filetype: WASI_FILETYPE_REGULAR_FILE,
      size: file.bytes.byteLength,
    };
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
        inheriting: WASI_REGULAR_FILE_RIGHTS,
        rights: WASI_WORKSPACE_RIGHTS,
        size: 0,
      };
    }
    const file = this.openFiles.get(fd);
    if (file) {
      return {
        filetype: WASI_FILETYPE_REGULAR_FILE,
        inheriting: 0n,
        rights: WASI_REGULAR_FILE_RIGHTS,
        size: file.bytes.byteLength,
      };
    }
    return null;
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
}

function isSupportedClock(clockId) {
  return clockId === WASI_CLOCK_REALTIME || clockId === WASI_CLOCK_MONOTONIC;
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
      base = BigInt(file.bytes.byteLength);
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
