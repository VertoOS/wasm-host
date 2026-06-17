import {
  createRawWasiModuleExecutor,
  loadRawWasiModulePackage,
} from "./wasi-module.js";

export const WEBC_PACKAGE_TYPE = "webc-package";
export const WEBC_WASIX_EXECUTOR_TYPE = "webc-wasix";
export const WEBC_WASIX_UNIMPLEMENTED_KIND =
  "webc_wasix_runtime_unimplemented";
export const WEBC_WASIX_ATOM_METADATA_MISSING_KIND =
  "webc_wasix_atom_metadata_missing";
export const WEBC_WASIX_ATOM_ARTIFACT_MISSING_KIND =
  "webc_wasix_atom_artifact_missing";
export const WEBC_WASIX_ATOM_CACHE_UNAVAILABLE_KIND =
  "webc_wasix_atom_cache_unavailable";
export const WEBC_WASIX_ATOM_CACHE_MISSING_KIND =
  "webc_wasix_atom_cache_missing";
export const WEBC_WASIX_PACKAGE_BYTES_UNAVAILABLE_KIND =
  "webc_wasix_package_bytes_unavailable";
export const WEBC_WASIX_PACKAGE_BYTES_MISSING_KIND =
  "webc_wasix_package_bytes_missing";
export const WEBC_WASIX_VOLUME_SPAN_INVALID_KIND =
  "webc_wasix_volume_span_invalid";

const UNSUPPORTED_CAPABILITY_EXIT_CODE = 126;
const COMMAND_NOT_FOUND_EXIT_CODE = 127;
const COMMAND_SHIM_BYTES = new TextEncoder().encode(
  "# wasm-host packaged command\n",
);

export function createWebcWasixExecutor(options = {}) {
  const rawWasiExecutor =
    options.rawWasiExecutor ??
    createRawWasiModuleExecutor(options.rawWasi ?? options.wasiModule ?? {});
  return {
    async run(request, output) {
      validateWebcWasixCommand(request);
      throwIfAborted(request.signal);
      const command = webcCommandMetadata(request);
      if (!isWasiRunner(command.runner)) {
        throw webcWasixRuntimeUnavailable({
          ...options,
          message: `browser WebC runner is not supported: ${String(command.runner ?? "")}`,
        });
      }
      const atomName = command.atom;
      if (!atomName) {
        throw webcWasixError(
          WEBC_WASIX_ATOM_METADATA_MISSING_KIND,
          `browser WebC command ${request.command} does not declare an atom`,
          "command_resolution",
        );
      }
      const atom = webcAtomArtifact(request, atomName);
      const atomBytes = await readAtomBytes(atom, options);
      const rootFiles = mergeRootFiles(
        await readWebcRootFiles(request, options),
        catalogCommandRootFiles(request.commandCatalog),
      );
      const execName = nonEmptyString(command.execName ?? request.command);
      const args = request.wasixExecArgv0
        ? stripWasixExecArgv0(request.args, request.command, execName)
        : request.args;
      const packageRecord = await loadRawWasiModulePackage({
        artifactKind: "wasi-module",
        bytes: atomBytes,
        command: execName,
        id: `${request.package.id}:${request.command}`,
        metadata: {
          atom: atomName,
          packageId: request.package.id,
          sourcePackage: request.package.metadata?.packageName ?? request.package.id,
          webcCommand: request.command,
        },
        rootFiles,
      });
      return rawWasiExecutor.run(
        {
          ...request,
          args: [...(command.mainArgs ?? []), ...(args ?? [])],
          command: execName,
          cwd: command.cwd ?? request.cwd,
          env: mergeWebcEnv(command.env, request.env),
          package: packageRecord,
        },
        output,
      );
    },
  };
}

function validateWebcWasixCommand(request) {
  if (!request?.package?.commands?.includes(request.command)) {
    throw {
      exitCode: COMMAND_NOT_FOUND_EXIT_CODE,
      kind: "command_not_found",
      message: `browser command not found: ${String(request?.command ?? "")}`,
      stage: "command_resolution",
    };
  }
}

