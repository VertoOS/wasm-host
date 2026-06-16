import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserWorkspaceError,
  createBrowserWorkspaceStore,
  createDefaultBrowserWorkspaceStore,
  createIndexedDbBrowserWorkspaceStore,
  createMemoryBrowserWorkspaceStore,
  normalizeWorkspacePath,
} from "../src/workspace.js";

const decoder = new TextDecoder();

test("memory browser workspace supports file directory and rename operations", async () => {
  let now = 1_000;
  const workspace = createMemoryBrowserWorkspaceStore({ now: () => now });

  assert.deepEqual(await workspace.stat("/workspace"), {
    kind: "directory",
    mtimeMs: 1_000,
    path: "/workspace",
    size: 0,
  });

  now = 2_000;
  await workspace.createDirectory("/workspace/src");
  now = 3_000;
  const fileStat = await workspace.writeFile("src/app.txt", "hello");
  assert.deepEqual(fileStat, {
    kind: "file",
    mtimeMs: 3_000,
    path: "/workspace/src/app.txt",
    size: 5,
  });
  assert.equal(text(await workspace.readFile("/workspace/src/app.txt")), "hello");
  assert.deepEqual(await workspace.readDirectory("/workspace"), [
    {
      kind: "directory",
      mtimeMs: 2_000,
      path: "/workspace/src",
      size: 0,
    },
  ]);
  assert.deepEqual(await workspace.readDirectory("src"), [fileStat]);

  now = 4_000;
  await workspace.rename("/workspace/src/app.txt", "/workspace/src/main.txt");
  await assertRejectsKind(
    () => workspace.readFile("/workspace/src/app.txt"),
    "not_found",
  );
  assert.equal(text(await workspace.readFile("/workspace/src/main.txt")), "hello");

  now = 5_000;
  await workspace.createDirectory("/workspace/pkg/nested", { recursive: true });
  await workspace.writeFile("/workspace/pkg/nested/data.bin", bytes([0, 255, 7]));
  await workspace.rename("/workspace/pkg", "/workspace/lib");
  assert.deepEqual(await workspace.readFile("/workspace/lib/nested/data.bin"), bytes([
    0,
    255,
    7,
  ]));

  await workspace.deleteFile("/workspace/src/main.txt");
  await workspace.deleteDirectory("/workspace/src");
  await workspace.deleteDirectory("/workspace/lib", { recursive: true });
  assert.deepEqual(await workspace.readDirectory("/workspace"), []);
});

test("memory browser workspace snapshots round trip text and binary files", async () => {
  let now = 10;
  const workspace = createMemoryBrowserWorkspaceStore({ now: () => now });
  await workspace.createDirectory("/workspace/docs");
  now = 11;
  await workspace.writeFile("/workspace/docs/readme.md", "# hello\n");
  now = 12;
  const sourceBytes = bytes([1, 2, 3, 250]);
  await workspace.writeFile("/workspace/blob.bin", sourceBytes);
  sourceBytes[0] = 99;

  const snapshot = await workspace.exportSnapshot();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.root, "/workspace");
  assert.deepEqual(
    snapshot.files.map((entry) => [entry.path, entry.size]),
    [
      ["/workspace/blob.bin", 4],
      ["/workspace/docs/readme.md", 8],
    ],
  );

  const restored = createMemoryBrowserWorkspaceStore({
    now: () => 99,
    snapshot,
  });
  assert.equal(text(await restored.readFile("/workspace/docs/readme.md")), "# hello\n");
  const restoredBytes = await restored.readFile("/workspace/blob.bin");
  restoredBytes[1] = 99;
  assert.deepEqual(await restored.readFile("/workspace/blob.bin"), bytes([1, 2, 3, 250]));
  assert.deepEqual(await restored.exportSnapshot(), snapshot);
});

test("browser workspace rejects invalid paths and type mismatches", async () => {
  const workspace = createMemoryBrowserWorkspaceStore();
  await workspace.createDirectory("/workspace/src");
  await workspace.writeFile("/workspace/src/app.txt", "hello");

  await assertRejectsKind(() => workspace.writeFile("/tmp/app.txt", "bad"), "invalid_path");
  await assertRejectsKind(() => workspace.writeFile("../app.txt", "bad"), "invalid_path");
  await assertRejectsKind(() => workspace.writeFile("src\\app.txt", "bad"), "invalid_path");
  await assertRejectsKind(() => workspace.readFile("/workspace/src"), "not_file");
  await assertRejectsKind(
    () => workspace.readDirectory("/workspace/src/app.txt"),
    "not_directory",
  );
  await assertRejectsKind(
    () => workspace.writeFile("/workspace/missing/app.txt", "bad"),
    "not_found",
  );
  await assertRejectsKind(
    () => workspace.rename("/workspace/src", "/workspace/src/nested"),
    "invalid_path",
  );
  await assertRejectsKind(
    () => workspace.importSnapshot({
      directories: [],
      files: [{ contentBase64: "", mtimeMs: 0, path: "/workspace/missing/file.txt" }],
      root: "/workspace",
      version: 1,
    }),
    "invalid_snapshot",
  );
  await assertRejectsKind(
    () => workspace.importSnapshot({
      directories: [{ mtimeMs: 0, path: "/workspace/conflict" }],
      files: [{ contentBase64: "", mtimeMs: 0, path: "/workspace/conflict" }],
      root: "/workspace",
      version: 1,
    }),
    "invalid_snapshot",
  );
});

