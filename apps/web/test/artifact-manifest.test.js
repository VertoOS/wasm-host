import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserCommandWorkerRuntime } from "../src/command-worker.js";
import {
  fetchCodexArtifactBytes,
  normalizeCodexBrowserRunFixture,
  parseArtifactManifestJson,
  validateCodexArtifactManifest,
  verifyCodexArtifactBytes,
} from "../src/artifact-manifest.js";

const encoder = new TextEncoder();

test("parseArtifactManifestJson parses valid JSON and reports malformed input", () => {
  assert.deepEqual(parseArtifactManifestJson('{"schemaVersion":1}'), {
    schemaVersion: 1,
  });

  assert.throws(
    () => parseArtifactManifestJson("{"),
    (error) => {
      assert.equal(error.name, "ArtifactManifestError");
      assert.equal(error.kind, "invalid_manifest");
      assert.equal(error.stage, "artifact_manifest");
      assert.match(error.message, /JSON is invalid/);
      return true;
    },
  );
});

test("normalizeCodexBrowserRunFixture validates and shapes the Codex smoke manifest", () => {
  const fixture = normalizeCodexBrowserRunFixture(
    validManifest({ artifactSha256: "A".repeat(64) }),
  );

  assert.deepEqual(fixture, {
    type: "codex-browser-run-fixture",
    id: "codex-version-smoke",
    artifact: {
      kind: "wasi-module",
      path: "codex-wasix/dist/codex-version-smoke.wasm",
      sha256: "a".repeat(64),
      sizeBytes: 69_547,
    },
    commandLoad: {
      type: "command.load",
      id: "load-codex",
      package: {
        artifactKind: "wasi-module",
        commands: ["codex"],
        defaultCommand: "codex",
        entrypoint: "_start",
        executorType: "wasi-module",
        id: "codex",
        metadata: {
          artifactKind: "wasi-module",
          artifactPath: "codex-wasix/dist/codex-version-smoke.wasm",
          artifactSha256: "a".repeat(64),
          artifactSizeBytes: 69_547,
          command: "codex",
          entrypoint: "_start",
          expectedExitCode: 0,
          expectedStderr: "",
          packageName: "codex",
          schemaVersion: 1,
          stdoutPrefix: "codex-cli ",
          wasi: "preview1",
        },
        type: "wasi-module",
      },
    },
    commandRun: {
      type: "command.run",
      id: "run-codex-version",
      packageId: "codex",
      command: "codex",
      args: ["--version"],
      env: {},
      cwd: "/workspace",
      stdinOpen: false,
    },
    expected: {
      exitCode: 0,
      stdoutPrefix: "codex-cli ",
      stderr: "",
    },
    requirements: {
      hostCommand: false,
      network: false,
      terminal: false,
      workspace: false,
    },
    wasi: {
      imports: ["wasi_snapshot_preview1"],
      preview: "preview1",
    },
  });
});

test("normalized Codex fixture can load into the command lifecycle worker", async () => {
  const fixture = normalizeCodexBrowserRunFixture(validManifest());
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage(fixture.commandLoad);

  assert.deepEqual(port.messages, [
    {
      type: "command.loaded",
      id: "load-codex",
      artifactKind: "wasi-module",
      cache: null,
      contentSha256: null,
      entrypoint: "_start",
      packageId: "codex",
      packageType: "wasi-module",
      commands: ["codex"],
    },
  ]);
});

test("validateCodexArtifactManifest rejects missing and invalid fields", () => {
  assert.throws(
    () => validateCodexArtifactManifest(null),
    (error) => {
      assert.equal(error.kind, "invalid_manifest");
      assert.equal(error.message, "artifact manifest must be an object");
      return true;
    },
  );

  assert.throws(
    () => validateCodexArtifactManifest({}),
    (error) => {
      assert.equal(error.kind, "invalid_manifest");
      assert.equal(error.details.field, "schemaVersion");
      return true;
    },
  );

  assert.throws(
    () => validateCodexArtifactManifest(validManifest({ artifactSizeBytes: 0 })),
    (error) => {
      assert.equal(error.kind, "invalid_manifest");
      assert.equal(error.details.field, "artifactSizeBytes");
      return true;
    },
  );

  assert.throws(
    () =>
      validateCodexArtifactManifest(validManifest({ artifactSha256: "nope" })),
    (error) => {
      assert.equal(error.kind, "invalid_manifest");
      assert.equal(error.details.field, "artifactSha256");
      return true;
    },
  );
});

test("normalizeCodexBrowserRunFixture returns structured unsupported errors", () => {
  const cases = [
    ["artifactKind", "webc-package", "artifact_kind"],
    ["packageName", "other", "package_name"],
    ["command", "other", "command"],
    ["entrypoint", "main", "entrypoint"],
    ["wasi", "preview2", "wasi"],
    ["requiresNetwork", true, "requires_network"],
    ["requiresWorkspace", true, "requires_workspace"],
    ["requiresHostCommand", true, "requires_host_command"],
    ["requiresTerminal", true, "requires_terminal"],
    ["args", ["status"], "args"],
    ["expectedExitCode", 1, "expected_exit_code"],
    ["stdoutPrefix", "other ", "stdout_prefix"],
    ["expectedStderr", "warning", "expected_stderr"],
  ];

  for (const [field, value, reason] of cases) {
    assert.throws(
      () => normalizeCodexBrowserRunFixture(validManifest({ [field]: value })),
      (error) => {
        assert.equal(error.kind, "unsupported", field);
        assert.equal(error.details.reason, reason, field);
        return true;
      },
    );
  }
});

