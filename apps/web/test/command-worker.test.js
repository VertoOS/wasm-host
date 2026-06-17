import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserCommandWorkerError,
  BrowserCommandWorkerRuntime,
  createBrowserCommandWorkerRuntime,
} from "../src/command-worker.js";
import {
  CODEX_VERSION_SMOKE_STDOUT,
  CODEX_VERSION_SMOKE_WASM,
} from "../fixtures/codex-version-smoke-core.js";
import {
  webcV2Bytes,
  webcWasiCommandManifest,
} from "../fixtures/webc-metadata-fixture.js";
import { HttpBridgeError } from "../src/http.js";
import { createWebcWasixExecutor } from "../src/webc-wasix.js";
import { createMemoryBrowserWorkspaceStore } from "../src/workspace.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const WEBC_VOLUME_READ_WASM = base64ToBytes(
  "AGFzbQEAAAABHQRgCX9/f39/fn5/fwF/YAR/f39/AX9gAX8AYAAAAooBBBZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCXBhdGhfb3BlbgAAFndhc2lfc25hcHNob3RfcHJldmlldzEHZmRfcmVhZAABFndhc2lfc25hcHNob3RfcHJldmlldzEIZmRfd3JpdGUAARZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCXByb2NfZXhpdAACAwIBAwUDAQABBxMCBm1lbW9yeQIABl9zdGFydAAECmcBZQEBf0EFQQBBgAhBD0EAQgJCAEEAQRAQACIABEAgABADC0EAQYAQNgIAQQRBwAA2AgBBECgCAEEAQQFBCBABIgAEQCAAEAMLQRhBgBA2AgBBHEEIKAIANgIAQQFBGEEBQSAQAhoLCxYBAEGACAsPZXRjL21lc3NhZ2UudHh0",
);

test("BrowserCommandWorkerRuntime loads and runs a command", async () => {
  const port = recordingPort();
  const seen = {};
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: { name: "direct" }, gateway: { name: "gateway" } },
    port,
    executors: {
      test: {
        async run(request, output) {
          seen.command = request.command;
          seen.args = request.args;
          seen.cwd = request.cwd;
          seen.env = request.env;
          seen.httpTransportName = request.httpTransportName;
          seen.httpTransport = request.httpTransport;
          seen.stdin = await asyncChunksText(request.stdin);
          await output.writeStdout("out");
          await output.writeStderr(encoder.encode("err"));
          return { exitCode: 7 };
        },
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-1",
    package: {
      id: "pkg",
      type: "test",
      commands: ["run-test"],
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-1",
    packageId: "pkg",
    command: "run-test",
    args: ["--flag", "value"],
    cwd: "/workspace/app",
    env: { A: "1", B: 2 },
    httpTransport: "gateway",
    stdinBase64: "aW5wdXQ=",
  });

  assert.deepEqual(seen, {
    args: ["--flag", "value"],
    command: "run-test",
    cwd: "/workspace/app",
    env: { A: "1", B: "2" },
    httpTransport: { name: "gateway" },
    httpTransportName: "gateway",
    stdin: "input",
  });
  assert.deepEqual(port.messages, [
    {
      type: "command.loaded",
      id: "load-1",
      artifactKind: null,
      cache: null,
      contentSha256: null,
      entrypoint: "run-test",
      packageId: "pkg",
      packageType: "test",
      commands: ["run-test"],
    },
    {
      type: "command.started",
      id: "run-1",
      packageId: "pkg",
      command: "run-test",
      args: ["--flag", "value"],
      cwd: "/workspace/app",
    },
    {
      type: "command.stdout",
      id: "run-1",
      chunk: encoder.encode("out"),
    },
    {
      type: "command.stderr",
      id: "run-1",
      chunk: encoder.encode("err"),
    },
    {
      type: "command.stdout.close",
      id: "run-1",
    },
    {
      type: "command.stderr.close",
      id: "run-1",
    },
    {
      type: "command.complete",
      id: "run-1",
      result: {
        cancelled: false,
        exitCode: 7,
        failureStage: null,
        stderrBytes: 3,
        stdoutBytes: 3,
        timedOut: false,
      },
    },
  ]);
});

test("BrowserCommandWorkerRuntime preserves default package runs without packageId", async () => {
  const port = recordingPort();
  const seen = [];
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
    executors: {
      test: {
        async run(request, output) {
          seen.push({
            command: request.command,
            packageId: request.package.id,
          });
          await output.writeStdout("default package\n");
          return { exitCode: 0 };
        },
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-default",
    package: {
      commands: ["run-default"],
      type: "test",
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-default",
    command: "run-default",
  });

  assert.deepEqual(seen, [{ command: "run-default", packageId: "default" }]);
  assert.deepEqual(
    port.messages.find(
      (message) =>
        message.type === "command.started" && message.id === "run-default",
    ),
    {
      type: "command.started",
      id: "run-default",
      packageId: "default",
      command: "run-default",
      args: [],
      cwd: "/workspace",
    },
  );
  assert.equal(
    chunksText(stdoutChunks(port.messages, "run-default")),
    "default package\n",
  );
});

test("BrowserCommandWorkerRuntime catalogs loaded commands and resolves PATH runs", async () => {
  const port = recordingPort();
  const seen = [];
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
    executors: {
      test: {
        async run(request, output) {
          seen.push({
            command: request.command,
            packageId: request.package.id,
          });
          await output.writeStdout(`${request.package.id}:${request.command}\n`);
          return { exitCode: 0 };
        },
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-bash",
    package: {
      commands: ["bash"],
      id: "bash-pkg",
      type: "test",
    },
  });
  await runtime.handleMessage({
    type: "command.load",
    id: "load-coreutils",
    package: {
      commands: ["ls", "env"],
      id: "coreutils-pkg",
      type: "test",
    },
  });
  await runtime.handleMessage({ type: "command.catalog", id: "catalog-1" });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-bash",
    packageId: null,
    command: "/bin/bash",
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-ls",
    packageId: null,
    command: "ls",
    env: { PATH: "/does-not-exist:/usr/bin" },
  });

  const catalog = port.messages.find(
    (message) => message.type === "command.catalog",
  );
  assert.equal(catalog.id, "catalog-1");
  assert.equal(catalog.defaultPath, "/bin:/usr/bin");
  assert(catalog.entries.some(catalogEntry("/bin/bash", "bash-pkg", "bash")));
  assert(catalog.entries.some(catalogEntry("/usr/bin/ls", "coreutils-pkg", "ls")));
  assert(
    catalog.entries.some(catalogEntry("/usr/bin/env", "coreutils-pkg", "env")),
  );
  assert.deepEqual(seen, [
    { command: "bash", packageId: "bash-pkg" },
    { command: "ls", packageId: "coreutils-pkg" },
  ]);
  assert.equal(
    chunksText(stdoutChunks(port.messages, "run-bash")) +
      chunksText(stdoutChunks(port.messages, "run-ls")),
    "bash-pkg:bash\ncoreutils-pkg:ls\n",
  );
});