test("indexeddb browser workspace persists snapshots across instances", async () => {
  const indexedDB = fakeIndexedDB();
  const first = createIndexedDbBrowserWorkspaceStore({
    dbName: "workspace-persist",
    indexedDB,
    now: () => 100,
    workspaceId: "project",
  });

  await first.createDirectory("/workspace/src");
  await first.writeFile("/workspace/src/app.js", "console.log(1);\n");

  const second = createIndexedDbBrowserWorkspaceStore({
    dbName: "workspace-persist",
    indexedDB,
    now: () => 200,
    workspaceId: "project",
  });
  assert.equal(text(await second.readFile("/workspace/src/app.js")), "console.log(1);\n");
  await second.rename("/workspace/src/app.js", "/workspace/src/main.js");
  await second.writeFile("/workspace/src/main.js", "console.log(2);\n");

  const third = createIndexedDbBrowserWorkspaceStore({
    dbName: "workspace-persist",
    indexedDB,
    workspaceId: "project",
  });
  await assertRejectsKind(
    () => third.readFile("/workspace/src/app.js"),
    "not_found",
  );
  assert.equal(text(await third.readFile("/workspace/src/main.js")), "console.log(2);\n");
  assert(indexedDB.openCount >= 2);
});

test("default browser workspace falls back to memory without indexeddb", async () => {
  const workspace = createDefaultBrowserWorkspaceStore({ indexedDB: null });
  await workspace.writeFile("/workspace/hello.txt", "hello");

  assert.equal(text(await workspace.readFile("/workspace/hello.txt")), "hello");
});

test("browser workspace factory aliases default storage and normalizes paths", async () => {
  const workspace = createBrowserWorkspaceStore({ indexedDB: null });
  await workspace.createDirectory("src");
  await workspace.writeFile("src/./hello.txt", "hello");

  assert.deepEqual(normalizeWorkspacePath("/workspace/src/./hello.txt"), {
    relativePath: "src/hello.txt",
    workspacePath: "/workspace/src/hello.txt",
  });
  assert.equal(text(await workspace.readFile("/workspace/src/hello.txt")), "hello");
});

async function assertRejectsKind(action, kind) {
  await assert.rejects(action, (error) => {
    assert(error instanceof BrowserWorkspaceError);
    assert.equal(error.kind, kind);
    return true;
  });
}

function text(bytes) {
  return decoder.decode(bytes);
}

function bytes(values) {
  return new Uint8Array(values);
}

function fakeIndexedDB() {
  const databases = new Map();
  const factory = {
    openCount: 0,
    open(name, version = 1) {
      factory.openCount += 1;
      const request = new FakeIdbRequest();
      queueMicrotask(() => {
        let database = databases.get(name);
        const shouldUpgrade = !database || version > database.version;
        if (!database) {
          database = {
            stores: new Map(),
            version,
          };
          databases.set(name, database);
        } else if (version > database.version) {
          database.version = version;
        }
        request.result = new FakeIdbDatabase(database);
        if (shouldUpgrade) {
          request.onupgradeneeded?.({ target: request });
        }
        request.onsuccess?.({ target: request });
      });
      return request;
    },
  };
  return factory;
}

class FakeIdbRequest {
  constructor() {
    this.error = null;
    this.onblocked = null;
    this.onerror = null;
    this.onsuccess = null;
    this.onupgradeneeded = null;
    this.result = undefined;
  }
}

class FakeIdbDatabase {
  constructor(database) {
    this.database = database;
    this.objectStoreNames = {
      contains: (name) => this.database.stores.has(name),
    };
  }

  createObjectStore(name) {
    if (!this.database.stores.has(name)) {
      this.database.stores.set(name, new Map());
    }
    return new FakeIdbObjectStore(this.database.stores.get(name), null);
  }

  transaction(storeNames) {
    return new FakeIdbTransaction(
      this.database,
      Array.isArray(storeNames) ? storeNames : [storeNames],
    );
  }
}

class FakeIdbTransaction {
  constructor(database, storeNames) {
    this.database = database;
    this.error = null;
    this.completed = false;
    this.onabort = null;
    this.oncomplete = null;
    this.onerror = null;
    this.pending = 0;
    this.storeNames = storeNames;
  }

  objectStore(name) {
    if (!this.storeNames.includes(name) || !this.database.stores.has(name)) {
      throw new Error(`unknown object store: ${name}`);
    }
    return new FakeIdbObjectStore(this.database.stores.get(name), this);
  }

  request(operation) {
    const request = new FakeIdbRequest();
    this.pending += 1;
    queueMicrotask(() => {
      try {
        request.result = operation();
        request.onsuccess?.({ target: request });
      } catch (error) {
        this.error = error;
        request.error = error;
        request.onerror?.({ target: request });
        this.onerror?.({ target: this });
      } finally {
        this.pending -= 1;
        this.completeIfIdle();
      }
    });
    return request;
  }

  completeIfIdle() {
    if (this.completed || this.pending !== 0) {
      return;
    }
    this.completed = true;
    queueMicrotask(() => {
      this.oncomplete?.({ target: this });
    });
  }
}

class FakeIdbObjectStore {
  constructor(store, transaction) {
    this.store = store;
    this.transaction = transaction;
  }

  put(value, key) {
    return this.transaction.request(() => {
      this.store.set(key, structuredClone(value));
      return key;
    });
  }

  get(key) {
    return this.transaction.request(() => structuredClone(this.store.get(key)));
  }
}
