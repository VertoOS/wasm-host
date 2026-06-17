import {
  CODEX_VERSION_SMOKE_WASM,
  codexVersionSmokeManifest,
} from "../fixtures/codex-version-smoke-core.js";
import {
  fetchCodexArtifactBytes,
  parseArtifactManifestJson,
} from "./artifact-manifest.js";
import {
  commandPackageFromRecord,
  createBrowserPackageLoader,
} from "./package-loader.js";

const DEFAULT_CWD = "/workspace";
const BUILTIN_CODEX_SOURCE = "builtin-codex";
const PACKAGE_FILE_SOURCE = "package-file";
const PACKAGE_URL_SOURCE = "package-url";
const MANIFEST_JSON_SOURCE = "manifest-json";
const MANIFEST_URL_SOURCE = "manifest-url";

export const PACKAGE_SOURCE_KINDS = [
  BUILTIN_CODEX_SOURCE,
  PACKAGE_FILE_SOURCE,
  PACKAGE_URL_SOURCE,
  MANIFEST_JSON_SOURCE,
  MANIFEST_URL_SOURCE,
];

export class BrowserPackageSourceError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "BrowserPackageSourceError";
    this.kind = kind;
  }
}

export function createBrowserPackageSourceResolver(options = {}) {
  const packageLoader =
    options.packageLoader ??
    createBrowserPackageLoader({ fetchImpl: options.fetchImpl });
  return (input = {}) =>
    resolveBrowserPackageSource(input, {
      ...options,
      packageLoader,
    });
}

export async function resolveBrowserPackageSource(input = {}, options = {}) {
  const kind = input.kind ?? BUILTIN_CODEX_SOURCE;
  switch (kind) {
    case BUILTIN_CODEX_SOURCE:
      return builtinCodexPackageSourceOptions(options);
    case PACKAGE_FILE_SOURCE:
      return resolvePackageFileSource(input, options);
    case PACKAGE_URL_SOURCE:
      return resolvePackageUrlSource(input, options);
    case MANIFEST_JSON_SOURCE:
      return resolveManifestJsonSource(input, options);
    case MANIFEST_URL_SOURCE:
      return resolveManifestUrlSource(input, options);
    default:
      throw new BrowserPackageSourceError(
        "invalid_request",
        `unknown browser package source: ${kind}`,
      );
  }
}

export async function builtinCodexPackageSourceOptions(options = {}) {
  const manifest = await codexVersionSmokeManifest();
  const { artifactUrl, fixture } = await fetchCodexArtifactBytes(manifest, {
    fetchImpl: options.codexFetchImpl ?? options.fetchImpl ?? inlineCodexFetch,
  });
  return shellOptionsFromFixture(fixture, {
    artifactUrl,
    sourceKind: BUILTIN_CODEX_SOURCE,
    sourceLabel: "Built-in Codex smoke",
  });
}

export function parsePackageArgs(text) {
  const value = String(text ?? "").trim();
  if (!value) {
    return [];
  }
  if (value.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new BrowserPackageSourceError(
        "invalid_request",
        "package args JSON is invalid",
      );
    }
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new BrowserPackageSourceError(
        "invalid_request",
        "package args JSON must be an array of strings",
      );
    }
    return parsed;
  }
  return value.split(/\s+/);
}

async function resolvePackageFileSource(input, options) {
  const file = requiredFile(input.file, "select a package file");
  const bytes = await fileBytes(file);
  const packageId = packageIdFromInput(input, fileNamePackageId(file.name));
  const command = optionalString(input.command);
  const record = await loadPackageSafely(
    () =>
      packageLoader(options).loadBytes({
        bytes,
        ...(command ? { command, defaultCommand: command } : {}),
        executorType: optionalString(input.executorType),
        id: packageId,
        source: {
          kind: "bytes",
          label: safeFileLabel(file.name),
        },
      }),
    PACKAGE_FILE_SOURCE,
  );
  return shellOptionsFromPackageRecord(record, input);
}

