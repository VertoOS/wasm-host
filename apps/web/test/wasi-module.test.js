import assert from "node:assert/strict";
import test from "node:test";
import { Worker as NodeWorker } from "node:worker_threads";

import {
  hasLocalCodexVersionSmokeArtifact,
  readLocalCodexVersionSmokeArtifact,
} from "../fixtures/codex-version-smoke-fixture.js";
import {
  fetchCodexArtifactBytes,
  parseArtifactManifestJson,
} from "../src/artifact-manifest.js";
import { createBrowserCommandWorkerRuntime } from "../src/command-worker.js";
import {
  createRawWasiModuleExecutor,
  createRawWasiModuleWorkerExecutor,
  loadRawWasiModulePackage,
} from "../src/wasi-module.js";

const decoder = new TextDecoder();

const ARGV_ECHO_WASM = base64ToBytes(
  "AGFzbQEAAAABFgRgAn9/AX9gBH9/f38Bf2ABfwBgAAAC4AEGFndhc2lfc25hcHNob3RfcHJldmlldzEOYXJnc19zaXplc19nZXQAABZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCGFyZ3NfZ2V0AAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MRFlbnZpcm9uX3NpemVzX2dldAAAFndhc2lfc25hcHNob3RfcHJldmlldzELZW52aXJvbl9nZXQAABZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCGZkX3dyaXRlAAEWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQlwcm9jX2V4aXQAAgMCAQMFAwEAAQcTAgZtZW1vcnkCAAZfc3RhcnQABgpEAUIAQQBBBBAAGkEIQQwQAhpBwABBgAIQARpB4ABBgAQQAxpBgAFBxAAoAgA2AgBBhAFBCTYCAEEBQYABQQFBEBAEGgs=",
);

const STDERR_EXIT_WASM = base64ToBytes(
  "AGFzbQEAAAABEANgBH9/f38Bf2ABfwBgAAACRgIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAEDAgECBQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAIKFAESAEECQcAAQQFBEBAAGkEHEAELCxkCAEGAAgsEYmFkCgBBwAALCAABAAAEAAAA",
);

const MISSING_MEMORY_WASM = base64ToBytes(
  "AGFzbQEAAAABBAFgAAADAgEABwoBBl9zdGFydAAACgQBAgAL",
);

const UNSUPPORTED_IMPORT_WASM = base64ToBytes(
  "AGFzbQEAAAABDAJgBH9/f38Bf2AAAAIiARZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxB2ZkX3JlYWQAAAMCAQEFAwEAAQcTAgZtZW1vcnkCAAZfc3RhcnQAAQoEAQIACw==",
);

const NON_COOPERATIVE_LOOP_WASM = base64ToBytes(
  "AGFzbQEAAAABBAFgAAADAgEABQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAAKCQEHAANADAALCw==",
);

test("loadRawWasiModulePackage validates explicit raw WASI module bytes", async () => {
  const expectedSha256 = await sha256Hex(ARGV_ECHO_WASM);
  const record = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: ARGV_ECHO_WASM,
    command: "codex",
    expectedSha256,
    id: "codex",
    metadata: { fixture: "argv-echo" },
  });

  assert.equal(record.id, "codex");
  assert.equal(record.artifactKind, "wasi-module");
  assert.equal(record.type, "wasi-module");
  assert.equal(record.entrypoint, "_start");
  assert.deepEqual(record.commands, ["codex"]);
  assert.equal(record.byteLength, ARGV_ECHO_WASM.byteLength);
  assert.equal(record.contentSha256, expectedSha256);
  assert.equal(record.metadata.fixture, "argv-echo");
  assert.equal(record.metadata.wasi, "preview1");
});

test("loadRawWasiModulePackage rejects invalid bytes and sha mismatches", async () => {
  await assert.rejects(
    loadRawWasiModulePackage({
      artifactKind: "wasi-module",
      bytes: new Uint8Array([1, 2, 3]),
      command: "codex",
    }),
    (error) => {
      assert.equal(error.kind, "invalid_package");
      assert.equal(error.stage, "package_load");
      assert.match(error.message, /Wasm magic/);
      return true;
    },
  );

  await assert.rejects(
    loadRawWasiModulePackage({
      artifactKind: "wasi-module",
      bytes: ARGV_ECHO_WASM,
      command: "codex",
      expectedSha256: "0".repeat(64),
    }),
    (error) => {
      assert.equal(error.kind, "invalid_package");
      assert.match(error.message, /^raw WASI module sha256 mismatch:/);
      return true;
    },
  );
});