function webcCommandMetadata(request) {
  const command = request.package?.metadata?.commandMetadata?.[request.command];
  if (!command || typeof command !== "object") {
    throw webcWasixError(
      WEBC_WASIX_ATOM_METADATA_MISSING_KIND,
      `browser WebC command metadata is missing for ${String(request.command)}`,
      "command_resolution",
    );
  }
  return command;
}

function isWasiRunner(value) {
  if (value == null) {
    return true;
  }
  return (
    typeof value === "string" &&
    (value === "wasi" || value.endsWith("/wasi"))
  );
}

function webcAtomArtifact(request, atomName) {
  const atom = request.package?.metadata?.webcArtifacts?.atoms?.[atomName];
  if (!atom || typeof atom !== "object" || !atom.cacheKey) {
    throw webcWasixError(
      WEBC_WASIX_ATOM_ARTIFACT_MISSING_KIND,
      `browser WebC atom artifact is missing for ${atomName}`,
      "package_load",
    );
  }
  return atom;
}

async function readAtomBytes(atom, options) {
  if (atom.bytes != null) {
    return toUint8Array(atom.bytes);
  }
  const cache = options.cache;
  if (typeof cache?.getModuleArtifact !== "function") {
    throw webcWasixError(
      WEBC_WASIX_ATOM_CACHE_UNAVAILABLE_KIND,
      "browser WebC atom cache is unavailable",
      "package_load",
    );
  }
  const bytes = await cache.getModuleArtifact(atom.cacheKey);
  if (bytes == null) {
    throw webcWasixError(
      WEBC_WASIX_ATOM_CACHE_MISSING_KIND,
      `browser WebC atom bytes are missing from cache: ${atom.cacheKey}`,
      "package_load",
    );
  }
  return toUint8Array(bytes);
}

async function readWebcRootFiles(request, options) {
  const mounts = webcVolumeMounts(request);
  if (mounts.length === 0) {
    return [];
  }
  const packageBytes = await readPackageBytes(request, options);
  const files = [];
  for (const mount of mounts) {
    for (const file of Object.values(mount.volume.files ?? {})) {
      files.push({
        bytes: bytesFromSpan(packageBytes, file.span, file.path),
        path: mountedPackageRootPath(file.path, mount),
      });
    }
  }
  return files;
}

function catalogCommandRootFiles(commandCatalog) {
  const files = [];
  const seen = new Set();
  for (const entry of commandCatalog ?? []) {
    const path = catalogCommandRootPath(entry?.path);
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    files.push({
      bytes: COMMAND_SHIM_BYTES,
      path,
    });
  }
  return files;
}

function catalogCommandRootPath(pathValue) {
  if (typeof pathValue !== "string" || !pathValue.startsWith("/")) {
    return null;
  }
  return joinPackageRootPath("", trimSlashes(pathValue));
}

function mergeRootFiles(primaryFiles, fallbackFiles) {
  const files = [];
  const paths = new Set();
  for (const file of primaryFiles ?? []) {
    files.push(file);
    paths.add(file.path);
  }
  for (const file of fallbackFiles ?? []) {
    if (paths.has(file.path)) {
      continue;
    }
    files.push(file);
    paths.add(file.path);
  }
  return files;
}

function stripWasixExecArgv0(args = [], commandName, execName) {
  const [first, ...rest] = args ?? [];
  if (
    first != null &&
    (commandBasename(first) === commandBasename(commandName) ||
      commandBasename(first) === commandBasename(execName))
  ) {
    return rest;
  }
  return args ?? [];
}

function commandBasename(value) {
  const text = String(value ?? "").trim();
  const parts = text.split("/").filter(Boolean);
  return parts.at(-1) ?? text;
}

function webcVolumeMounts(request) {
  const mappings = request.package?.metadata?.filesystem ?? [];
  const volumes = request.package?.metadata?.webcArtifacts?.volumes ?? {};
  const mounts = [];
  for (const mapping of mappings) {
    if (mapping.from) {
      continue;
    }
    const volume = volumes[mapping.volumeName];
    if (volume) {
      mounts.push({ mapping, volume });
    }
  }
  return mounts;
}

