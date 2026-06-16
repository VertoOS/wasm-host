const WEBC_MAGIC = new Uint8Array([0x00, 0x77, 0x65, 0x62, 0x63]);
const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
const WEBC_ARTIFACT_KIND = "webc-package";
const RAW_WASI_ARTIFACT_KIND = "wasi-module";
const RAW_WASI_ENTRYPOINT = "_start";
const DEFAULT_PACKAGE_ID = "default";
const DEFAULT_PACKAGE_CACHE_NAMESPACE = "wasm-host";
const DEFAULT_PACKAGE_CACHE_DB_NAME = "wasm-host-package-cache";
const DEFAULT_PACKAGE_CACHE_DB_VERSION = 1;
const DEFAULT_PACKAGE_BYTES_LIMIT = 128 * 1024 * 1024;
const CACHE_VERSION = "v1";
const PACKAGE_SUMMARIES_STORE = "package-summaries";
const PACKAGE_BYTES_STORE = "package-by-key";
const MODULE_ARTIFACTS_STORE = "module-artifacts";
const PACKAGE_CACHE_STORES = [
  PACKAGE_SUMMARIES_STORE,
  PACKAGE_BYTES_STORE,
  MODULE_ARTIFACTS_STORE,
];

export class BrowserPackageLoaderError extends Error {
  constructor(kind, message, stage = "package_load") {
    super(message);
    this.name = "BrowserPackageLoaderError";
    this.kind = kind;
    this.stage = stage;
  }
}

export class BrowserPackageLoader {
  constructor(options = {}) {
    this.cache = options.cache ?? createDefaultPackageCache(options);
    this.fetchImpl = options.fetchImpl ?? defaultFetchImpl();
    this.packageBytesLimit =
      options.packageBytesLimit ?? DEFAULT_PACKAGE_BYTES_LIMIT;
  }

  async load(input = {}) {
    const source = input.source ?? {};
    if (source.bytes != null || input.bytes != null) {
      return this.loadBytes({
        ...input,
        bytes: source.bytes ?? input.bytes,
      });
    }
    if (source.kind === "url" || input.url != null) {
      return this.loadUrl({
        ...input,
        url: source.url ?? input.url,
      });
    }
    return this.loadBytes(input);
  }

  async loadBytes(input = {}) {
    const bytes = toUint8Array(input.bytes);
    validatePackageBytesLimit(bytes.byteLength, this.packageBytesLimit);
    const format = detectPackageFormat(bytes);
    const sha256 = await sha256Hex(bytes);
    verifyExpectedSha256(input.expectedSha256, sha256);
    const cacheKeys = packageCacheKeys({ format, sha256 });
    const metadata = normalizePackageMetadata(input, {
      byteLength: bytes.byteLength,
      cacheKeys,
      artifactKind: normalizeArtifactKind(input.artifactKind, format),
      format,
      sha256,
      source: normalizeSource(input.source),
    });
    const record = {
      byteLength: bytes.byteLength,
      bytes,
      artifactKind: metadata.artifactKind,
      cacheKeys,
      cache: cacheKeys.cache,
      commands: metadata.commands,
      contentSha256: sha256,
      defaultCommand: metadata.defaultCommand,
      entrypoint: metadata.entrypoint,
      executorType: metadata.executorType,
      format,
      id: metadata.id,
      metadata: metadata.metadata,
      sha256,
      source: metadata.source,
    };
    await this.cache.putPackage(record);
    return record;
  }

  async loadUrl(input = {}) {
    if (typeof this.fetchImpl !== "function") {
      throw new BrowserPackageLoaderError(
        "transport",
        "Fetch API is unavailable for browser package loading",
      );
    }
    const url = nonEmptyString(input.url, "browser package URL is required");
    const response = await this.fetchImpl(url, {
      credentials: input.credentials ?? "same-origin",
      method: "GET",
      signal: input.signal,
    });
    if (!response?.ok) {
      throw new BrowserPackageLoaderError(
        "transport",
        `browser package fetch failed with status ${response?.status ?? "unknown"}`,
      );
    }
    const bytes = await responseBytes(response, this.packageBytesLimit);
    return this.loadBytes({
      ...input,
      bytes,
      source: {
        kind: "url",
        label: sanitizeUrlForSource(url),
      },
    });
  }

