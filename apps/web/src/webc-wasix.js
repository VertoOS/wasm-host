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

const UNSUPPORTED_CAPABILITY_EXIT_CODE = 126;
const COMMAND_NOT_FOUND_EXIT_CODE = 127;

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
      const execName = nonEmptyString(command.execName ?? request.command);
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
      });
      return rawWasiExecutor.run(
        {
          ...request,
          args: [...(command.mainArgs ?? []), ...(request.args ?? [])],
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