test("command worker loads and runs a raw WASI module fixture", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-codex",
    package: {
      artifactKind: "wasi-module",
      command: "codex",
      id: "codex",
      wasiModule: {
        bytes: ARGV_ECHO_WASM,
      },
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-codex",
    packageId: "codex",
    command: "codex",
    args: ["--version"],
  });

  const loaded = port.messages.find((message) => message.type === "command.loaded");
  assert.equal(loaded.artifactKind, "wasi-module");
  assert.equal(loaded.packageType, "wasi-module");
  assert.match(loaded.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(stdoutText(port.messages), "--version");
  assert.equal(stderrText(port.messages), "");
  assert.deepEqual(port.messages.at(-1), {
    type: "command.complete",
    id: "run-codex",
    result: {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 9,
      timedOut: false,
    },
  });
});

test("raw WASI executor captures stderr and proc_exit status", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleExecutor();
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: STDERR_EXIT_WASM,
    command: "codex",
    id: "codex",
  });

  const result = await executor.run(
    {
      args: [],
      command: "codex",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 7 });
  assert.equal(output.stdout, "");
  assert.equal(output.stderr, "bad\n");
});

test("raw WASI worker executor forwards output and exit status", async () => {
  const output = recordingOutput();
  const executor = createRawWasiModuleWorkerExecutor({
    createWorker: createNodeWasiWorker,
  });
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: ARGV_ECHO_WASM,
    command: "codex",
    id: "codex",
  });

  const result = await executor.run(
    {
      args: ["--version"],
      command: "codex",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    output,
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(output.stdout, "--version");
  assert.equal(output.stderr, "");
  assert.equal(packageRecord.bytes.byteLength, ARGV_ECHO_WASM.byteLength);

  const secondOutput = recordingOutput();
  const secondResult = await executor.run(
    {
      args: ["again-run"],
      command: "codex",
      env: {},
      package: packageRecord,
      signal: new AbortController().signal,
    },
    secondOutput,
  );
  assert.deepEqual(secondResult, { exitCode: 0 });
  assert.equal(secondOutput.stdout, "again-run");
});

test("raw WASI executor reports command resolution failures", async () => {
  const executor = createRawWasiModuleExecutor();
  const packageRecord = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: ARGV_ECHO_WASM,
    command: "codex",
    id: "codex",
  });

  await assert.rejects(
    executor.run(
      {
        args: [],
        command: "other",
        env: {},
        package: packageRecord,
        signal: new AbortController().signal,
      },
      recordingOutput(),
    ),
    (error) => {
      assert.equal(error.kind, "command_not_found");
      assert.equal(error.stage, "command_resolution");
      assert.equal(error.exitCode, 127);
      return true;
    },
  );
});

test("raw WASI executor reports invalid modules and unsupported imports", async () => {
  const executor = createRawWasiModuleExecutor();
  const missingMemory = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: MISSING_MEMORY_WASM,
    command: "codex",
    id: "codex",
  });
  const unsupportedImport = await loadRawWasiModulePackage({
    artifactKind: "wasi-module",
    bytes: UNSUPPORTED_IMPORT_WASM,
    command: "codex",
    id: "codex",
  });

  await assert.rejects(
    executor.run(baseRunRequest(missingMemory), recordingOutput()),
    (error) => {
      assert.equal(error.kind, "invalid_package");
      assert.equal(error.stage, "package_load");
      assert.match(error.message, /export memory/);
      return true;
    },
  );

  await assert.rejects(
    executor.run(baseRunRequest(unsupportedImport), recordingOutput()),
    (error) => {
      assert.equal(error.kind, "runtime");
      assert.match(error.message, /fd_read/);
      return true;
    },
  );
});

test("command worker times out non-cooperative raw WASI modules", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
    wasiModule: { createWorker: createNodeWasiWorker },
  });

  await loadLoopPackage(runtime);
  const run = runtime.handleMessage({
    type: "command.run",
    id: "timeout-loop",
    packageId: "loop",
    command: "loop",
    timeoutMs: 50,
  });
  await withTimeout(run, 1000, "raw WASI timeout run did not finish");

  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "timeout-loop",
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