test("BrowserCommandWorkerRuntime reports catalog misses for explicit PATH runs", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
    executors: {
      test: {
        async run() {
          return { exitCode: 0 };
        },
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    package: { commands: ["ls"], id: "coreutils-pkg", type: "test" },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-missing-path",
    packageId: null,
    command: "ls",
    env: { PATH: "" },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-nul-command",
    packageId: null,
    command: "ls\0",
  });

  assert.deepEqual(
    port.messages.find(
      (message) =>
        message.type === "command.error" &&
        message.id === "run-missing-path",
    ),
    {
      type: "command.error",
      id: "run-missing-path",
      error: {
        kind: "command_not_found",
        message: "browser command not found in package catalog: ls",
        stage: "command_resolution",
      },
      result: {
        cancelled: false,
        exitCode: 127,
        failureStage: "command_resolution",
        stderrBytes: 0,
        stdoutBytes: 0,
        timedOut: false,
      },
    },
  );
  assert.deepEqual(
    port.messages.find(
      (message) =>
        message.type === "command.error" && message.id === "run-nul-command",
    ),
    {
      type: "command.error",
      id: "run-nul-command",
      error: {
        kind: "invalid_request",
        message: "browser command fields must not contain NUL bytes",
        stage: "command_resolution",
      },
      result: {
        cancelled: false,
        exitCode: null,
        failureStage: "command_resolution",
        stderrBytes: 0,
        stdoutBytes: 0,
        timedOut: false,
      },
    },
  );
});

test("BrowserCommandWorkerRuntime rejects command catalog collisions", async () => {
  const port = recordingPort();
  const seen = [];
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
    executors: {
      test: {
        async run(request, output) {
          seen.push({
            command: request.command,
            packageId: request.package.id,
          });
          await output.writeStdout(`${request.package.id}:${request.command}\n`);
          return { exitCode: 0 };
        },
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-coreutils-a",
    package: { commands: ["ls"], id: "coreutils-a", type: "test" },
  });
  await runtime.handleMessage({
    type: "command.load",
    id: "load-coreutils-b",
    package: { commands: ["ls"], id: "coreutils-b", type: "test" },
  });
  await runtime.handleMessage({
    type: "command.catalog",
    id: "catalog-after-collision",
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-ls-after-collision",
    packageId: null,
    command: "ls",
  });

  const loaded = port.messages.filter(
    (message) => message.type === "command.loaded",
  );
  const error = port.messages.find((message) => message.type === "command.error");
  const catalog = port.messages.find(
    (message) =>
      message.type === "command.catalog" &&
      message.id === "catalog-after-collision",
  );
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].packageId, "coreutils-a");
  assert.equal(error.id, "load-coreutils-b");
  assert.equal(error.error.kind, "command_catalog_collision");
  assert.equal(error.error.stage, "package_load");
  assert.match(error.error.message, /\/bin\/ls/);
  assert(catalog.entries.some(catalogEntry("/bin/ls", "coreutils-a", "ls")));
  assert.equal(
    catalog.entries.some(catalogEntry("/bin/ls", "coreutils-b", "ls")),
    false,
  );
  assert.deepEqual(seen, [{ command: "ls", packageId: "coreutils-a" }]);
  assert.equal(
    chunksText(stdoutChunks(port.messages, "run-ls-after-collision")),
    "coreutils-a:ls\n",
  );
});

test("BrowserCommandWorkerRuntime lets commands invoke catalog child commands", async () => {
  const port = recordingPort();
  const seen = [];
  let parentSummary = null;
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
    executors: {
      child: {
        async run(request, output) {
          const stdin = await asyncChunksText(request.stdin);
          seen.push({
            args: request.args,
            command: request.command,
            cwd: request.cwd,
            env: request.env,
            packageId: request.package.id,
            stdin,
          });
          await output.writeStdout(`${request.package.id}:stdout:${stdin}`);
          await output.writeStderr(`${request.package.id}:stderr\n`);
          return { exitCode: request.package.id === "path-child" ? 7 : 0 };
        },
      },
      parent: {
        async run(request, output) {
          const defaultChild = await request.childCommands.run({
            command: "default-child",
            stdin: "default stdin\n",
          });
          const pathChild = await request.childCommands.run({
            args: ["--flag"],
            command: "path-child",
            cwd: "/workspace/child",
            env: {
              ...request.env,
              CHILD_ENV: "1",
              PATH: "/usr/bin",
            },
            packageId: null,
            stdin: "path stdin\n",
          });
          parentSummary = {
            default: childResultSummary(defaultChild),
            path: childResultSummary(pathChild),
          };
          await output.writeStdout(`${JSON.stringify(parentSummary)}\n`);
          return { exitCode: pathChild.exitCode };
        },
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    package: { commands: ["default-child"], type: "child" },
  });
  await runtime.handleMessage({
    type: "command.load",
    package: { commands: ["path-child"], id: "path-child", type: "child" },
  });
  await runtime.handleMessage({
    type: "command.load",
    package: { commands: ["parent"], id: "parent-pkg", type: "parent" },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-parent-child",
    packageId: "parent-pkg",
    command: "parent",
    env: { PARENT_ENV: "1" },
  });

  assert.deepEqual(seen, [
    {
      args: [],
      command: "default-child",
      cwd: "/workspace",
      env: { PARENT_ENV: "1" },
      packageId: "default",
      stdin: "default stdin\n",
    },
    {
      args: ["--flag"],
      command: "path-child",
      cwd: "/workspace/child",
      env: { CHILD_ENV: "1", PARENT_ENV: "1", PATH: "/usr/bin" },
      packageId: "path-child",
      stdin: "path stdin\n",
    },
  ]);
  assert.deepEqual(parentSummary, {
    default: {
      command: "default-child",
      exitCode: 0,
      packageId: "default",
      stderr: "default:stderr\n",
      stderrBytes: 15,
      stdout: "default:stdout:default stdin\n",
      stdoutBytes: 29,
    },
    path: {
      command: "path-child",
      exitCode: 7,
      packageId: "path-child",
      stderr: "path-child:stderr\n",
      stderrBytes: 18,
      stdout: "path-child:stdout:path stdin\n",
      stdoutBytes: 29,
    },
  });
  assert.equal(
    chunksText(stdoutChunks(port.messages, "run-parent-child")),
    `${JSON.stringify(parentSummary)}\n`,
  );
  assert.equal(chunksText(stderrChunks(port.messages, "run-parent-child")), "");
  assert.equal(port.messages.at(-1).result.exitCode, 7);
});

test("BrowserCommandWorkerRuntime reports child command resolution failures", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
    executors: {
      parent: {
        async run(request) {
          await request.childCommands.run({
            command: "missing-child",
            packageId: null,
          });
          return { exitCode: 0 };
        },
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    package: { commands: ["parent"], id: "parent-pkg", type: "parent" },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-missing-child",
    packageId: "parent-pkg",
    command: "parent",
  });

  assert.deepEqual(
    port.messages.find(
      (message) =>
        message.type === "command.error" && message.id === "run-missing-child",
    ),
    {
      type: "command.error",
      id: "run-missing-child",
      error: {
        kind: "command_not_found",
        message: "browser command not found in package catalog: missing-child",
        stage: "command_resolution",
      },
      result: {
        cancelled: false,
        exitCode: 127,
        failureStage: "command_resolution",
        stderrBytes: 0,
        stdoutBytes: 0,
        timedOut: false,
      },
    },
  );
});

