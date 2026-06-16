const DEFAULT_WORKSPACE_DB_NAME = "wasm-host-workspace-store";
const DEFAULT_WORKSPACE_DB_VERSION = 1;
const DEFAULT_WORKSPACE_ID = "default";
const WORKSPACE_ROOT = "/workspace";
const WORKSPACE_SNAPSHOTS_STORE = "workspace-snapshots";

const encoder = new TextEncoder();

export class BrowserWorkspaceError extends Error {
  constructor(kind, message, options = {}) {
    super(message);
    this.name = "BrowserWorkspaceError";
    this.kind = kind;
    this.stage = options.stage ?? "workspace";
  }
}

export class MemoryBrowserWorkspaceStore {
  constructor(options = {}) {
    this.directories = new Map();
    this.files = new Map();
    this.now = options.now ?? (() => Date.now());
    this.directories.set("", directoryRecord("", this.currentTime()));
    if (options.snapshot) {
      this.loadSnapshot(options.snapshot);
    }
  }

  async writeFile(path, content) {
    const normalized = normalizeWorkspacePath(path);
    if (!normalized.relativePath) {
      throw workspaceError("invalid_path", "workspace file path is required");
    }
    if (this.directories.has(normalized.relativePath)) {
      throw workspaceError("not_file", "workspace path is a directory");
    }
    this.requireParentDirectory(normalized.relativePath);
    const bytes = copyBytes(toBytes(content));
    const record = {
      content: bytes,
      mtimeMs: this.currentTime(),
      path: normalized.workspacePath,
    };
    this.files.set(normalized.relativePath, record);
    return publicFileStat(normalized.workspacePath, record);
  }

  async readFile(path) {
    const normalized = normalizeWorkspacePath(path);
    const record = this.files.get(normalized.relativePath);
    if (!record) {
      if (this.directories.has(normalized.relativePath)) {
        throw workspaceError("not_file", "workspace path is a directory");
      }
      throw workspaceError("not_found", "workspace file is unavailable");
    }
    return copyBytes(record.content);
  }

  async deleteFile(path) {
    const normalized = normalizeWorkspacePath(path);
    if (!this.files.delete(normalized.relativePath)) {
      if (this.directories.has(normalized.relativePath)) {
        throw workspaceError("not_file", "workspace path is a directory");
      }
      throw workspaceError("not_found", "workspace file is unavailable");
    }
  }

  async createDirectory(path, options = {}) {
    const normalized = normalizeWorkspacePath(path);
    if (!normalized.relativePath) {
      return publicDirectoryStat(WORKSPACE_ROOT, this.directories.get(""));
    }
    if (this.files.has(normalized.relativePath)) {
      throw workspaceError("not_directory", "workspace path is a file");
    }
    if (options.recursive === true) {
      this.ensureDirectory(normalized.relativePath);
    } else {
      this.requireParentDirectory(normalized.relativePath);
      if (this.directories.has(normalized.relativePath)) {
        throw workspaceError("already_exists", "workspace directory already exists");
      }
      this.directories.set(
        normalized.relativePath,
        directoryRecord(normalized.workspacePath, this.currentTime()),
      );
    }
    return publicDirectoryStat(
      normalized.workspacePath,
      this.directories.get(normalized.relativePath),
    );
  }

  async deleteDirectory(path, options = {}) {
    const normalized = normalizeWorkspacePath(path);
    if (!normalized.relativePath) {
      throw workspaceError("invalid_path", "workspace root cannot be deleted");
    }
    if (!this.directories.has(normalized.relativePath)) {
      throw workspaceError("not_found", "workspace directory is unavailable");
    }
    if (!options.recursive && this.hasChildren(normalized.relativePath)) {
      throw workspaceError("not_empty", "workspace directory is not empty");
    }
    this.deleteDirectoryTree(normalized.relativePath);
  }

  async readDirectory(path = WORKSPACE_ROOT) {
    const normalized = normalizeWorkspacePath(path);
    const record = this.directories.get(normalized.relativePath);
    if (!record) {
      if (this.files.has(normalized.relativePath)) {
        throw workspaceError("not_directory", "workspace path is a file");
      }
      throw workspaceError("not_found", "workspace directory is unavailable");
    }
    return directoryEntries(
      normalized.relativePath,
      this.files,
      this.directories,
    );
  }

  async stat(path = WORKSPACE_ROOT) {
    const normalized = normalizeWorkspacePath(path);
    const file = this.files.get(normalized.relativePath);
    if (file) {
      return publicFileStat(normalized.workspacePath, file);
    }
    const directory = this.directories.get(normalized.relativePath);
    if (directory) {
      return publicDirectoryStat(normalized.workspacePath, directory);
    }
    throw workspaceError("not_found", "workspace path is unavailable");
  }