test("fetchCodexArtifactBytes fetches with an injectable transport and verifies bytes", async () => {
  const bytes = encoder.encode("codex-cli 0.0.0\n");
  const manifest = validManifest({
    artifactSha256: await sha256Hex(bytes),
    artifactSizeBytes: bytes.byteLength,
  });
  const seen = {};

  const result = await fetchCodexArtifactBytes(manifest, {
    baseUrl: "https://example.test/artifacts/",
    fetchImpl: async (url, init) => {
      seen.url = url;
      seen.init = init;
      return new Response(bytes, {
        headers: { "Content-Length": String(bytes.byteLength) },
        status: 200,
      });
    },
  });

  assert.equal(
    seen.url,
    "https://example.test/artifacts/codex-wasix/dist/codex-version-smoke.wasm",
  );
  assert.equal(seen.init.credentials, "same-origin");
  assert.equal(seen.init.method, "GET");
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.fixture.artifact.sha256, manifest.artifactSha256);
});

test("fetchCodexArtifactBytes reports transport and size failures", async () => {
  const bytes = encoder.encode("codex-cli 0.0.0\n");
  const manifest = validManifest({
    artifactSha256: await sha256Hex(bytes),
    artifactSizeBytes: bytes.byteLength,
  });

  await assert.rejects(
    fetchCodexArtifactBytes(manifest, { fetchImpl: null }),
    (error) => {
      assert.equal(error.kind, "artifact_fetch_failed");
      assert.match(error.message, /Fetch API is unavailable/);
      return true;
    },
  );

  await assert.rejects(
    fetchCodexArtifactBytes(manifest, {
      fetchImpl: async () => new Response("missing", { status: 404 }),
    }),
    (error) => {
      assert.equal(error.kind, "artifact_fetch_failed");
      assert.equal(error.details.status, 404);
      return true;
    },
  );

  await assert.rejects(
    fetchCodexArtifactBytes(
      validManifest({
        artifactSha256: await sha256Hex(bytes),
        artifactSizeBytes: bytes.byteLength + 1,
      }),
      {
        fetchImpl: async () =>
          new Response(bytes, {
            headers: { "Content-Length": String(bytes.byteLength) },
            status: 200,
          }),
      },
    ),
    (error) => {
      assert.equal(error.kind, "artifact_size_mismatch");
      return true;
    },
  );
});

test("fetchCodexArtifactBytes enforces streamed size before hashing", async () => {
  const bytes = encoder.encode("codex-cli 0.0.0\n");
  const manifest = validManifest({
    artifactSha256: await sha256Hex(bytes),
    artifactSizeBytes: bytes.byteLength - 1,
  });

  await assert.rejects(
    fetchCodexArtifactBytes(manifest, {
      fetchImpl: async () => ({
        body: streamFromChunks([bytes.slice(0, 4), bytes.slice(4)]),
        headers: new Headers(),
        ok: true,
        status: 200,
      }),
    }),
    (error) => {
      assert.equal(error.kind, "artifact_size_mismatch");
      return true;
    },
  );
});

test("verifyCodexArtifactBytes reports hash mismatches", async () => {
  const bytes = encoder.encode("codex-cli 0.0.0\n");

  await assert.rejects(
    verifyCodexArtifactBytes(bytes, {
      sha256: "0".repeat(64),
      sizeBytes: bytes.byteLength,
    }),
    (error) => {
      assert.equal(error.kind, "artifact_hash_mismatch");
      assert.match(error.details.actual, /^[a-f0-9]{64}$/);
      return true;
    },
  );

  await assert.rejects(
    verifyCodexArtifactBytes("not bytes", {
      sha256: "0".repeat(64),
      sizeBytes: bytes.byteLength,
    }),
    (error) => {
      assert.equal(error.kind, "invalid_manifest");
      assert.equal(error.message, "artifact bytes must be a byte buffer");
      return true;
    },
  );
});

function validManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    packageName: "codex",
    artifactKind: "wasi-module",
    artifactPath: "codex-wasix/dist/codex-version-smoke.wasm",
    artifactSizeBytes: 69_547,
    artifactSha256: "e6c3a93230408b5df50b6b4f7b9871fc431feb4eaffa2a75aeacc9db042f8231",
    command: "codex",
    entrypoint: "_start",
    args: ["--version"],
    expectedExitCode: 0,
    stdoutPrefix: "codex-cli ",
    expectedStderr: "",
    wasi: "preview1",
    requiresNetwork: false,
    requiresWorkspace: false,
    requiresHostCommand: false,
    requiresTerminal: false,
    ...overrides,
  };
}

function recordingPort() {
  const messages = [];
  return {
    messages,
    postMessage(message) {
      messages.push(message);
    },
  };
}

function streamFromChunks(chunks) {
  return {
    getReader() {
      let index = 0;
      return {
        async read() {
          if (index >= chunks.length) {
            return { done: true };
          }
          return {
            done: false,
            value: chunks[index++],
          };
        },
      };
    },
  };
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