async function resolvePackageUrlSource(input, options) {
  const url = nonEmptyString(input.url, "package URL is required");
  const command = optionalString(input.command);
  const packageId = packageIdFromInput(input, "url-package");
  const record = await loadPackageSafely(
    () =>
      packageLoader(options).loadUrl({
        ...(command ? { command, defaultCommand: command } : {}),
        executorType: optionalString(input.executorType),
        id: packageId,
        url,
      }),
    PACKAGE_URL_SOURCE,
  );
  return shellOptionsFromPackageRecord(record, input);
}

async function resolveManifestJsonSource(input, options) {
  const text = nonEmptyString(input.manifestText, "manifest JSON is required");
  const manifest = parseManifestSafely(text);
  return resolveManifestFixture(manifest, input, options);
}

async function resolveManifestUrlSource(input, options) {
  const url = nonEmptyString(input.url, "manifest URL is required");
  const fetchImpl = options.fetchImpl ?? defaultFetchImpl();
  if (typeof fetchImpl !== "function") {
    throw new BrowserPackageSourceError(
      "transport",
      "Fetch API is unavailable for manifest loading",
    );
  }
  let response;
  try {
    response = await fetchImpl(url, {
      credentials: input.credentials ?? "same-origin",
      method: "GET",
    });
  } catch {
    throw new BrowserPackageSourceError(
      "transport",
      "browser manifest URL could not be loaded",
    );
  }
  if (!response?.ok) {
    throw new BrowserPackageSourceError(
      "transport",
      `browser manifest fetch failed with status ${response?.status ?? "unknown"}`,
    );
  }
  const manifest = parseManifestSafely(await response.text());
  return resolveManifestFixture(manifest, input, {
    ...options,
    baseUrl: url,
  });
}

async function resolveManifestFixture(manifest, input, options) {
  const file = input.file ?? null;
  const fetchImpl = file
    ? fileBackedFetchImpl(await fileBytes(file))
    : options.fetchImpl ?? defaultFetchImpl();
  try {
    const { artifactUrl, fixture } = await fetchCodexArtifactBytes(manifest, {
      baseUrl: options.baseUrl,
      fetchImpl,
    });
    return shellOptionsFromFixture(fixture, {
      artifactUrl: file ? safeFileLabel(file.name) : artifactUrl,
      sourceKind: input.kind ?? MANIFEST_JSON_SOURCE,
      sourceLabel: file ? safeFileLabel(file.name) : "Codex artifact manifest",
    });
  } catch (error) {
    throw sourceErrorFrom(error, input.kind ?? MANIFEST_JSON_SOURCE);
  }
}

function shellOptionsFromPackageRecord(record, input) {
  const args = argsFromInput(input);
  const command = nonEmptyString(
    input.command ?? record.defaultCommand,
    "package command is required",
  );
  const loadMessage = {
    type: "command.load",
    id: `load-${record.id}`,
    package: {
      ...commandPackageFromRecord(record),
      bytes: record.bytes,
      executorType: record.executorType,
      expectedSha256: record.sha256,
      source: record.source,
    },
  };
  const runMessage = {
    type: "command.run",
    id: `run-${record.id}-${command}`,
    packageId: record.id,
    command,
    args,
    env: {},
    cwd: DEFAULT_CWD,
    ...(record.artifactKind === "wasi-module" ? { stdinOpen: false } : {}),
  };
  return {
    commandLabel: commandLabel(command, args),
    loadMessage,
    metadata: {
      args,
      artifactKind: record.artifactKind,
      byteLength: record.byteLength,
      command,
      executorType: record.executorType,
      format: record.format,
      packageId: record.id,
      sha256: record.sha256,
      sourceKind: input.kind,
      sourceLabel: record.source?.label ?? record.source?.kind ?? "package",
    },
    runMessage,
  };
}

function shellOptionsFromFixture(fixture, source) {
  const command = fixture.commandRun.command;
  const args = fixture.commandRun.args ?? [];
  return {
    commandLabel: commandLabel(command, args),
    expected: { ...fixture.expected },
    loadMessage: fixture.commandLoad,
    metadata: {
      args,
      artifactKind: fixture.artifact.kind,
      byteLength: fixture.artifact.sizeBytes,
      command,
      executorType: fixture.commandLoad.package.type,
      packageId: fixture.commandRun.packageId,
      sha256: fixture.artifact.sha256,
      sourceKind: source.sourceKind,
      sourceLabel: source.sourceLabel,
    },
    runMessage: fixture.commandRun,
    subtitle: `Loaded from ${source.sourceLabel}`,
    title: "wasm-host terminal",
  };
}