  async rename(fromPath, toPath) {
    const from = normalizeWorkspacePath(fromPath);
    const to = normalizeWorkspacePath(toPath);
    if (!from.relativePath || !to.relativePath) {
      throw workspaceError("invalid_path", "workspace rename path is required");
    }
    this.requireParentDirectory(to.relativePath);
    if (this.files.has(to.relativePath) || this.directories.has(to.relativePath)) {
      throw workspaceError("already_exists", "workspace target already exists");
    }
    if (this.files.has(from.relativePath)) {
      const record = this.files.get(from.relativePath);
      this.files.delete(from.relativePath);
      this.files.set(to.relativePath, {
        ...record,
        mtimeMs: this.currentTime(),
        path: to.workspacePath,
      });
      return;
    }
    if (this.directories.has(from.relativePath)) {
      this.renameDirectory(from, to);
      return;
    }
    throw workspaceError("not_found", "workspace source is unavailable");
  }

  async exportSnapshot() {
    return {
      directories: Array.from(this.directories.values(), (record) => ({
        mtimeMs: record.mtimeMs,
        path: record.path,
      })).sort(comparePathRecords),
      files: Array.from(this.files.values(), (record) => ({
        contentBase64: bytesToBase64(record.content),
        mtimeMs: record.mtimeMs,
        path: record.path,
        size: record.content.byteLength,
      })).sort(comparePathRecords),
      root: WORKSPACE_ROOT,
      version: 1,
    };
  }

  async importSnapshot(snapshot) {
    this.loadSnapshot(snapshot);
  }

  loadSnapshot(snapshot) {
    const nextDirectories = new Map();
    const nextFiles = new Map();
    nextDirectories.set("", directoryRecord("", this.currentTime()));
    if (!snapshot || typeof snapshot !== "object") {
      throw workspaceError("invalid_snapshot", "workspace snapshot must be an object");
    }
    if (snapshot.version !== 1 || snapshot.root !== WORKSPACE_ROOT) {
      throw workspaceError("invalid_snapshot", "workspace snapshot version is unsupported");
    }
    for (const entry of snapshot.directories ?? []) {
      const normalized = normalizeWorkspacePath(entry.path);
      nextDirectories.set(
        normalized.relativePath,
        directoryRecord(normalized.workspacePath, nonNegativeTime(entry.mtimeMs)),
      );
    }
    for (const entry of snapshot.files ?? []) {
      const normalized = normalizeWorkspacePath(entry.path);
      if (!normalized.relativePath) {
        throw workspaceError("invalid_snapshot", "workspace file path is required");
      }
      const content = base64ToBytes(entry.contentBase64);
      nextFiles.set(normalized.relativePath, {
        content,
        mtimeMs: nonNegativeTime(entry.mtimeMs),
        path: normalized.workspacePath,
      });
    }
    validateWorkspaceGraph(nextFiles, nextDirectories);
    this.directories = nextDirectories;
    this.files = nextFiles;
  }

  currentTime() {
    return nonNegativeTime(this.now());
  }

  ensureDirectory(path) {
    let current = "";
    for (const part of path.split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (this.files.has(current)) {
        throw workspaceError("not_directory", "workspace path is a file");
      }
      if (!this.directories.has(current)) {
        this.directories.set(
          current,
          directoryRecord(`${WORKSPACE_ROOT}/${current}`, this.currentTime()),
        );
      }
    }
  }

  requireParentDirectory(path) {
    const parent = parentPath(path);
    if (this.files.has(parent)) {
      throw workspaceError("not_directory", "workspace parent is a file");
    }
    if (!this.directories.has(parent)) {
      throw workspaceError("not_found", "workspace parent directory is unavailable");
    }
  }

  hasChildren(path) {
    return (
      Array.from(this.files.keys()).some((file) => isChildPath(path, file)) ||
      Array.from(this.directories.keys()).some(
        (directory) => directory !== path && isChildPath(path, directory),
      )
    );
  }

  deleteDirectoryTree(path) {
    for (const file of Array.from(this.files.keys())) {
      if (file === path || isChildPath(path, file)) {
        this.files.delete(file);
      }
    }
    for (const directory of Array.from(this.directories.keys())) {
      if (directory === path || isChildPath(path, directory)) {
        this.directories.delete(directory);
      }
    }
  }

