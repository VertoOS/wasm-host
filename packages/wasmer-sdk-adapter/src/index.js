const DEFAULT_MOUNT_PATH = "/workspace";
const DEFAULT_PACKAGE_SOURCE = Object.freeze({ kind: "registry" });
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class WasmerSdkAdapterError extends Error {
  constructor(kind, message, options = {}) {
    super(message);
    this.name = "WasmerSdkAdapterError";
    this.kind = kind;
    this.code = kind;
    this.safe = options.safe ?? true;
    this.cause = options.cause;
  }
}

export function createWasmerSdkCommandExecutor(options = {}) {
  const sdkLoader = requiredFunction(
    options.sdkLoader,
    "createWasmerSdkCommandExecutor requires an sdkLoader",
  );
  const sdkInitOptions = options.sdkInitOptions ?? {};
  const packageSource = normalizePackageSource(
    options.packageSource ?? DEFAULT_PACKAGE_SOURCE,
  );
  const runtimeFactory = optionalFunction(options.runtimeFactory);
  const packageCache = new Map();
  let sdkPromise;

  return {
    async run(request, output = {}) {
      const normalized = normalizeWasmerRunRequest(request);
      const sdk = await loadSdk();
      const runtime = runtimeFactory ? runtimeFactory(sdk) : undefined;
      const wasmerPackage = await loadPackage(sdk, runtime, normalized);
      const command = selectCommand(wasmerPackage, normalized);
      const workspaceMount = await snapshotToWasmerDirectory(
        sdk,
        normalized.workspaceSnapshot,
      );
      const mount = {
        ...normalized.mount,
        [normalized.workspaceMountPath]: workspaceMount,
      };
      const instance = await command.run({
        args: normalized.args,
        cwd: normalized.cwd,
        env: normalized.env,
        mount,
        stdin: normalized.stdin,
        uses: normalized.uses,
      });
      const result = normalizeWasmerRunResult(await instance.wait());
      await writeOutput(output.stdout, result.stdoutBytes);
      await writeOutput(output.stderr, result.stderrBytes);
      const workspaceSnapshot = await wasmerDirectoryToSnapshot(
        workspaceMount,
      );
      return {
        diagnostics: sdkDiagnostics(packageSource),
        exitCode: result.exitCode,
        failureStage: null,
        stderrBytes: result.stderrBytes.byteLength,
        stdoutBytes: result.stdoutBytes.byteLength,
        workspaceSnapshot,
      };
    },
  };

  async function loadSdk() {
    if (!sdkPromise) {
      sdkPromise = Promise.resolve()
        .then(() => sdkLoader())
        .then(async (sdk) => {
          assertWasmerSdkShape(sdk);
          if (typeof sdk.init === "function") {
            await sdk.init(sdkInitOptions);
          }
          return sdk;
        });
    }
    return sdkPromise;
  }

  async function loadPackage(sdk, runtime, request) {
    const cacheKey = packageCacheKey(packageSource, request.package);
    if (cacheKey && packageCache.has(cacheKey)) {
      return packageCache.get(cacheKey);
    }
    let loadedPackage;
    if (packageSource.kind === "registry") {
      const specifier = request.package.version
        ? `${request.package.name}@${request.package.version}`
        : request.package.name;
      loadedPackage = await sdk.Wasmer.fromRegistry(specifier, runtime);
    } else if (packageSource.kind === "webc-bytes") {
      ensurePackageBytes(request.package, packageSource.kind);
      loadedPackage = await sdk.Wasmer.fromFile(request.package.bytes, runtime);
    } else if (packageSource.kind === "wasm-bytes") {
      ensurePackageBytes(request.package, packageSource.kind);
      loadedPackage = await sdk.Wasmer.fromWasm(request.package.bytes, runtime);
    } else {
      throw adapterError(
        "unsupported_package_source",
        `unsupported Wasmer SDK package source: ${packageSource.kind}`,
      );
    }
    if (cacheKey) {
      packageCache.set(cacheKey, loadedPackage);
    }
    return loadedPackage;
  }
}

export function normalizeWasmerRunRequest(request = {}) {
  const value = objectParam(request, "Wasmer SDK run request must be an object");
  const packageRequest = normalizePackageRequest(value.package ?? value);
  return {
    args: stringArray(value.args ?? []),
    command: optionalNonEmptyString(value.command, "command"),
    cwd: optionalNonEmptyString(value.cwd, "cwd"),
    env: stringRecord(value.env ?? {}),
    mount: objectParam(value.mount ?? {}, "mount must be an object"),
    package: packageRequest,
    stdin: optionalBytesOrString(value.stdin),
    uses: stringArray(value.uses ?? []),
    workspaceMountPath: optionalAbsolutePath(
      value.workspaceMountPath ?? DEFAULT_MOUNT_PATH,
      "workspaceMountPath",
    ),
    workspaceSnapshot: normalizeWorkspaceSnapshot(value.workspaceSnapshot ?? []),
  };
}