function packageLoader(options) {
  return options.packageLoader ?? createBrowserPackageLoader({
    fetchImpl: options.fetchImpl,
    indexedDB: options.indexedDB,
    packageCacheDbName: options.packageCacheDbName,
    packageCacheDbVersion: options.packageCacheDbVersion,
  });
}

function parseManifestSafely(text) {
  try {
    return parseArtifactManifestJson(text);
  } catch (error) {
    throw sourceErrorFrom(error, MANIFEST_JSON_SOURCE);
  }
}

async function loadPackageSafely(load, sourceKind) {
  try {
    return await load();
  } catch (error) {
    throw sourceErrorFrom(error, sourceKind);
  }
}

function sourceErrorFrom(error, sourceKind) {
  if (error instanceof BrowserPackageSourceError) {
    return error;
  }
  if (sourceKind === PACKAGE_URL_SOURCE) {
    return new BrowserPackageSourceError(
      error?.kind ?? "transport",
      safeErrorMessage(error, "browser package URL could not be loaded"),
    );
  }
  if (sourceKind === MANIFEST_URL_SOURCE) {
    return new BrowserPackageSourceError(
      error?.kind ?? "transport",
      safeErrorMessage(error, "browser manifest URL could not be loaded"),
    );
  }
  if (sourceKind === MANIFEST_JSON_SOURCE) {
    return new BrowserPackageSourceError(
      error?.kind ?? "invalid_manifest",
      safeErrorMessage(error, "browser artifact manifest is invalid"),
    );
  }
  return new BrowserPackageSourceError(
    error?.kind ?? "invalid_package",
    safeErrorMessage(error, "browser package source is invalid"),
  );
}

function safeErrorMessage(error, fallback) {
  const message = String(error?.message ?? "");
  if (!message) {
    return fallback;
  }
  return message
    .replace(/https?:\/\/[^\s)]+/g, (url) => safeDisplayUrl(url))
    .replace(/data:[^\s)]+/g, "data: URL");
}

function safeDisplayUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "URL";
  }
}

function fileBackedFetchImpl(bytes) {
  return async () =>
    new Response(bytes, {
      headers: {
        "Content-Length": String(bytes.byteLength),
      },
      status: 200,
    });
}

export async function inlineCodexFetch() {
  return new Response(CODEX_VERSION_SMOKE_WASM, {
    headers: {
      "Content-Length": String(CODEX_VERSION_SMOKE_WASM.byteLength),
    },
    status: 200,
  });
}

async function fileBytes(file) {
  if (typeof file?.arrayBuffer !== "function") {
    throw new BrowserPackageSourceError(
      "invalid_request",
      "selected file cannot be read",
    );
  }
  return new Uint8Array(await file.arrayBuffer());
}

function requiredFile(file, message) {
  if (!file) {
    throw new BrowserPackageSourceError("invalid_request", message);
  }
  return file;
}

function packageIdFromInput(input, fallback) {
  return safeIdentifier(optionalString(input.packageId) ?? fallback);
}

function fileNamePackageId(name) {
  return safeIdentifier(String(name ?? "uploaded-package").replace(/\.[^.]+$/, ""));
}

function safeIdentifier(value) {
  const id = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || "package";
}

function safeFileLabel(name) {
  const label = String(name ?? "").trim();
  return label ? label.split(/[\\/]/).pop() : "uploaded package";
}

function commandLabel(command, args) {
  return [command, ...args].filter(Boolean).join(" ");
}

function argsFromInput(input) {
  if (Array.isArray(input.args)) {
    if (input.args.every((item) => typeof item === "string")) {
      return [...input.args];
    }
    throw new BrowserPackageSourceError(
      "invalid_request",
      "package args must be strings",
    );
  }
  return parsePackageArgs(input.argsText);
}

function optionalString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function nonEmptyString(value, message) {
  const text = optionalString(value);
  if (!text) {
    throw new BrowserPackageSourceError("invalid_request", message);
  }
  return text;
}

function defaultFetchImpl() {
  return typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : undefined;
}
