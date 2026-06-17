import assert from "node:assert/strict";
import test from "node:test";
import {
  WASMER_SDK_ADAPTER_FINDINGS,
  WasmerSdkAdapterError,
  createWasmerSdkCommandExecutor,
  normalizePackageSource,
  normalizeWasmerRunRequest,
  normalizeWasmerRunResult,
  snapshotToWasmerDirectory,
  wasmerDirectoryToSnapshot,
} from "../src/index.js";

const decoder = new TextDecoder();

test("normalizes run requests without importing the real SDK", () => {
  const request = normalizeWasmerRunRequest({
    args: ["-lc", "echo ok"],
    command: "bash",
    cwd: "/workspace",
    env: { PATH: "/bin:/usr/bin" },
    package: { name: "wasmer/bash", version: "1.0.25" },
    stdin: "input",
    uses: ["wasmer/coreutils@1.0.25"],
    workspaceSnapshot: [
      { path: "/notes", type: "directory" },
      { contents: "hello", path: "/notes/input.txt" },
    ],
  });

  assert.deepEqual(request.args, ["-lc", "echo ok"]);
  assert.equal(request.command, "bash");
  assert.equal(request.cwd, "/workspace");
  assert.equal(request.env.PATH, "/bin:/usr/bin");
  assert.equal(request.package.name, "wasmer/bash");
  assert.equal(request.package.version, "1.0.25");
  assert.equal(request.stdin, "input");
  assert.deepEqual(request.uses, ["wasmer/coreutils@1.0.25"]);
  assert.equal(request.workspaceMountPath, "/workspace");
  assert.equal(request.workspaceSnapshot[0].type, "directory");
  assert.equal(decoder.decode(request.workspaceSnapshot[1].bytes), "hello");
});

test("normalizes Wasmer output to command result fields", () => {
  const result = normalizeWasmerRunResult({
    code: 7,
    ok: false,
    stderr: "err",
    stdout: "out",
  });

  assert.equal(result.exitCode, 7);
  assert.equal(result.ok, false);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.deepEqual([...result.stdoutBytes], [...new TextEncoder().encode("out")]);
});

test("round-trips workspace snapshots through SDK Directory shape", async () => {
  const sdk = fakeSdk();
  const directory = await snapshotToWasmerDirectory(sdk, [
    { path: "/src", type: "directory" },
    { contents: "console.log(1);", path: "/src/index.js" },
  ]);

  await directory.writeFile("/src/output.txt", "done");
  const snapshot = await wasmerDirectoryToSnapshot(directory);
  assert.deepEqual(
    snapshot.map((entry) => [
      entry.type,
      entry.path,
      entry.bytes ? decoder.decode(entry.bytes) : "",
    ]),
    [
      ["directory", "/src", ""],
      ["file", "/src/index.js", "console.log(1);"],
      ["file", "/src/output.txt", "done"],
    ],
  );
});

test("executor maps command request to SDK package run and returns result", async () => {
  const sdk = fakeSdk({
    output: { code: 1, ok: false, stderr: "missing\n", stdout: "CAT_STATUS:1\n" },
  });
  const stdout = captureWriter();
  const stderr = captureWriter();
  const executor = createWasmerSdkCommandExecutor({
    packageSource: { kind: "registry" },
    sdkLoader: async () => sdk,
  });

  const result = await executor.run(
    {
      args: ["-lc", "cat missing"],
      command: "bash",
      cwd: "/workspace",
      env: { PATH: "/bin:/usr/bin" },
      package: { name: "wasmer/bash", version: "1.0.25" },
      stdin: "",
      uses: ["wasmer/coreutils@1.0.25"],
      workspaceSnapshot: [{ contents: "alpha", path: "/input.txt" }],
    },
    { stderr, stdout },
  );

  assert.equal(sdk.initCalls.length, 1);
  assert.deepEqual(sdk.registrySpecifiers, ["wasmer/bash@1.0.25"]);
  assert.equal(sdk.lastRun.commandName, "bash");
  assert.deepEqual(sdk.lastRun.options.args, ["-lc", "cat missing"]);
  assert.equal(sdk.lastRun.options.cwd, "/workspace");
  assert.equal(sdk.lastRun.options.env.PATH, "/bin:/usr/bin");
  assert.equal(sdk.lastRun.options.stdin, "");
  assert.deepEqual(sdk.lastRun.options.uses, ["wasmer/coreutils@1.0.25"]);
  assert.equal(decoder.decode(stdout.bytes()), "CAT_STATUS:1\n");
  assert.equal(decoder.decode(stderr.bytes()), "missing\n");
  assert.deepEqual(result.diagnostics, [
    {
      group: "wasmer-sdk-adapter",
      name: "package-source",
      value: "registry",
    },
  ]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.failureStage, null);
  assert.equal(result.stdoutBytes, 13);
  assert.equal(result.stderrBytes, 8);
  assert.deepEqual(
    result.workspaceSnapshot.map((entry) => [
      entry.type,
      entry.path,
      entry.bytes ? decoder.decode(entry.bytes) : "",
    ]),
    [["file", "/input.txt", "alpha"]],
  );
});