test("command worker cancels non-cooperative raw WASI modules", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
    wasiModule: { createWorker: createNodeWasiWorker },
  });

  await loadLoopPackage(runtime);
  const run = runtime.handleMessage({
    type: "command.run",
    id: "cancel-loop",
    packageId: "loop",
    command: "loop",
  });
  await waitForMessage(
    port.messages,
    (message) => message.type === "command.started" && message.id === "cancel-loop",
  );
  await runtime.handleMessage({ type: "command.cancel", id: "cancel-loop" });
  await withTimeout(run, 1000, "raw WASI cancel run did not finish");

  assert.deepEqual(port.messages.at(-1), {
    type: "command.error",
    id: "cancel-loop",
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

test(
  "local Codex version-smoke artifact runs through the browser WASI executor",
  {
    skip:
      !hasLocalCodexVersionSmokeArtifact()
        ? "local Codex WASI artifact is not available"
        : false,
  },
  async () => {
    const { bytes: artifactBytes, manifestText } =
      await readLocalCodexVersionSmokeArtifact();
    const manifest = parseArtifactManifestJson(
      manifestText,
    );
    const { fixture } = await fetchCodexArtifactBytes(manifest, {
      fetchImpl: async () =>
        new Response(artifactBytes, {
          headers: { "Content-Length": String(artifactBytes.byteLength) },
          status: 200,
        }),
    });
    const port = recordingPort();
    const runtime = createBrowserCommandWorkerRuntime({
      httpTransports: { direct: {} },
      port,
    });

    await runtime.handleMessage(fixture.commandLoad);
    await runtime.handleMessage(fixture.commandRun);

    assert.equal(port.messages.at(-1).type, "command.complete");
    assert.equal(port.messages.at(-1).result.exitCode, fixture.expected.exitCode);
    assert.match(stdoutText(port.messages), /^codex-cli /);
    assert.equal(stderrText(port.messages), fixture.expected.stderr);
  },
);

function recordingPort() {
  const messages = [];
  return {
    messages,
    postMessage(message) {
      messages.push(message);
    },
  };
}

function loadLoopPackage(runtime) {
  return runtime.handleMessage({
    type: "command.load",
    id: "load-loop",
    package: {
      artifactKind: "wasi-module",
      command: "loop",
      id: "loop",
      wasiModule: {
        bytes: NON_COOPERATIVE_LOOP_WASM,
      },
    },
  });
}

function baseRunRequest(packageRecord) {
  return {
    args: [],
    command: "codex",
    env: {},
    package: packageRecord,
    signal: new AbortController().signal,
  };
}

function createNodeWasiWorker() {
  const worker = new NodeWorker(
    new URL("../fixtures/wasi-module-node-worker-entry.js", import.meta.url),
  );
  const listeners = new Map();
  return {
    postMessage(message) {
      worker.postMessage(message);
    },
    terminate() {
      return worker.terminate();
    },
    addEventListener(type, listener) {
      const eventName = workerEventName(type);
      const wrapped =
        type === "message" ? (data) => listener({ data }) : (error) => listener(error);
      listeners.set(listener, { eventName, wrapped });
      worker.on(eventName, wrapped);
    },
    removeEventListener(_type, listener) {
      const record = listeners.get(listener);
      if (!record) {
        return;
      }
      listeners.delete(listener);
      worker.off(record.eventName, record.wrapped);
    },
  };
}

function workerEventName(type) {
  return type === "message" ? "message" : type;
}

async function waitForMessage(messages, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const message = messages.find(predicate);
    if (message) {
      return message;
    }
    await delay(5);
  }
  throw new Error(`timed out waiting for message: ${JSON.stringify(messages)}`);
}

function withTimeout(promise, timeoutMs, message) {
  let timeout = null;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordingOutput() {
  return {
    stderr: "",
    stdout: "",
    async writeStderr(chunk) {
      this.stderr += decoder.decode(chunk);
    },
    async writeStdout(chunk) {
      this.stdout += decoder.decode(chunk);
    },
  };
}

function stdoutText(messages) {
  return chunksText(messages, "command.stdout");
}

function stderrText(messages) {
  return chunksText(messages, "command.stderr");
}

function chunksText(messages, type) {
  return decoder.decode(
    concatBytes(
      messages
        .filter((message) => message.type === type)
        .map((message) => message.chunk),
    ),
  );
}

function concatBytes(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function base64ToBytes(value) {
  return new Uint8Array(Buffer.from(value, "base64"));
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