test("BrowserCommandWorkerRuntime can inherit child command output", async () => {
  const port = recordingPort();
  let childResult = null;
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
    executors: {
      child: {
        async run(_request, output) {
          await output.writeStdout("child stdout\n");
          await output.writeStderr("child stderr\n");
          return { exitCode: 0 };
        },
      },
      parent: {
        async run(request, output) {
          childResult = await request.childCommands.run({
            command: "child",
            packageId: null,
            stderr: "inherit",
            stdout: "inherit",
          });
          await output.writeStdout("parent stdout\n");
          return { exitCode: 0 };
        },
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    package: { commands: ["child"], id: "child-pkg", type: "child" },
  });
  await runtime.handleMessage({
    type: "command.load",
    package: { commands: ["parent"], id: "parent-pkg", type: "parent" },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-inherited-child",
    packageId: "parent-pkg",
    command: "parent",
  });

  assert.deepEqual(childResultSummary(childResult), {
    command: "child",
    exitCode: 0,
    packageId: "child-pkg",
    stderr: "",
    stderrBytes: 13,
    stdout: "",
    stdoutBytes: 13,
  });
  assert.deepEqual(
    port.messages
      .filter((message) => message.id === "run-inherited-child")
      .map((message) => message.type),
    [
      "command.started",
      "command.stdout",
      "command.stderr",
      "command.stdout",
      "command.stdout.close",
      "command.stderr.close",
      "command.complete",
    ],
  );
  assert.equal(
    chunksText(stdoutChunks(port.messages, "run-inherited-child")),
    "child stdout\nparent stdout\n",
  );
  assert.equal(
    chunksText(stderrChunks(port.messages, "run-inherited-child")),
    "child stderr\n",
  );
  assert.deepEqual(port.messages.at(-1).result, {
    cancelled: false,
    exitCode: 0,
    failureStage: null,
    stderrBytes: 13,
    stdoutBytes: 27,
    timedOut: false,
  });
});

test("BrowserCommandWorkerRuntime aborts child commands with parent timeout", async () => {
  const port = recordingPort();
  let childAbortKind = null;
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
    executors: {
      child: {
        async run(request) {
          try {
            await rejectOnAbort(request.signal);
          } catch (error) {
            childAbortKind = error.kind;
            throw error;
          }
          return { exitCode: 0 };
        },
      },
      parent: {
        async run(request) {
          await request.childCommands.run({
            command: "child-block",
            packageId: null,
          });
          return { exitCode: 0 };
        },
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    package: { commands: ["child-block"], id: "child-pkg", type: "child" },
  });
  await runtime.handleMessage({
    type: "command.load",
    package: { commands: ["parent"], id: "parent-pkg", type: "parent" },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-child-timeout",
    packageId: "parent-pkg",
    command: "parent",
    timeoutMs: 20,
  });
  for (let attempt = 0; attempt < 20 && childAbortKind == null; attempt += 1) {
    await tick();
  }

  assert.equal(childAbortKind, "timeout");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "run-child-timeout",
    error: {
      kind: "timeout",
      message: "browser command exceeded wall time limit",
      stage: "runtime",
    },
    result: {
      cancelled: false,
      exitCode: 124,
      failureStage: "runtime",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: true,
    },
  });
});

test("BrowserCommandWorkerRuntime streams stdin messages", async () => {
  const port = recordingPort();
  let stdin = null;
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    executors: {
      test: async (request) => {
        stdin = await asyncChunksText(request.stdin);
        return { exitCode: 0 };
      },
    },
    httpTransports: { direct: {} },
  });

  await runtime.handleMessage({
    type: "command.load",
    package: { id: "pkg", type: "test", commands: ["cat"] },
  });
  const run = runtime.handleMessage({
    type: "command.run",
    id: "run-stdin",
    packageId: "pkg",
    command: "cat",
    stdinOpen: true,
  });
  await tick();
  await runtime.handleMessage({
    type: "command.stdin",
    id: "run-stdin",
    chunk: "hello ",
  });
  await runtime.handleMessage({
    type: "command.stdin",
    id: "run-stdin",
    chunkBase64: "d29ybGQ=",
  });
  await runtime.handleMessage({ type: "command.stdin.end", id: "run-stdin" });
  await run;

  assert.equal(stdin, "hello world");
  assert.equal(port.messages.at(-1).type, "command.complete");
});

test("BrowserCommandWorkerRuntime exposes an HTTP bridge client to executors", async () => {
  const port = recordingPort();
  const seen = {};
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: {
      direct: recordingHttpTransport("direct", seen),
      gateway: recordingHttpTransport("gateway", seen),
    },
    executors: {
      http: {
        async run(request, output) {
          const response = await request.httpBridge.dispatch({
            bodyChunksBase64: ["cmVx", "dWVzdA=="],
            headers: [{ name: "X-Test", value: " yes " }],
            method: "POST",
            url: "https://example.test/bridge",
          });
          await output.writeStdout(
            `${request.httpTransportName}:${response.status}:` +
              `${response.headers[0].name}=${response.headers[0].value}:` +
              `${response.bodyChunks.length}:` +
              decoder.decode(response.body),
          );
          return { exitCode: 0 };
        },
      },
    },
  });

  await loadHttpPackage(runtime);
  await runtime.handleMessage({
    type: "command.run",
    id: "http-run",
    packageId: "http-pkg",
    command: "http",
    httpTransport: "gateway",
  });

  assert.deepEqual(seen, {
    body: "request",
    headers: [{ name: "x-test", value: "yes" }],
    method: "POST",
    name: "gateway",
    signalAborted: false,
    url: "https://example.test/bridge",
  });
  assert.equal(
    chunksText(stdoutChunks(port.messages, "http-run")),
    "gateway:202:x-bridge=ok:2:hello world",
  );
  assert.equal(port.messages.at(-1).type, "command.complete");
});

test("BrowserCommandWorkerRuntime injects workspace stores only for workspace-backed packages", async () => {
  const port = recordingPort();
  const workspaceStore = { readFile() {}, writeFile() {} };
  const seen = {};
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
    workspaceStore,
    executors: {
      "codex-browser": {
        async run(request) {
          seen.codexBrowser = request.workspaceStore;
          return { exitCode: 0 };
        },
      },
      "browser-tool-fixture": {
        async run(request) {
          seen.browserToolFixture = request.workspaceStore;
          return { exitCode: 0 };
        },
      },
      test: {
        async run(request) {
          seen.test = request.workspaceStore;
          return { exitCode: 0 };
        },
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-codex-browser",
    package: {
      commands: ["workspace-edit"],
      id: "codex-browser",
      type: "codex-browser",
    },
  });
  await runtime.handleMessage({
    type: "command.load",
    id: "load-test",
    package: { commands: ["run-test"], id: "test-pkg", type: "test" },
  });
  await runtime.handleMessage({
    type: "command.load",
    id: "load-browser-tool-fixture",
    package: {
      commands: ["tool-inspect"],
      id: "browser-tool-fixture",
      type: "browser-tool-fixture",
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-codex-browser",
    packageId: "codex-browser",
    command: "workspace-edit",
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-browser-tool-fixture",
    packageId: "browser-tool-fixture",
    command: "tool-inspect",
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-test",
    packageId: "test-pkg",
    command: "run-test",
  });

  assert.equal(seen.codexBrowser, workspaceStore);
  assert.equal(seen.browserToolFixture, workspaceStore);
  assert.equal(seen.test, undefined);
});

test("BrowserCommandWorkerRuntime preserves HTTP bridge errors for executors", async () => {
  const port = recordingPort();
  let seenError = null;
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: {
      direct: {
        async dispatch() {
          throw new HttpBridgeError("cors", "blocked by policy");
        },
      },
    },
    executors: {
      http: {
        async run(request, output) {
          try {
            await request.httpBridge.dispatch({
              method: "GET",
              url: "https://example.test/blocked",
            });
          } catch (error) {
            seenError = error;
            await output.writeStdout(`${error.kind}:${error.message}`);
          }
          return { exitCode: 0 };
        },
      },
    },
  });

  await loadHttpPackage(runtime);
  await runtime.handleMessage({
    type: "command.run",
    id: "http-error-run",
    packageId: "http-pkg",
    command: "http",
  });

  assert(seenError instanceof HttpBridgeError);
  assert.equal(seenError.kind, "cors");
  assert.equal(
    chunksText(stdoutChunks(port.messages, "http-error-run")),
    "cors:blocked by policy",
  );
  assert.equal(port.messages.at(-1).type, "command.complete");
});