  renameDirectory(from, to) {
    if (to.relativePath === from.relativePath) {
      return;
    }
    if (isChildPath(from.relativePath, to.relativePath)) {
      throw workspaceError(
        "invalid_path",
        "workspace directory cannot be moved inside itself",
      );
    }
    const movedDirectories = new Map();
    const movedFiles = new Map();
    for (const [path, record] of this.directories) {
      if (path === from.relativePath || isChildPath(from.relativePath, path)) {
        const movedPath = replacePathPrefix(path, from.relativePath, to.relativePath);
        movedDirectories.set(movedPath, {
          ...record,
          mtimeMs: this.currentTime(),
          path: movedPath ? `${WORKSPACE_ROOT}/${movedPath}` : WORKSPACE_ROOT,
        });
      } else {
        movedDirectories.set(path, record);
      }
    }
    for (const [path, record] of this.files) {
      if (isChildPath(from.relativePath, path)) {
        const movedPath = replacePathPrefix(path, from.relativePath, to.relativePath);
        movedFiles.set(movedPath, {
          ...record,
          mtimeMs: this.currentTime(),
          path: `${WORKSPACE_ROOT}/${movedPath}`,
        });
      } else {
        movedFiles.set(path, record);
      }
    }
    this.directories = movedDirectories;
    this.files = movedFiles;
  }
}

export class IndexedDbBrowserWorkspaceStore {
  constructor(options = {}) {
    this.dbName = options.dbName ?? DEFAULT_WORKSPACE_DB_NAME;
    this.indexedDB =
      options.indexedDB !== undefined ? options.indexedDB : defaultIndexedDb();
    this.memory = new MemoryBrowserWorkspaceStore({ now: options.now });
    this.version = options.version ?? DEFAULT_WORKSPACE_DB_VERSION;
    this.workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
    this.dbPromise = null;
    this.loaded = false;
    if (!isIndexedDbFactory(this.indexedDB)) {
      throw workspaceError(
        "unsupported",
        "IndexedDB is unavailable for browser workspace storage",
      );
    }
  }

  async writeFile(path, content) {
    await this.load();
    const result = await this.memory.writeFile(path, content);
    await this.persist();
    return result;
  }

  async readFile(path) {
    await this.load();
    return this.memory.readFile(path);
  }

  async deleteFile(path) {
    await this.load();
    await this.memory.deleteFile(path);
    await this.persist();
  }

  async createDirectory(path, options = {}) {
    await this.load();
    const result = await this.memory.createDirectory(path, options);
    await this.persist();
    return result;
  }

  async deleteDirectory(path, options = {}) {
    await this.load();
    await this.memory.deleteDirectory(path, options);
    await this.persist();
  }

  async readDirectory(path = WORKSPACE_ROOT) {
    await this.load();
    return this.memory.readDirectory(path);
  }

  async stat(path = WORKSPACE_ROOT) {
    await this.load();
    return this.memory.stat(path);
  }

  async rename(fromPath, toPath) {
    await this.load();
    await this.memory.rename(fromPath, toPath);
    await this.persist();
  }

  async exportSnapshot() {
    await this.load();
    return this.memory.exportSnapshot();
  }

  async importSnapshot(snapshot) {
    await this.load();
    await this.memory.importSnapshot(snapshot);
    await this.persist();
  }

  async load() {
    if (this.loaded) {
      return;
    }
    const db = await this.open();
    const transaction = db.transaction(WORKSPACE_SNAPSHOTS_STORE, "readonly");
    const done = transactionDone(transaction);
    const snapshot = await requestResult(
      transaction.objectStore(WORKSPACE_SNAPSHOTS_STORE).get(this.workspaceId),
      "read IndexedDB workspace",
    );
    await done;
    if (snapshot) {
      await this.memory.importSnapshot(snapshot);
    }
    this.loaded = true;
  }

  async persist() {
    const db = await this.open();
    const transaction = db.transaction(WORKSPACE_SNAPSHOTS_STORE, "readwrite");
    const done = transactionDone(transaction);
    transaction
      .objectStore(WORKSPACE_SNAPSHOTS_STORE)
      .put(await this.memory.exportSnapshot(), this.workspaceId);
    await done;
  }

  open() {
    this.dbPromise ??= openWorkspaceDatabase({
      dbName: this.dbName,
      indexedDB: this.indexedDB,
      version: this.version,
    });
    return this.dbPromise;
  }
}

export function createMemoryBrowserWorkspaceStore(options = {}) {
  return new MemoryBrowserWorkspaceStore(options);
}

export function createIndexedDbBrowserWorkspaceStore(options = {}) {
  return new IndexedDbBrowserWorkspaceStore(options);
}

export function createDefaultBrowserWorkspaceStore(options = {}) {
  const indexedDB =
    options.indexedDB !== undefined ? options.indexedDB : defaultIndexedDb();
  if (!isIndexedDbFactory(indexedDB)) {
    return createMemoryBrowserWorkspaceStore(options);
  }
  return createIndexedDbBrowserWorkspaceStore({ ...options, indexedDB });
}