async function readPackageBytes(request, options) {
  if (request.package?.bytes != null) {
    return toUint8Array(request.package.bytes);
  }
  const cacheKey = request.package?.metadata?.cacheKeys?.packageBytes;
  const cache = options.cache;
  if (typeof cache?.getPackageBytes !== "function") {
    throw webcWasixError(
      WEBC_WASIX_PACKAGE_BYTES_UNAVAILABLE_KIND,
      "browser WebC package byte cache is unavailable",
      "package_load",
    );
  }
  const bytes = await cache.getPackageBytes(cacheKey);
  if (bytes == null) {
    throw webcWasixError(
      WEBC_WASIX_PACKAGE_BYTES_MISSING_KIND,
      `browser WebC package bytes are missing from cache: ${String(cacheKey ?? "")}`,
      "package_load",
    );
  }
  return toUint8Array(bytes);
}

function bytesFromSpan(packageBytes, spanValue, path) {
  const offset = Number(spanValue?.offset);
  const length = Number(spanValue?.length);
  const end = offset + length;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    end > packageBytes.byteLength
  ) {
    throw webcWasixError(
      WEBC_WASIX_VOLUME_SPAN_INVALID_KIND,
      `browser WebC volume file span is invalid for ${path}`,
      "package_load",
    );
  }
  return packageBytes.subarray(offset, end);
}

function mountedPackageRootPath(filePath, mount) {
  const mapping = mount.mapping;
  let path = trimSlashes(filePath);
  path = stripPathPrefix(path, trimSlashes(mount.volume.name));
  path = stripPathPrefix(path, trimSlashes(mapping.hostPath));
  path = joinPackageRootPath(trimSlashes(mapping.mountPath), path);
  if (!path) {
    throw webcWasixError(
      WEBC_WASIX_VOLUME_SPAN_INVALID_KIND,
      `browser WebC volume file path is invalid for ${filePath}`,
      "package_load",
    );
  }
  return path;
}

function stripPathPrefix(path, prefix) {
  if (!prefix) {
    return path;
  }
  if (path === prefix) {
    return "";
  }
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path;
}

function joinPackageRootPath(mountPath, path) {
  const joined = [mountPath, path].filter(Boolean).join("/");
  const segments = [];
  for (const segment of joined.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === ".." || segment.includes("\0")) {
      return null;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function trimSlashes(value) {
  return String(value ?? "").replace(/^\/+|\/+$/g, "");
}

function webcWasixRuntimeUnavailable(options) {
  return {
    exitCode: options.exitCode ?? UNSUPPORTED_CAPABILITY_EXIT_CODE,
    kind: options.kind ?? WEBC_WASIX_UNIMPLEMENTED_KIND,
    message:
      options.message ??
      "browser WebC/WASIX runtime execution is not implemented yet",
    stage: "runtime",
  };
}

function webcWasixError(kind, message, stage) {
  return {
    exitCode: UNSUPPORTED_CAPABILITY_EXIT_CODE,
    kind,
    message,
    stage,
  };
}

function mergeWebcEnv(metadataEnv = [], requestEnv = {}) {
  const env = {};
  for (const entry of metadataEnv ?? []) {
    const separator = entry.indexOf("=");
    if (separator < 0) {
      env[entry] = "";
    } else {
      env[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
  }
  for (const [key, value] of Object.entries(requestEnv ?? {})) {
    env[String(key)] = String(value);
  }
  return env;
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
  return new Uint8Array(value ?? []);
}

function nonEmptyString(value) {
  const text = String(value ?? "");
  if (!text) {
    throw webcWasixError(
      WEBC_WASIX_ATOM_METADATA_MISSING_KIND,
      "browser WebC command exec name is required",
      "command_resolution",
    );
  }
  return text;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) {
    return;
  }
  throw (
    signal.reason ?? {
      cancelled: true,
      exitCode: 130,
      kind: "cancelled",
      message: "browser command cancelled",
      stage: "runtime",
    }
  );
}