test("BrowserCommandWorkerRuntime runs the built-in HTTP smoke executor", async () => {
  const port = recordingPort();
  const seen = {};
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: {
      direct: recordingHttpTransport("direct", seen),
      gateway: recordingHttpTransport("gateway", seen),
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-http-smoke",
    package: {
      id: "http-smoke",
      type: "http-smoke",
      commands: ["http-smoke"],
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-http-smoke",
    packageId: "http-smoke",
    command: "http-smoke",
    args: ["https://example.test/smoke"],
    httpTransport: "gateway",
  });

  assert.deepEqual(port.messages.find((message) => message.id === "load-http-smoke"), {
    type: "command.loaded",
    id: "load-http-smoke",
    artifactKind: null,
    cache: null,
    contentSha256: null,
    entrypoint: "http-smoke",
    packageId: "http-smoke",
    packageType: "http-smoke",
    commands: ["http-smoke"],
  });
  assert.deepEqual(seen, {
    body: "",
    headers: [],
    method: "GET",
    name: "gateway",
    signalAborted: false,
    url: "https://example.test/smoke",
  });
  assert.equal(
    chunksText(stdoutChunks(port.messages, "run-http-smoke")),
    "hello world",
  );
  assert.equal(chunksText(stderrChunks(port.messages, "run-http-smoke")), "");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.complete",
    id: "run-http-smoke",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 11,
      timedOut: false,
    },
  });
});

test("BrowserCommandWorkerRuntime runs extracted WebC atoms through WASI", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-webc",
    package: {
      bytes: executableWebcBytes(),
      id: "codex-webc",
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-webc",
    packageId: "codex-webc",
    command: "codex",
    args: ["--version"],
    cwd: "/workspace",
  });

  const loaded = port.messages.find((message) => message.id === "load-webc");
  assert.equal(loaded.artifactKind, "webc-package");
  assert.equal(loaded.packageType, "webc-package");
  assert.deepEqual(loaded.commands, ["codex"]);
  assert.match(loaded.contentSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    port.messages.find((message) => message.id === "run-webc"),
    {
      type: "command.started",
      id: "run-webc",
      packageId: "codex-webc",
      command: "codex",
      args: ["--version"],
      cwd: "/workspace",
    },
  );
  assert.equal(
    chunksText(stdoutChunks(port.messages, "run-webc")),
    CODEX_VERSION_SMOKE_STDOUT,
  );
  assert.deepEqual(port.messages.at(-1), {
    type: "command.complete",
    id: "run-webc",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: CODEX_VERSION_SMOKE_STDOUT.length,
      timedOut: false,
    },
  });
});

test("BrowserCommandWorkerRuntime mounts WebC volume files for atoms", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-webc-volume",
    package: {
      bytes: executableWebcVolumeBytes(),
      id: "volume-webc",
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-webc-volume",
    packageId: "volume-webc",
    command: "cat-volume",
  });

  const loaded = port.messages.find(
    (message) => message.id === "load-webc-volume",
  );
  assert.equal(loaded.artifactKind, "webc-package");
  assert.equal(loaded.packageType, "webc-package");
  assert.deepEqual(loaded.commands, ["cat-volume"]);
  assert.equal(
    chunksText(stdoutChunks(port.messages, "run-webc-volume")),
    "from-volume\n",
  );
  assert.deepEqual(port.messages.at(-1), {
    type: "command.complete",
    id: "run-webc-volume",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 12,
      timedOut: false,
    },
  });
});