export function createBrowserWorkspaceStore(options = {}) {
  return createDefaultBrowserWorkspaceStore(options);
}

function directoryEntries(path, files, directories) {
  const entries = [];
  for (const [filePath, record] of files) {
    if (parentPath(filePath) === path) {
      entries.push(publicFileStat(`${WORKSPACE_ROOT}/${filePath}`, record));
    }
  }
  for (const [directoryPath, record] of directories) {
    if (directoryPath && parentPath(directoryPath) === path) {
      entries.push(publicDirectoryStat(`${WORKSPACE_ROOT}/${directoryPath}`, record));
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function validateWorkspaceGraph(files, directories) {
  for (const path of files.keys()) {
    if (directories.has(path)) {
      throw workspaceError("invalid_snapshot", "workspace path has multiple kinds");
    }
  }
  for (const path of files.keys()) {
    if (!directories.has(parentPath(path))) {
      throw workspaceError("invalid_snapshot", "workspace file parent is missing");
    }
  }
  for (const path of directories.keys()) {
    if (path && !directories.has(parentPath(path))) {
      throw workspaceError(
        "invalid_snapshot",
        "workspace directory parent is missing",
      );
    }
  }
}

export function normalizeWorkspacePath(path) {
  const raw = String(path ?? "").trim();
  if (!raw || raw.includes("\0") || raw.includes("\\")) {
    throw workspaceError("invalid_path", "workspace path is invalid");
  }
  let relative = raw;
  if (relative === WORKSPACE_ROOT) {
    relative = "";
  } else if (relative.startsWith(`${WORKSPACE_ROOT}/`)) {
    relative = relative.slice(WORKSPACE_ROOT.length + 1);
  } else if (relative.startsWith("/")) {
    throw workspaceError("invalid_path", "workspace path must be under /workspace");
  }
  const parts = [];
  for (const part of relative.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      throw workspaceError("invalid_path", "workspace path must not traverse upward");
    }
    parts.push(part);
  }
  const relativePath = parts.join("/");
  return {
    relativePath,
    workspacePath: relativePath ? `${WORKSPACE_ROOT}/${relativePath}` : WORKSPACE_ROOT,
  };
}

function publicFileStat(path, record) {
  return {
    kind: "file",
    mtimeMs: record.mtimeMs,
    path,
    size: record.content.byteLength,
  };
}

function publicDirectoryStat(path, record) {
  return {
    kind: "directory",
    mtimeMs: record.mtimeMs,
    path,
    size: 0,
  };
}

function directoryRecord(path, mtimeMs) {
  return { mtimeMs, path: path || WORKSPACE_ROOT };
}

function parentPath(path) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function isChildPath(parent, child) {
  return parent ? child.startsWith(`${parent}/`) : child !== "";
}

function replacePathPrefix(path, from, to) {
  if (path === from) {
    return to;
  }
  return `${to}/${path.slice(from.length + 1)}`;
}

function toBytes(value) {
  if (typeof value === "string") {
    return encoder.encode(value);
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw workspaceError("invalid_content", "workspace file content must be bytes");
}

function copyBytes(bytes) {
  return new Uint8Array(bytes);
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

function comparePathRecords(left, right) {
  return left.path.localeCompare(right.path);
}

function nonNegativeTime(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw workspaceError("invalid_snapshot", "workspace timestamp is invalid");
  }
  return number;
}

function openWorkspaceDatabase(options) {
  return new Promise((resolve, reject) => {
    const request = options.indexedDB.open(options.dbName, options.version);
    request.onblocked = () => {
      reject(workspaceError("transport", "IndexedDB workspace open was blocked"));
    };
    request.onerror = () => {
      reject(indexedDbError(request.error, "open IndexedDB workspace"));
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(WORKSPACE_SNAPSHOTS_STORE)) {
        db.createObjectStore(WORKSPACE_SNAPSHOTS_STORE);
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
  });
}

function requestResult(request, action) {
  return new Promise((resolve, reject) => {
    request.onerror = () => {
      reject(indexedDbError(request.error, action));
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.onabort = () => {
      reject(indexedDbError(transaction.error, "write IndexedDB workspace"));
    };
    transaction.onerror = () => {
      reject(indexedDbError(transaction.error, "write IndexedDB workspace"));
    };
    transaction.oncomplete = () => {
      resolve();
    };
  });
}

function indexedDbError(error, action) {
  const message = error?.message ? `: ${error.message}` : "";
  return workspaceError("transport", `failed to ${action}${message}`);
}

function defaultIndexedDb() {
  return globalThis.indexedDB ?? null;
}

function isIndexedDbFactory(value) {
  return typeof value?.open === "function";
}

function workspaceError(kind, message) {
  return new BrowserWorkspaceError(kind, message);
}