  commandLoadMessage(record, options = {}) {
    return {
      type: "command.load",
      id: options.id ?? record.id,
      package: commandPackageFromRecord(record, {
        executorType: options.executorType,
        id: options.packageId,
      }),
    };
  }
}

export class MemoryPackageCache {
  constructor() {
    this.packages = new Map();
    this.packageBytes = new Map();
    this.moduleArtifacts = new Map();
  }

  async putPackage(record) {
    this.packages.set(record.id, packageSummary(record));
    this.packageBytes.set(record.cacheKeys.packageBytes, record.bytes);
  }

  async getPackage(id) {
    return this.packages.get(id) ?? null;
  }

  async getPackageBytes(recordOrKey) {
    const key =
      typeof recordOrKey === "string"
        ? recordOrKey
        : recordOrKey?.cacheKeys?.packageBytes;
    return key ? this.packageBytes.get(key) ?? null : null;
  }

  async putModuleArtifact(key, value) {
    this.moduleArtifacts.set(String(key), value);
  }

  async getModuleArtifact(key) {
    return this.moduleArtifacts.get(String(key)) ?? null;
  }
}

export class IndexedDbPackageCache {
  constructor(options = {}) {
    this.dbName = options.dbName ?? DEFAULT_PACKAGE_CACHE_DB_NAME;
    this.indexedDB =
      options.indexedDB !== undefined ? options.indexedDB : defaultIndexedDb();
    this.version = options.version ?? DEFAULT_PACKAGE_CACHE_DB_VERSION;
    this.dbPromise = null;
    if (!isIndexedDbFactory(this.indexedDB)) {
      throw new BrowserPackageLoaderError(
        "unsupported",
        "IndexedDB is unavailable for browser package caching",
      );
    }
  }

  async putPackage(record) {
    const db = await this.open();
    const transaction = db.transaction(
      [PACKAGE_SUMMARIES_STORE, PACKAGE_BYTES_STORE],
      "readwrite",
    );
    const done = transactionDone(transaction);
    transaction
      .objectStore(PACKAGE_SUMMARIES_STORE)
      .put(packageSummary(record), record.id);
    transaction
      .objectStore(PACKAGE_BYTES_STORE)
      .put(copyBytes(record.bytes), record.cacheKeys.packageBytes);
    await done;
  }

  async getPackage(id) {
    if (!id) {
      return null;
    }
    return (
      (await this.getStoreValue(PACKAGE_SUMMARIES_STORE, String(id))) ?? null
    );
  }

  async getPackageBytes(recordOrKey) {
    const key =
      typeof recordOrKey === "string"
        ? recordOrKey
        : recordOrKey?.cacheKeys?.packageBytes;
    if (!key) {
      return null;
    }
    const value = await this.getStoreValue(PACKAGE_BYTES_STORE, key);
    return value == null ? null : copyBytes(value);
  }