export function normalizeWasmerRunResult(output = {}) {
  const value = objectParam(output, "Wasmer SDK output must be an object");
  const stdoutBytes = bytesParam(
    value.stdoutBytes ?? value.stdout ?? "",
    "stdout",
  );
  const stderrBytes = bytesParam(
    value.stderrBytes ?? value.stderr ?? "",
    "stderr",
  );
  return {
    exitCode: nonNegativeInteger(value.code ?? value.exitCode ?? 0, "code"),
    ok: Boolean(value.ok ?? (value.code ?? value.exitCode ?? 0) === 0),
    stderr: textDecoder.decode(stderrBytes),
    stderrBytes,
    stdout: textDecoder.decode(stdoutBytes),
    stdoutBytes,
  };
}

export async function snapshotToWasmerDirectory(sdk, snapshot = []) {
  if (!sdk?.Directory) {
    throw adapterError(
      "missing_directory",
      "Wasmer SDK Directory constructor is required for workspace mounts",
    );
  }
  const directory = new sdk.Directory();
  for (const entry of normalizeWorkspaceSnapshot(snapshot)) {
    if (entry.type === "directory") {
      await ensureDirectory(directory, entry.path);
      continue;
    }
    await ensureDirectory(directory, parentPath(entry.path));
    await directory.writeFile(entry.path, entry.bytes);
  }
  return directory;
}

export async function wasmerDirectoryToSnapshot(directory, root = "/") {
  const snapshot = [];
  await collectDirectorySnapshot(directory, normalizeAbsolutePath(root, "root"), snapshot);
  return snapshot.sort(compareSnapshotEntries);
}

export function normalizePackageSource(source = DEFAULT_PACKAGE_SOURCE) {
  const value = objectParam(source, "package source must be an object");
  const kind = value.kind ?? "registry";
  if (!["registry", "webc-bytes", "wasm-bytes"].includes(kind)) {
    throw adapterError(
      "invalid_package_source",
      `invalid Wasmer SDK package source: ${kind}`,
    );
  }
  return { kind };
}

export const WASMER_SDK_ADAPTER_FINDINGS = Object.freeze({
  browserRequirements: Object.freeze([
    "secure-context",
    "Cross-Origin-Opener-Policy: same-origin",
    "Cross-Origin-Embedder-Policy: require-corp",
    "SharedArrayBuffer",
  ]),
  supportedPackageSources: Object.freeze([
    "registry packages through Wasmer.fromRegistry",
    "WebC bytes through Wasmer.fromFile when callers provide bytes",
    "raw Wasm bytes through Wasmer.fromWasm for non-package modules",
  ]),
  wasmHostOwnedResponsibilities: Object.freeze([
    "command request/result contract",
    "workspace snapshot ownership and persistence",
    "package pinning, hashing, and cache policy",
    "browser architecture boundary enforcement",
  ]),
  sdkOwnedResponsibilities: Object.freeze([
    "WASIX syscall implementation",
    "subprocess and thread runtime internals",
    "Wasmer registry package resolution",
    "Directory mount implementation",
  ]),
});

function selectCommand(wasmerPackage, request) {
  if (request.command) {
    const command = wasmerPackage.commands?.[request.command];
    if (!command) {
      throw adapterError(
        "command_not_found",
        `Wasmer SDK package does not expose command: ${request.command}`,
      );
    }
    return command;
  }
  if (wasmerPackage.entrypoint) {
    return wasmerPackage.entrypoint;
  }
  throw adapterError(
    "missing_entrypoint",
    "Wasmer SDK package has no entrypoint; specify a command",
  );
}

function normalizePackageRequest(value) {
  const request = objectParam(value, "package request must be an object");
  const name = nonEmptyString(request.name ?? request.packageName, "package.name");
  const version = optionalNonEmptyString(request.version, "package.version");
  const bytes =
    request.bytes === undefined ? undefined : bytesParam(request.bytes, "package.bytes");
  return bytes === undefined ? { name, version } : { bytes, name, version };
}

function normalizeWorkspaceSnapshot(snapshot) {
  if (!Array.isArray(snapshot)) {
    throw adapterError(
      "invalid_workspace_snapshot",
      "workspaceSnapshot must be an array",
    );
  }
  return snapshot.map((entry) => normalizeSnapshotEntry(entry));
}

function normalizeSnapshotEntry(entry) {
  const value = objectParam(entry, "workspace snapshot entries must be objects");
  const type = value.type ?? "file";
  if (type !== "file" && type !== "directory") {
    throw adapterError(
      "invalid_workspace_snapshot",
      `invalid workspace snapshot entry type: ${type}`,
    );
  }
  const path = normalizeAbsolutePath(value.path, "workspace entry path");
  if (type === "directory") {
    return { path, type };
  }
  return {
    bytes: bytesParam(value.bytes ?? value.contents ?? "", "workspace entry bytes"),
    path,
    type,
  };
}