test("executor rejects missing commands with a safe adapter error", async () => {
  const executor = createWasmerSdkCommandExecutor({
    sdkLoader: async () => fakeSdk(),
  });

  await assert.rejects(
    () =>
      executor.run({
        command: "missing",
        package: { name: "wasmer/bash" },
      }),
    (error) => {
      assert(error instanceof WasmerSdkAdapterError);
      assert.equal(error.kind, "command_not_found");
      assert.equal(error.safe, true);
      return true;
    },
  );
});

test("executor does not cache byte-loaded packages by byte length", async () => {
  const sdk = fakeSdk();
  const executor = createWasmerSdkCommandExecutor({
    packageSource: { kind: "webc-bytes" },
    sdkLoader: async () => sdk,
  });

  await executor.run({
    command: "bash",
    package: { bytes: new Uint8Array([1, 2]), name: "local/webc" },
  });
  await executor.run({
    command: "bash",
    package: { bytes: new Uint8Array([3, 4]), name: "local/webc" },
  });

  assert.deepEqual(
    sdk.fileBytesCalls.map((bytes) => [...bytes]),
    [
      [1, 2],
      [3, 4],
    ],
  );
});

test("executor rejects byte package sources without bytes", async () => {
  const executor = createWasmerSdkCommandExecutor({
    packageSource: { kind: "webc-bytes" },
    sdkLoader: async () => fakeSdk(),
  });

  await assert.rejects(
    () =>
      executor.run({
        command: "bash",
        package: { name: "local/webc" },
      }),
    (error) => {
      assert(error instanceof WasmerSdkAdapterError);
      assert.equal(error.kind, "missing_package_bytes");
      return true;
    },
  );
});

test("documents the evaluated SDK responsibility boundary", () => {
  assert.deepEqual(normalizePackageSource({ kind: "webc-bytes" }), {
    kind: "webc-bytes",
  });
  assert(
    WASMER_SDK_ADAPTER_FINDINGS.browserRequirements.includes(
      "SharedArrayBuffer",
    ),
  );
  assert(
    WASMER_SDK_ADAPTER_FINDINGS.wasmHostOwnedResponsibilities.includes(
      "package pinning, hashing, and cache policy",
    ),
  );
  assert(
    WASMER_SDK_ADAPTER_FINDINGS.sdkOwnedResponsibilities.includes(
      "WASIX syscall implementation",
    ),
  );
});

function fakeSdk(options = {}) {
  const sdk = {
    fileBytesCalls: [],
    initCalls: [],
    lastRun: null,
    registrySpecifiers: [],
    Directory: FakeDirectory,
    Wasmer: {
      async fromRegistry(specifier) {
        sdk.registrySpecifiers.push(specifier);
        return fakePackage(sdk, options);
      },
      async fromFile(bytes) {
        sdk.fileBytesCalls.push(bytes);
        return fakePackage(sdk, options);
      },
      fromWasm(bytes) {
        sdk.wasmBytes = bytes;
        return fakePackage(sdk, options);
      },
    },
    async init(initOptions) {
      sdk.initCalls.push(initOptions);
    },
  };
  return sdk;
}

function fakePackage(sdk, options) {
  return {
    commands: {
      bash: fakeCommand(sdk, "bash", options),
      cat: fakeCommand(sdk, "cat", options),
    },
    entrypoint: fakeCommand(sdk, "entrypoint", options),
  };
}

function fakeCommand(sdk, commandName, options) {
  return {
    async run(runOptions) {
      sdk.lastRun = { commandName, options: runOptions };
      return {
        async wait() {
          return options.output ?? { code: 0, ok: true, stdout: "ok\n", stderr: "" };
        },
      };
    },
  };
}

class FakeDirectory {
  constructor(init = null) {
    this.entries = new Map();
    this.entries.set("/", { type: "directory" });
    for (const [path, contents] of Object.entries(init ?? {})) {
      this.writeFile(path, contents);
    }
  }

  async createDir(path) {
    const normalized = normalizePath(path);
    this.entries.set(normalized, { type: "directory" });
  }

  async writeFile(path, contents) {
    const normalized = normalizePath(path);
    const bytes =
      typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
    this.entries.set(normalized, { bytes, type: "file" });
  }

  async readFile(path) {
    const entry = this.entries.get(normalizePath(path));
    if (!entry || entry.type !== "file") {
      throw new Error(`missing file: ${path}`);
    }
    return entry.bytes;
  }

  async readTextFile(path) {
    return decoder.decode(await this.readFile(path));
  }

  async readDir(path) {
    const normalized = normalizePath(path);
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const names = new Map();
    for (const [entryPath, entry] of this.entries) {
      if (entryPath === normalized || !entryPath.startsWith(prefix)) {
        continue;
      }
      const rest = entryPath.slice(prefix.length);
      const [name, ...tail] = rest.split("/");
      if (!name) {
        continue;
      }
      const type = tail.length > 0 ? "dir" : entry.type === "directory" ? "dir" : "file";
      names.set(name, { name, type });
    }
    return Array.from(names.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }
}

function captureWriter() {
  const chunks = [];
  return {
    bytes() {
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    },
    async write(chunk) {
      chunks.push(chunk);
    },
  };
}

function normalizePath(path) {
  const parts = path.split("/").filter(Boolean);
  return `/${parts.join("/")}`;
}