test("WebC WASIX executor maps command metadata into raw WASI requests", async () => {
  let delegated = null;
  const childCommands = { run: async () => ({ exitCode: 0 }) };
  const packageBytes = encoder.encode("xxfrom-volume\nzz");
  const executor = createWebcWasixExecutor({
    cache: {
      async getModuleArtifact(key) {
        assert.equal(key, "cache://codex-atom");
        return CODEX_VERSION_SMOKE_WASM;
      },
      async getPackageBytes(key) {
        assert.equal(key, "cache://package");
        return packageBytes;
      },
    },
    rawWasiExecutor: {
      async run(request) {
        delegated = request;
        return { exitCode: 0 };
      },
    },
  });

  const result = await executor.run({
    args: ["--user"],
    childCommands,
    command: "codex",
    cwd: "/workspace/request",
    env: { EXTRA: "1", FROM_WEB: "override" },
    package: webcPackageForRun({
      cacheKeys: {
        packageBytes: "cache://package",
      },
      commandMetadata: {
        codex: {
          atom: "codex-atom",
          cwd: "/workspace/webc",
          env: ["FROM_WEB=metadata", "ONLY_WEB=1"],
          execName: "codex-real",
          mainArgs: ["--manifest"],
          runner: "https://webc.org/runner/wasi",
        },
      },
      webcArtifacts: {
        atoms: {
          "codex-atom": {
            cacheKey: "cache://codex-atom",
          },
        },
        volumes: {
          "/rootfs": {
            files: {
              "/rootfs/etc/message.txt": {
                path: "/rootfs/etc/message.txt",
                span: { length: 12, offset: 2 },
              },
            },
            name: "/rootfs",
          },
        },
      },
      filesystem: [
        {
          hostPath: "rootfs",
          mountPath: "/",
          volumeName: "/rootfs",
        },
      ],
    }),
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(delegated.command, "codex-real");
  assert.deepEqual(delegated.args, ["--manifest", "--user"]);
  assert.equal(delegated.childCommands, childCommands);
  assert.equal(delegated.cwd, "/workspace/webc");
  assert.deepEqual(delegated.env, {
    EXTRA: "1",
    FROM_WEB: "override",
    ONLY_WEB: "1",
  });
  assert.equal(delegated.package.artifactKind, "wasi-module");
  assert.deepEqual(delegated.package.commands, ["codex-real"]);
  assert.deepEqual(delegated.package.rootFiles, [
    {
      bytes: encoder.encode("from-volume\n"),
      path: "etc/message.txt",
    },
  ]);
});

test("WebC WASIX executor reports missing cached atom bytes", async () => {
  const executor = createWebcWasixExecutor({
    cache: {
      async getModuleArtifact() {
        return null;
      },
    },
    rawWasiExecutor: {
      async run() {
        throw new Error("raw WASI executor should not run without atom bytes");
      },
    },
  });

  await assert.rejects(
    executor.run({
      args: [],
      command: "codex",
      cwd: "/workspace",
      env: {},
      package: webcPackageForRun({
        commandMetadata: {
          codex: {
            atom: "codex-atom",
            runner: "https://webc.org/runner/wasi",
          },
        },
        webcArtifacts: {
          atoms: {
            "codex-atom": {
              cacheKey: "cache://missing",
            },
          },
        },
      }),
      signal: new AbortController().signal,
    }),
    (error) => {
      assert.equal(error.kind, "webc_wasix_atom_cache_missing");
      assert.equal(error.stage, "package_load");
      assert.match(error.message, /cache:\/\/missing/);
      return true;
    },
  );
});

test("WebC WASIX executor reports missing package bytes for volume mounts", async () => {
  const executor = createWebcWasixExecutor({
    cache: {
      async getModuleArtifact() {
        return CODEX_VERSION_SMOKE_WASM;
      },
      async getPackageBytes() {
        return null;
      },
    },
    rawWasiExecutor: {
      async run() {
        throw new Error("raw WASI executor should not run without package bytes");
      },
    },
  });

  await assert.rejects(
    executor.run({
      args: [],
      command: "codex",
      cwd: "/workspace",
      env: {},
      package: webcPackageForRun({
        cacheKeys: {
          packageBytes: "cache://missing-package",
        },
        commandMetadata: {
          codex: {
            atom: "codex-atom",
            runner: "https://webc.org/runner/wasi",
          },
        },
        filesystem: [
          {
            hostPath: "rootfs",
            mountPath: "/",
            volumeName: "/rootfs",
          },
        ],
        webcArtifacts: {
          atoms: {
            "codex-atom": {
              cacheKey: "cache://codex-atom",
            },
          },
          volumes: {
            "/rootfs": {
              files: {
                "/rootfs/etc/message.txt": {
                  path: "/rootfs/etc/message.txt",
                  span: { length: 12, offset: 2 },
                },
              },
              name: "/rootfs",
            },
          },
        },
      }),
      signal: new AbortController().signal,
    }),
    (error) => {
      assert.equal(error.kind, "webc_wasix_package_bytes_missing");
      assert.equal(error.stage, "package_load");
      assert.match(error.message, /cache:\/\/missing-package/);
      return true;
    },
  );
});

test("BrowserCommandWorkerRuntime accepts explicit webc-wasix packages", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-explicit-webc-wasix",
    package: {
      artifactKind: "webc-package",
      commands: ["sh"],
      id: "explicit-webc",
      type: "webc-wasix",
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-explicit-webc-wasix",
    packageId: "explicit-webc",
    command: "sh",
  });

  assert.deepEqual(
    port.messages.find((message) => message.id === "load-explicit-webc-wasix"),
    {
      type: "command.loaded",
      id: "load-explicit-webc-wasix",
      artifactKind: "webc-package",
      cache: null,
      contentSha256: null,
      entrypoint: "sh",
      packageId: "explicit-webc",
      packageType: "webc-wasix",
      commands: ["sh"],
    },
  );
  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "run-explicit-webc-wasix",
    error: {
      kind: "webc_wasix_atom_metadata_missing",
      message: "browser WebC command metadata is missing for sh",
      stage: "command_resolution",
    },
    result: {
      cancelled: false,
      exitCode: 126,
      failureStage: "command_resolution",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
});

test("BrowserCommandWorkerRuntime runs browser tool fixtures with workspace input", async () => {
  const port = recordingPort();
  const workspaceStore = createMemoryBrowserWorkspaceStore();
  await workspaceStore.createDirectory("/workspace/tools", { recursive: true });
  await workspaceStore.writeFile("/workspace/tools/input.txt", "tool file\n");
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
    workspaceStore,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-tool-fixture",
    package: {
      bytes: webcBytes("tool-fixture"),
      commands: ["tool-inspect"],
      executorType: "browser-tool-fixture",
      id: "tool-fixture",
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-tool-fixture",
    packageId: "tool-fixture",
    command: "tool-inspect",
    args: ["/workspace/tools/input.txt", "--unused"],
    cwd: "/workspace/tools",
    env: {
      BROWSER_TOOL_MODE: "unit",
      SECRET_SHOULD_NOT_ECHO: "nope",
    },
    stdinChunks: ["stdin ", "payload\n"],
  });

  const stdout = chunksText(stdoutChunks(port.messages, "run-tool-fixture"));
  const stderr = chunksText(stderrChunks(port.messages, "run-tool-fixture"));
  assert.deepEqual(JSON.parse(stdout), {
    args: ["/workspace/tools/input.txt", "--unused"],
    command: "tool-inspect",
    cwd: "/workspace/tools",
    env: { BROWSER_TOOL_MODE: "unit" },
    stdin: "stdin payload\n",
    workspace: {
      bytes: 10,
      path: "/workspace/tools/input.txt",
      text: "tool file\n",
    },
  });
  assert.equal(stderr, "browser-tool-fixture: inspected workspace\n");
  assert.equal(port.messages.at(-1).type, "command.complete");
  assert.equal(port.messages.at(-1).result.exitCode, 0);
  const loadMessage = port.messages.find(
    (message) => message.id === "load-tool-fixture",
  );
  assert(loadMessage);
  assert.equal(loadMessage.artifactKind, "webc-package");
  assert.equal(loadMessage.entrypoint, "tool-inspect");
  assert.equal(loadMessage.packageType, "browser-tool-fixture");
  assert.equal(loadMessage.cache.backend, "indexeddb");
  assert.match(loadMessage.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(stdout.includes("SECRET_SHOULD_NOT_ECHO"), false);
  assert.equal(stdout.includes("nope"), false);
});

test("BrowserCommandWorkerRuntime rejects browser tool fixtures without workspace stores", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
    workspaceStore: null,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-tool-fixture",
    package: {
      commands: ["tool-inspect"],
      id: "tool-fixture",
      type: "browser-tool-fixture",
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-tool-fixture",
    packageId: "tool-fixture",
    command: "tool-inspect",
  });

  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "run-tool-fixture",
    error: {
      kind: "unsupported_package",
      message: "browser tool fixture requires a workspace store",
      stage: "startup",
    },
    result: {
      cancelled: false,
      exitCode: null,
      failureStage: "startup",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
});

test("BrowserCommandWorkerRuntime rejects unsupported browser tool fixture commands", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
    workspaceStore: createMemoryBrowserWorkspaceStore(),
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-tool-fixture",
    package: {
      commands: ["other-tool"],
      id: "tool-fixture",
      type: "browser-tool-fixture",
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-tool-fixture",
    packageId: "tool-fixture",
    command: "other-tool",
  });

  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "run-tool-fixture",
    error: {
      kind: "command_not_found",
      message: "unsupported browser tool fixture command: other-tool",
      stage: "command_resolution",
    },
    result: {
      cancelled: false,
      exitCode: 127,
      failureStage: "command_resolution",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
});

test("BrowserCommandWorkerRuntime reports missing browser tool fixture workspace files", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
    workspaceStore: createMemoryBrowserWorkspaceStore(),
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-tool-fixture",
    package: {
      commands: ["tool-inspect"],
      id: "tool-fixture",
      type: "browser-tool-fixture",
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-tool-fixture",
    packageId: "tool-fixture",
    command: "tool-inspect",
    args: ["/workspace/tools/missing.txt"],
  });

  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "run-tool-fixture",
    error: {
      kind: "not_found",
      message:
        "browser tool fixture workspace read failed: workspace file is unavailable",
      stage: "workspace",
    },
    result: {
      cancelled: false,
      exitCode: 1,
      failureStage: "workspace",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
});