  async putModuleArtifact(key, value) {
    const db = await this.open();
    const transaction = db.transaction(MODULE_ARTIFACTS_STORE, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(MODULE_ARTIFACTS_STORE).put(value, String(key));
    await done;
  }

  async getModuleArtifact(key) {
    if (!key) {
      return null;
    }
    return (
      (await this.getStoreValue(MODULE_ARTIFACTS_STORE, String(key))) ?? null
    );
  }

  async getStoreValue(storeName, key) {
    const db = await this.open();
    const transaction = db.transaction(storeName, "readonly");
    const done = transactionDone(transaction);
    const value = await requestResult(transaction.objectStore(storeName).get(key));
    await done;
    return value;
  }

  open() {
    this.dbPromise ??= openPackageCacheDatabase({
      dbName: this.dbName,
      indexedDB: this.indexedDB,
      version: this.version,
    });
    return this.dbPromise;
  }
}

export function createBrowserPackageLoader(options = {}) {
  return new BrowserPackageLoader(options);
}

export function createDefaultPackageCache(options = {}) {
  const indexedDB =
    options.indexedDB !== undefined ? options.indexedDB : defaultIndexedDb();
  if (!isIndexedDbFactory(indexedDB)) {
    return new MemoryPackageCache();
  }
  return new IndexedDbPackageCache({
    dbName: options.packageCacheDbName,
    indexedDB,
    version: options.packageCacheDbVersion,
  });
}

export function detectPackageFormat(bytes) {
  const data = toUint8Array(bytes);
  if (startsWithBytes(data, WEBC_MAGIC)) {
    return "webc";
  }
  if (startsWithBytes(data, WASM_MAGIC)) {
    return "wasm";
  }
  throw new BrowserPackageLoaderError(
    "invalid_package",
    "invalid browser package bytes: expected WebC or Wasm magic",
  );
}

export function commandPackageFromRecord(record, options = {}) {
  return {
    artifactKind: record.artifactKind,
    cache: record.cache,
    commands: [...record.commands],
    contentSha256: record.contentSha256,
    entrypoint: record.entrypoint,
    id: options.id ?? record.id,
    metadata: {
      ...record.metadata,
      artifactKind: record.artifactKind,
      byteLength: record.byteLength,
      cache: record.cache,
      cacheKeys: record.cacheKeys,
      defaultCommand: record.defaultCommand,
      entrypoint: record.entrypoint,
      format: record.format,
      sha256: record.sha256,
      source: record.source,
    },
    type: options.executorType ?? record.executorType,
  };
}

export function packageCacheKeys(options = {}) {
  const namespace = options.namespace ?? DEFAULT_PACKAGE_CACHE_NAMESPACE;
  const format = nonEmptyString(options.format, "package cache format is required");
  const sha256 = normalizeSha256(options.sha256);
  const extension = format === "webc" ? "webc" : "wasm";
  const packagePath = `${namespace}/${CACHE_VERSION}/packages/sha256/${sha256}.${extension}`;
  const modulePath = `${namespace}/${CACHE_VERSION}/modules/sha256/${sha256}/`;
  return {
    cache: {
      backend: "indexeddb",
      modulePath,
      packagePath,
    },
    moduleArtifactsPrefix: `indexeddb://${namespace}/module-artifacts/${format}/${sha256}/`,
    packageBytes: `indexeddb://${namespace}/package-by-sha256/${format}/${sha256}`,
  };
}

function normalizePackageMetadata(input, context) {
  const id = nonEmptyString(input.id ?? input.packageId ?? DEFAULT_PACKAGE_ID);
  const commands = normalizeCommands(input);
  const defaultCommand = normalizeDefaultCommand(input, commands);
  const entrypoint = nonEmptyString(
    input.entrypoint ??
      (context.artifactKind === RAW_WASI_ARTIFACT_KIND
        ? RAW_WASI_ENTRYPOINT
        : defaultCommand),
  );
  const executorType =
    context.artifactKind === RAW_WASI_ARTIFACT_KIND
      ? RAW_WASI_ARTIFACT_KIND
      : input.executorType ?? input.commandPackageType ?? context.artifactKind;
  return {
    artifactKind: context.artifactKind,
    commands,
    defaultCommand,
    entrypoint,
    executorType: nonEmptyString(executorType),
    id,
    metadata: {
      ...(input.metadata ?? {}),
      artifactKind: context.artifactKind,
      byteLength: context.byteLength,
      cache: context.cacheKeys.cache,
      cacheKeys: context.cacheKeys,
      defaultCommand,
      entrypoint,
      format: context.format,
      sha256: context.sha256,
      source: context.source,
    },
    source: context.source,
  };
}

function openPackageCacheDatabase(options) {
  return new Promise((resolve, reject) => {
    const request = options.indexedDB.open(options.dbName, options.version);
    request.onblocked = () => {
      reject(
        new BrowserPackageLoaderError(
          "transport",
          "IndexedDB package cache open was blocked",
        ),
      );
    };
    request.onerror = () => {
      reject(indexedDbError(request.error, "open IndexedDB package cache"));
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const storeName of PACKAGE_CACHE_STORES) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onerror = () => {
      reject(indexedDbError(request.error, "read IndexedDB package cache"));
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.onabort = () => {
      reject(indexedDbError(transaction.error, "write IndexedDB package cache"));
    };
    transaction.onerror = () => {
      reject(indexedDbError(transaction.error, "write IndexedDB package cache"));
    };
    transaction.oncomplete = () => {
      resolve();
    };
  });
}

function indexedDbError(error, action) {
  const message = error?.message ? `: ${error.message}` : "";
  return new BrowserPackageLoaderError(
    "transport",
    `failed to ${action}${message}`,
  );
}

function normalizeCommands(input) {
  const commands = input.commands ?? (input.command ? [input.command] : null);
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new BrowserPackageLoaderError(
      "invalid_package",
      "browser package commands must be a non-empty array",
    );
  }
  return commands.map(normalizeCommandName);
}

function normalizeDefaultCommand(input, commands) {
  const defaultCommand = input.defaultCommand ?? commands[0];
  const normalized = nonEmptyString(defaultCommand);
  if (!commands.includes(normalized)) {
    throw new BrowserPackageLoaderError(
      "invalid_package",
      "browser package default command must be listed in commands",
    );
  }
  return normalized;
}

function normalizeCommandName(value) {
  const command = nonEmptyString(value);
  if (command.includes("\0") || command.includes("/")) {
    throw new BrowserPackageLoaderError(
      "invalid_package",
      "browser package command names must not contain NUL or /",
    );
  }
  return command;
}

function packageSummary(record) {
  return {
    byteLength: record.byteLength,
    artifactKind: record.artifactKind,
    cache: record.cache,
    cacheKeys: record.cacheKeys,
    commands: [...record.commands],
    contentSha256: record.contentSha256,
    defaultCommand: record.defaultCommand,
    entrypoint: record.entrypoint,
    executorType: record.executorType,
    format: record.format,
    id: record.id,
    metadata: record.metadata,
    sha256: record.sha256,
    source: record.source,
  };
}

function normalizeArtifactKind(value, format) {
  const artifactKind =
    value ?? (format === "webc" ? WEBC_ARTIFACT_KIND : RAW_WASI_ARTIFACT_KIND);
  const normalized = nonEmptyString(artifactKind);
  const expected =
    format === "webc" ? WEBC_ARTIFACT_KIND : RAW_WASI_ARTIFACT_KIND;
  if (normalized !== expected) {
    throw new BrowserPackageLoaderError(
      "invalid_package",
      `browser package artifactKind ${normalized} does not match ${format} bytes`,
    );
  }
  return normalized;
}

async function responseBytes(response, limit) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength != null) {
    validatePackageBytesLimit(Number(contentLength), limit);
  }
  if (typeof response.body?.getReader === "function") {
    return readResponseBodyBytes(response.body, limit);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  validatePackageBytesLimit(bytes.byteLength, limit);
  return bytes;
}