async function ensureDirectory(directory, path) {
  const normalized = normalizeAbsolutePath(path || "/", "directory path");
  if (normalized === "/") {
    return;
  }
  const parts = normalized.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    try {
      await directory.createDir(current);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }
}

async function collectDirectorySnapshot(directory, path, snapshot) {
  let entries;
  try {
    entries = await directory.readDir(path);
  } catch (error) {
    if (path !== "/") {
      const bytes = await directory.readFile(path);
      snapshot.push({ bytes, path, type: "file" });
      return;
    }
    throw error;
  }
  if (path !== "/") {
    snapshot.push({ path, type: "directory" });
  }
  for (const entry of entries) {
    const entryPath = joinAbsolute(path, entry.name);
    if (entry.type === "dir" || entry.type === "directory") {
      await collectDirectorySnapshot(directory, entryPath, snapshot);
    } else if (entry.type === "file") {
      const bytes = await directory.readFile(entryPath);
      snapshot.push({ bytes, path: entryPath, type: "file" });
    }
  }
}

async function writeOutput(writer, bytes) {
  if (!writer || bytes.byteLength === 0) {
    return;
  }
  if (typeof writer.write === "function") {
    await writer.write(bytes);
    return;
  }
  if (typeof writer.append === "function") {
    await writer.append(bytes);
    return;
  }
  throw adapterError("invalid_output_writer", "output writer must expose write()");
}

function assertWasmerSdkShape(sdk) {
  if (!sdk?.Wasmer?.fromRegistry || !sdk?.Directory) {
    throw adapterError(
      "invalid_sdk",
      "sdkLoader must resolve to an @wasmer/sdk-compatible module",
    );
  }
}

function sdkDiagnostics(packageSource) {
  return [
    {
      group: "wasmer-sdk-adapter",
      name: "package-source",
      value: packageSource.kind,
    },
  ];
}

function packageCacheKey(source, pkg) {
  if (pkg.bytes) {
    return null;
  }
  return JSON.stringify({
    kind: source.kind,
    name: pkg.name,
    version: pkg.version,
  });
}

function ensurePackageBytes(pkg, sourceKind) {
  if (!pkg.bytes) {
    throw adapterError(
      "missing_package_bytes",
      `package bytes are required for Wasmer SDK ${sourceKind} sources`,
    );
  }
}

function bytesParam(value, field) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (typeof value === "string") {
    return textEncoder.encode(value);
  }
  throw adapterError("invalid_bytes", `${field} must be bytes or string`);
}

function optionalBytesOrString(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  return bytesParam(value, "stdin");
}

function objectParam(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw adapterError("invalid_request", message);
  }
  return value;
}

function stringArray(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw adapterError("invalid_request", "args must be an array of strings");
  }
  return [...value];
}

function stringRecord(value) {
  objectParam(value, "env must be an object");
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      nonEmptyString(key, "env name"),
      nonEmptyString(item, `env.${key}`),
    ]),
  );
}

function nonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw adapterError("invalid_request", `${field} must be a non-empty string`);
  }
  return value;
}

function optionalNonEmptyString(value, field) {
  return value === undefined || value === null
    ? undefined
    : nonEmptyString(value, field);
}

function optionalAbsolutePath(value, field) {
  return value === undefined ? undefined : normalizeAbsolutePath(value, field);
}

function normalizeAbsolutePath(value, field) {
  const path = nonEmptyString(value, field);
  if (!path.startsWith("/")) {
    throw adapterError("invalid_path", `${field} must be absolute`);
  }
  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      throw adapterError("invalid_path", `${field} must not contain ..`);
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function joinAbsolute(base, name) {
  return normalizeAbsolutePath(
    `${base === "/" ? "" : base}/${nonEmptyString(name, "directory entry name")}`,
    "directory entry path",
  );
}

function parentPath(path) {
  const normalized = normalizeAbsolutePath(path, "path");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function nonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw adapterError("invalid_result", `${field} must be a non-negative integer`);
  }
  return value;
}

function compareSnapshotEntries(a, b) {
  return a.path.localeCompare(b.path) || a.type.localeCompare(b.type);
}

function optionalFunction(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requiredFunction(value, "expected a function");
}

function requiredFunction(value, message) {
  if (typeof value !== "function") {
    throw adapterError("invalid_options", message);
  }
  return value;
}

function isAlreadyExistsError(error) {
  return /exist|already/i.test(error?.message ?? "");
}

function adapterError(kind, message, options) {
  return new WasmerSdkAdapterError(kind, message, options);
}