test("BrowserCommandWorkerRuntime runs HTTP smoke URL from env", async () => {
  const port = recordingPort();
  const seen = {};
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: recordingHttpTransport("direct", seen) },
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-http-smoke-env",
    package: {
      id: "http-smoke-env",
      type: "http-smoke",
      commands: ["http-smoke"],
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-http-smoke-env",
    packageId: "http-smoke-env",
    command: "http-smoke",
    env: {
      WASM_HOST_HTTP_SMOKE_URL: "https://example.test/from-env",
    },
  });

  assert.equal(seen.url, "https://example.test/from-env");
  assert.equal(port.messages.at(-1).type, "command.complete");
});

test("BrowserCommandWorkerRuntime reports missing HTTP smoke URLs", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: recordingHttpTransport("direct", {}) },
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-http-smoke-missing-url",
    package: {
      id: "http-smoke-missing-url",
      type: "http-smoke",
      commands: ["http-smoke"],
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-http-smoke-missing-url",
    packageId: "http-smoke-missing-url",
    command: "http-smoke",
  });

  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "run-http-smoke-missing-url",
    error: {
      kind: "invalid_request",
      message: "browser HTTP smoke URL is required",
      stage: "runtime",
    },
    result: {
      cancelled: false,
      exitCode: null,
      failureStage: "runtime",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
});

test("BrowserCommandWorkerRuntime reports HTTP smoke status failures", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: {
      direct: {
        async dispatch(_request, writer) {
          await writer.finish(503, [], "unavailable");
        },
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-http-smoke-fail",
    package: {
      id: "http-smoke",
      type: "http-smoke",
      commands: ["http-smoke"],
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-http-smoke-fail",
    packageId: "http-smoke",
    command: "http-smoke",
    args: ["https://example.test/fail"],
  });

  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "run-http-smoke-fail",
    error: {
      kind: "transport",
      message: "browser HTTP smoke request failed with status 503",
      stage: "runtime",
    },
    result: {
      cancelled: false,
      exitCode: 1,
      failureStage: "runtime",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
});

test("BrowserCommandWorkerRuntime times out HTTP bridge dispatches", async () => {
  const port = recordingPort();
  let transportSignal = null;
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: {
      direct: {
        async dispatch(_request, _writer, signal) {
          transportSignal = signal;
          await rejectOnAbort(signal);
        },
      },
    },
    executors: {
      http: {
        async run(request, output) {
          try {
            await request.httpBridge.dispatch({
              method: "GET",
              timeoutMs: 5,
              url: "https://example.test/slow",
            });
          } catch (error) {
            await output.writeStdout(`${error.kind}:${error.message}`);
          }
          return { exitCode: 0 };
        },
      },
    },
  });

  await loadHttpPackage(runtime);
  await runtime.handleMessage({
    type: "command.run",
    id: "http-timeout-run",
    packageId: "http-pkg",
    command: "http",
  });

  assert.equal(transportSignal.aborted, true);
  assert.equal(
    chunksText(stdoutChunks(port.messages, "http-timeout-run")),
    "timeout:HTTP request exceeded wall time limit",
  );
  assert.equal(port.messages.at(-1).type, "command.complete");
});

test("BrowserCommandWorkerRuntime cancels in-flight HTTP bridge dispatches", async () => {
  const port = recordingPort();
  const dispatchStarted = deferred();
  let transportSignal = null;
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: {
      direct: {
        async dispatch(_request, _writer, signal) {
          transportSignal = signal;
          dispatchStarted.resolve();
          await rejectOnAbort(signal);
        },
      },
    },
    executors: {
      http: {
        async run(request) {
          await request.httpBridge.dispatch({
            method: "GET",
            url: "https://example.test/cancel",
          });
          return { exitCode: 0 };
        },
      },
    },
  });

  await loadHttpPackage(runtime);
  const run = runtime.handleMessage({
    type: "command.run",
    id: "http-cancel-run",
    packageId: "http-pkg",
    command: "http",
  });
  await dispatchStarted.promise;
  await runtime.handleMessage({ type: "command.cancel", id: "http-cancel-run" });
  await run;

  assert.equal(transportSignal.aborted, true);
  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "http-cancel-run",
    error: {
      kind: "cancelled",
      message: "browser command cancelled",
      stage: "runtime",
    },
    result: {
      cancelled: true,
      exitCode: 130,
      failureStage: "runtime",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
});

test("BrowserCommandWorkerRuntime closes stdout and stderr before final status", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: {} },
    executors: {
      test: async (_request, output) => {
        await output.writeStdout("one");
        await output.writeStderr("two");
        return { exitCode: 0 };
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    package: { id: "pkg", type: "test", commands: ["run"] },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "close-run",
    packageId: "pkg",
    command: "run",
  });

  assert.deepEqual(
    port.messages
      .filter((message) => message.id === "close-run")
      .map((message) => message.type),
    [
      "command.started",
      "command.stdout",
      "command.stderr",
      "command.stdout.close",
      "command.stderr.close",
      "command.complete",
    ],
  );
});

test("BrowserCommandWorkerRuntime forwards terminal resize to the active run", async () => {
  const port = recordingPort();
  let terminal = null;
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: {} },
    executors: {
      test: async (request) => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (request.terminal.columns != null) {
            break;
          }
          await tick();
        }
        terminal = { ...request.terminal };
        return { exitCode: 0 };
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    package: { id: "pkg", type: "test", commands: ["resize"] },
  });
  const run = runtime.handleMessage({
    type: "command.run",
    id: "resize-run",
    packageId: "pkg",
    command: "resize",
  });
  await tick();
  await runtime.handleMessage({
    type: "command.terminal.resize",
    id: "resize-run",
    columns: 120,
    rows: 40,
  });
  await run;

  assert.deepEqual(terminal, { columns: 120, rows: 40 });
});

test("BrowserCommandWorkerRuntime seeds terminal dimensions from command run", async () => {
  const port = recordingPort();
  let terminal = null;
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: {} },
    executors: {
      test: async (request) => {
        terminal = { ...request.terminal };
        return { exitCode: 0 };
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    package: { id: "pkg", type: "test", commands: ["resize"] },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "initial-size-run",
    packageId: "pkg",
    command: "resize",
    terminal: { columns: 100, rows: 32 },
  });

  assert.deepEqual(terminal, { columns: 100, rows: 32 });
});

test("BrowserCommandWorkerRuntime reports startup failures", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: {} },
  });

  await runtime.handleMessage({
    type: "command.run",
    id: "missing-package",
    packageId: "missing",
    command: "smoke",
  });

  assert.deepEqual(port.messages, [
    {
      type: "command.stdout.close",
      id: "missing-package",
    },
    {
      type: "command.stderr.close",
      id: "missing-package",
    },
    {
      type: "command.error",
      id: "missing-package",
      error: {
        kind: "invalid_request",
        message: "browser command package is not loaded: missing",
        stage: "package_load",
      },
      result: {
        cancelled: false,
        exitCode: null,
        failureStage: "package_load",
        stderrBytes: 0,
        stdoutBytes: 0,
        timedOut: false,
      },
    },
  ]);
});

test("BrowserCommandWorkerRuntime reports malformed run messages", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: {} },
  });

  await runtime.handleMessage({
    type: "command.run",
    id: "malformed-run",
    packageId: "pkg",
  });

  assert.deepEqual(port.messages, [
    {
      type: "command.error",
      id: "malformed-run",
      error: {
        kind: "invalid_request",
        message: "browser command fields must be non-empty strings",
        stage: "startup",
      },
      result: {
        cancelled: false,
        exitCode: null,
        failureStage: "startup",
        stderrBytes: 0,
        stdoutBytes: 0,
        timedOut: false,
      },
    },
  ]);
});