async function readResponseBodyBytes(body, limit) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const bytes = toUint8Array(value);
    total += bytes.byteLength;
    validatePackageBytesLimit(total, limit);
    if (bytes.byteLength > 0) {
      chunks.push(bytes);
    }
  }
  return concatBytes(chunks, total);
}

function concatBytes(chunks, size) {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function validatePackageBytesLimit(size, limit) {
  if (!Number.isFinite(size) || size > limit) {
    throw new BrowserPackageLoaderError(
      "package_too_large",
      `browser package bytes exceeded ${limit} bytes`,
    );
  }
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new BrowserPackageLoaderError(
      "unsupported",
      "Web Crypto SHA-256 is unavailable for browser package loading",
    );
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

function normalizeSha256(value) {
  const text = String(value ?? "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw new BrowserPackageLoaderError(
      "invalid_package",
      "browser package sha256 must be a 64-character hex digest",
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
    throw new BrowserPackageLoaderError(
      "invalid_package",
      `browser package sha256 mismatch: expected ${normalized}, got ${actual}`,
    );
  }
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

function defaultFetchImpl() {
  return typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : undefined;
}

function defaultIndexedDb() {
  return globalThis.indexedDB ?? null;
}

function isIndexedDbFactory(value) {
  return typeof value?.open === "function";
}

function sanitizeUrlForSource(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return `${url.protocol} URL`;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "url";
  }
}

function startsWithBytes(bytes, prefix) {
  if (bytes.byteLength < prefix.byteLength) {
    return false;
  }
  return prefix.every((byte, index) => bytes[index] === byte);
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  throw new BrowserPackageLoaderError(
    "invalid_package",
    "browser package bytes must be a byte buffer",
  );
}

function copyBytes(value) {
  const bytes = toUint8Array(value);
  return new Uint8Array(bytes);
}

function nonEmptyString(
  value,
  message = "browser package fields must be non-empty strings",
) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new BrowserPackageLoaderError("invalid_package", message);
  }
  return text;
}