test("BrowserCommandWorkerRuntime cancels runs waiting for package load", async () => {
  const port = recordingPort();
  const load = deferred();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    packageLoader: { load: async () => load.promise },
    port,
  });

  const loadTask = runtime.handleMessage({
    type: "command.load",
    id: "load-slow",
    package: {
      bytes: new Uint8Array([0]),
      command: "smoke",
      executorType: "smoke",
      id: "slow-pkg",
    },
  });
  await tick();
  const run = runtime.handleMessage({
    type: "command.run",
    id: "run-before-load",
    packageId: "slow-pkg",
    command: "smoke",
  });
  await tick();
  await runtime.handleMessage({
    type: "command.cancel",
    id: "run-before-load",
  });
  await run;
  load.resolve(packageRecord("slow-pkg"));
  await loadTask;

  assert.deepEqual(port.messages.find((message) => message.id === "run-before-load" && message.type === "command.error"), {
    type: "command.error",
    id: "run-before-load",
    error: {
      kind: "cancelled",
      message: "browser command cancelled",
      stage: "runtime",
    },
    result: {
      cancelled: true,
      exitCode: 130,
      failureStage: "runtime",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
  assert.equal(
    port.messages.some((message) => message.id === "run-before-load" && message.type === "command.started"),
    false,
  );
});

test("BrowserCommandWorkerRuntime rejects duplicate runs while package load is pending", async () => {
  const port = recordingPort();
  const load = deferred();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    packageLoader: { load: async () => load.promise },
    port,
  });

  const loadTask = runtime.handleMessage({
    type: "command.load",
    id: "load-pending",
    package: {
      bytes: new Uint8Array([0]),
      command: "smoke",
      executorType: "smoke",
      id: "pending-pkg",
    },
  });
  await tick();
  const firstRun = runtime.handleMessage({
    type: "command.run",
    id: "pending-run-a",
    packageId: "pending-pkg",
    command: "smoke",
  });
  await tick();
  await runtime.handleMessage({
    type: "command.run",
    id: "pending-run-b",
    packageId: "pending-pkg",
    command: "smoke",
  });
  load.resolve(packageRecord("pending-pkg"));
  await loadTask;
  await firstRun;

  assert.deepEqual(port.messages.find((message) => message.id === "pending-run-b"), {
    type: "command.error",
    id: "pending-run-b",
    error: {
      kind: "invalid_request",
      message: "another browser command is already running",
      stage: "startup",
    },
    result: {
      cancelled: false,
      exitCode: null,
      failureStage: "startup",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
  assert.equal(
    port.messages.filter((message) => message.type === "command.started").length,
    1,
  );
});

test("BrowserCommandWorkerRuntime rejects duplicate package loads", async () => {
  const port = recordingPort();
  const load = deferred();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    packageLoader: { load: async () => load.promise },
    port,
  });

  const firstLoad = runtime.handleMessage({
    type: "command.load",
    id: "load-a",
    package: {
      bytes: new Uint8Array([0]),
      command: "smoke",
      executorType: "smoke",
      id: "same-pkg",
    },
  });
  await tick();
  await runtime.handleMessage({
    type: "command.load",
    id: "load-b",
    package: {
      bytes: new Uint8Array([1]),
      command: "smoke",
      executorType: "smoke",
      id: "same-pkg",
    },
  });
  load.resolve(packageRecord("same-pkg"));
  await firstLoad;

  assert.deepEqual(port.messages.find((message) => message.id === "load-b"), {
    type: "command.error",
    id: "load-b",
    error: {
      kind: "invalid_request",
      message: "browser command package is already loading: same-pkg",
      stage: "package_load",
    },
    result: {
      cancelled: false,
      exitCode: null,
      failureStage: "package_load",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
  assert.equal(port.messages.filter((message) => message.type === "command.loaded").length, 1);
});

test("BrowserCommandWorkerRuntime maps smoke command resolution failures", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: {} },
  });

  await runtime.handleMessage({
    type: "command.load",
    package: { id: "smoke", type: "smoke", commands: ["smoke"] },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "missing-command",
    packageId: "smoke",
    command: "missing",
  });

  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "missing-command",
    error: {
      kind: "command_not_found",
      message: "browser command not found: missing",
      stage: "command_resolution",
    },
    result: {
      cancelled: false,
      exitCode: 127,
      failureStage: "command_resolution",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
});

test("BrowserCommandWorkerRuntime cancels active commands", async () => {
  const port = recordingPort();
  const runtime = runtimeWithAbortableExecutor(port);

  await loadBlockingPackage(runtime);
  const run = runtime.handleMessage({
    type: "command.run",
    id: "cancel-run",
    packageId: "pkg",
    command: "block",
  });
  await tick();
  await runtime.handleMessage({ type: "command.cancel", id: "cancel-run" });
  await run;

  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "cancel-run",
    error: {
      kind: "cancelled",
      message: "browser command cancelled",
      stage: "runtime",
    },
    result: {
      cancelled: true,
      exitCode: 130,
      failureStage: "runtime",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
  assert.equal(runtime.activeRun, null);
});

test("BrowserCommandWorkerRuntime rejects success after cancellation", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: {} },
    executors: {
      late: {
        async run() {
          await delay(5);
          return { exitCode: 0 };
        },
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    package: { id: "pkg", type: "late", commands: ["late"] },
  });
  const run = runtime.handleMessage({
    type: "command.run",
    id: "late-run",
    packageId: "pkg",
    command: "late",
  });
  await tick();
  await runtime.handleMessage({ type: "command.cancel", id: "late-run" });
  await run;

  assert.equal(port.messages.at(-1).type, "command.error");
  assert.equal(port.messages.at(-1).error.kind, "cancelled");
});

test("BrowserCommandWorkerRuntime times out active commands", async () => {
  const port = recordingPort();
  const runtime = runtimeWithAbortableExecutor(port);

  await loadBlockingPackage(runtime);
  await runtime.handleMessage({
    type: "command.run",
    id: "timeout-run",
    packageId: "pkg",
    command: "block",
    timeoutMs: 5,
  });

  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "timeout-run",
    error: {
      kind: "timeout",
      message: "browser command exceeded wall time limit",
      stage: "runtime",
    },
    result: {
      cancelled: false,
      exitCode: 124,
      failureStage: "runtime",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: true,
    },
  });
});

test("BrowserCommandWorkerRuntime times out non-cooperative commands", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: {} },
    executors: {
      hanging: {
        async run() {
          await new Promise(() => {});
        },
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    package: { id: "pkg", type: "hanging", commands: ["hang"] },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "hang-run",
    packageId: "pkg",
    command: "hang",
    timeoutMs: 5,
  });

  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "hang-run",
    error: {
      kind: "timeout",
      message: "browser command exceeded wall time limit",
      stage: "runtime",
    },
    result: {
      cancelled: false,
      exitCode: 124,
      failureStage: "runtime",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: true,
    },
  });
  assert.equal(runtime.activeRun, null);
});

test("BrowserCommandWorkerRuntime keeps timeout reason for plain AbortError", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: {} },
    executors: {
      aborting: {
        async run(request) {
          await rejectAbortErrorOnAbort(request.signal);
        },
      },
    },
  });

  await runtime.handleMessage({
    type: "command.load",
    package: { id: "pkg", type: "aborting", commands: ["abort"] },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "abort-timeout-run",
    packageId: "pkg",
    command: "abort",
    timeoutMs: 5,
  });

  assert.equal(port.messages.at(-1).error.kind, "timeout");
  assert.equal(port.messages.at(-1).result.exitCode, 124);
  assert.equal(port.messages.at(-1).result.timedOut, true);
});

test("BrowserCommandWorkerRuntime rejects duplicate active runs", async () => {
  const port = recordingPort();
  const runtime = runtimeWithAbortableExecutor(port);

  await loadBlockingPackage(runtime);
  const first = runtime.handleMessage({
    type: "command.run",
    id: "run-a",
    packageId: "pkg",
    command: "block",
  });
  await tick();
  await runtime.handleMessage({
    type: "command.run",
    id: "run-b",
    packageId: "pkg",
    command: "block",
  });
  await runtime.handleMessage({ type: "command.cancel", id: "run-a" });
  await first;

  assert.deepEqual(port.messages.find((message) => message.id === "run-b"), {
    type: "command.error",
    id: "run-b",
    error: {
      kind: "invalid_request",
      message: "another browser command is already running",
      stage: "startup",
    },
    result: {
      cancelled: false,
      exitCode: null,
      failureStage: "startup",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  });
});

test("BrowserCommandWorkerRuntime can attach to a worker-style port", async () => {
  const port = eventPort();
  const runtime = new BrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: {} },
  });

  runtime.start();
  port.emit({
    type: "command.load",
    package: { id: "smoke", type: "smoke", commands: ["smoke"] },
  });
  port.emit({
    type: "command.run",
    id: "smoke-run",
    packageId: "smoke",
    command: "smoke",
  });
  await tick();
  runtime.stop();

  assert.equal(port.started, true);
  assert.equal(port.listenerCount(), 0);
  assert.equal(chunksText(stdoutChunks(port.messages, "smoke-run")), "BROWSER_SMOKE_OK\n");
  assert.equal(port.messages.at(-1).type, "command.complete");
});

function runtimeWithAbortableExecutor(port) {
  return createBrowserCommandWorkerRuntime({
    port,
    httpTransports: { direct: {} },
    executors: {
      blocking: {
        async run(request) {
          await rejectOnAbort(request.signal);
        },
      },
    },
  });
}

function loadBlockingPackage(runtime) {
  return runtime.handleMessage({
    type: "command.load",
    package: { id: "pkg", type: "blocking", commands: ["block"] },
  });
}

function loadHttpPackage(runtime) {
  return runtime.handleMessage({
    type: "command.load",
    package: { id: "http-pkg", type: "http", commands: ["http"] },
  });
}

function recordingHttpTransport(name, seen) {
  return {
    async dispatch(request, writer, signal) {
      seen.body = chunksText(await requestBodyChunks(request.body));
      seen.headers = request.headers;
      seen.method = request.method;
      seen.name = name;
      seen.signalAborted = signal.aborted;
      seen.url = request.url;
      await writer.writeBodyChunk("hello ");
      await writer.finish(202, [{ name: "X-Bridge", value: " ok " }], "world");
    },
  };
}

async function requestBodyChunks(body) {
  if (body == null) {
    return [];
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of body) {
      chunks.push(chunk);
    }
    return chunks;
  }
  return Array.isArray(body) ? body : [body];
}

function packageRecord(id) {
  return {
    artifactKind: "webc-package",
    byteLength: 5,
    cache: { backend: "memory", modulePath: "module", packagePath: "package" },
    cacheKeys: {},
    commands: ["smoke"],
    contentSha256: "a".repeat(64),
    defaultCommand: "smoke",
    entrypoint: "smoke",
    executorType: "smoke",
    format: "webc",
    id,
    metadata: {},
    sha256: "a".repeat(64),
    source: { kind: "bytes", label: "test" },
  };
}

function webcBytes(suffix) {
  const payload = encoder.encode(suffix);
  const bytes = new Uint8Array(5 + payload.byteLength);
  bytes.set([0x00, 0x77, 0x65, 0x62, 0x63]);
  bytes.set(payload, 5);
  return bytes;
}

function executableWebcBytes() {
  return webcV2Bytes(webcWasiCommandManifest(), {
    atoms: {
      "codex-atom": CODEX_VERSION_SMOKE_WASM,
    },
    volumes: {},
  });
}

function executableWebcVolumeBytes() {
  const manifest = webcWasiCommandManifest({
    atom: "cat-volume-atom",
    command: "cat-volume",
    execName: "cat-volume",
  });
  manifest.package.fs = [
    {
      host_path: "rootfs",
      mount_path: "/",
      volume_name: "/rootfs",
    },
  ];
  return webcV2Bytes(manifest, {
    atoms: {
      "cat-volume-atom": WEBC_VOLUME_READ_WASM,
    },
    volumes: {
      "/rootfs": {
        rootfs: {
          etc: {
            "message.txt": "from-volume\n",
          },
        },
      },
    },
  });
}

function webcPackageForRun(metadata) {
  return {
    artifactKind: "webc-package",
    commands: Object.keys(metadata.commandMetadata ?? {}),
    id: "codex-webc",
    metadata: {
      packageName: "codex/browser-smoke",
      ...metadata,
    },
    type: "webc-package",
  };
}

function catalogEntry(path, packageId, command) {
  return (entry) =>
    entry.path === path &&
    entry.packageId === packageId &&
    entry.command === command;
}

function childResultSummary(result) {
  return {
    command: result.command,
    exitCode: result.exitCode,
    packageId: result.packageId,
    stderr: decoder.decode(result.stderr),
    stderrBytes: result.stderrBytes,
    stdout: decoder.decode(result.stdout),
    stdoutBytes: result.stdoutBytes,
  };
}

function base64ToBytes(value) {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

function recordingPort() {
  return {
    messages: [],
    postMessage(message) {
      this.messages.push(message);
    },
  };
}

function eventPort() {
  const listeners = new Set();
  return {
    messages: [],
    started: false,
    addEventListener(type, listener) {
      if (type === "message") {
        listeners.add(listener);
      }
    },
    removeEventListener(type, listener) {
      if (type === "message") {
        listeners.delete(listener);
      }
    },
    postMessage(message) {
      this.messages.push(message);
    },
    start() {
      this.started = true;
    },
    emit(data) {
      for (const listener of listeners) {
        listener({ data });
      }
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

function rejectOnAbort(signal) {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () =>
      reject(
        signal.reason ??
          new BrowserCommandWorkerError(
            "cancelled",
            "browser command cancelled",
            "runtime",
            { cancelled: true, exitCode: 130 },
          ),
      );
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

function rejectAbortErrorOnAbort(signal) {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () => reject(new DOMException("aborted", "AbortError"));
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

function stdoutChunks(messages, id) {
  return messages
    .filter((message) => message.type === "command.stdout" && message.id === id)
    .map((message) => message.chunk);
}

function stderrChunks(messages, id) {
  return messages
    .filter((message) => message.type === "command.stderr" && message.id === id)
    .map((message) => message.chunk);
}

function chunksText(chunks) {
  return decoder.decode(concatChunks(chunks));
}

async function asyncChunksText(chunks) {
  const result = [];
  for await (const chunk of chunks) {
    result.push(chunk);
  }
  return chunksText(result);
}

function concatChunks(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
