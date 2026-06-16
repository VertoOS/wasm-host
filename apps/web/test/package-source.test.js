import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_VERSION_SMOKE_STDOUT,
  CODEX_VERSION_SMOKE_WASM,
  codexVersionSmokeManifest,
} from "../fixtures/codex-version-smoke-core.js";
import { createBrowserCommandWorkerRuntime } from "../src/command-worker.js";
import {
  parsePackageArgs,
  resolveBrowserPackageSource,
} from "../src/package-source.js";

const decoder = new TextDecoder();

test("resolveBrowserPackageSource returns the built-in Codex smoke package", async () => {
  const source = await resolveBrowserPackageSource();

  assert.equal(source.commandLabel, "codex --version");
  assert.equal(source.loadMessage.package.id, "codex");
  assert.equal(source.loadMessage.package.artifactKind, "wasi-module");
  assert.equal(source.loadMessage.package.wasiModule.byteLength, 146);
  assert.deepEqual(source.runMessage.args, ["--version"]);
  assert.equal(source.runMessage.stdinOpen, false);
  assert.equal(source.metadata.sourceKind, "builtin-codex");
});

test("resolveBrowserPackageSource normalizes uploaded package bytes for worker loading", async () => {
  const source = await resolveBrowserPackageSource({
    argsText: '["--flag", "value with spaces"]',
    command: "smoke",
    executorType: "smoke",
    file: file("test package.webc", webcBytes("upload")),
    kind: "package-file",
    packageId: "upload-pkg",
  });

  assert.equal(source.commandLabel, "smoke --flag value with spaces");
  assert.equal(source.loadMessage.id, "load-upload-pkg");
  assert.equal(source.loadMessage.package.id, "upload-pkg");
  assert.equal(source.loadMessage.package.executorType, "smoke");
  assert.equal(source.loadMessage.package.type, "smoke");
  assert.equal(source.loadMessage.package.bytes.byteLength, webcBytes("upload").byteLength);
  assert.match(source.loadMessage.package.expectedSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(source.runMessage, {
    type: "command.run",
    id: "run-upload-pkg-smoke",
    packageId: "upload-pkg",
    command: "smoke",
    args: ["--flag", "value with spaces"],
    env: {},
    cwd: "/workspace",
  });
  assert.equal(source.metadata.sourceLabel, "test package.webc");
});

test("resolveBrowserPackageSource runs uploaded raw WASI modules", async () => {
  const source = await resolveBrowserPackageSource({
    argsText: "--version",
    command: "codex",
    executorType: "smoke",
    file: file("codex-version-smoke.wasm", CODEX_VERSION_SMOKE_WASM),
    kind: "package-file",
    packageId: "codex",
  });

  assert.equal(source.commandLabel, "codex --version");
  assert.equal(source.loadMessage.package.artifactKind, "wasi-module");
  assert.equal(source.loadMessage.package.type, "wasi-module");
  assert.equal(source.loadMessage.package.executorType, "wasi-module");
  assert.equal(source.loadMessage.package.entrypoint, "_start");
  assert.equal(source.loadMessage.package.bytes.byteLength, 146);
  assert.equal(source.metadata.executorType, "wasi-module");
  assert.equal(source.metadata.sourceLabel, "codex-version-smoke.wasm");
  assert.equal(source.runMessage.stdinOpen, false);

  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });
  await runtime.handleMessage(source.loadMessage);
  await runtime.handleMessage(source.runMessage);

  assert.equal(stdoutText(port.messages), CODEX_VERSION_SMOKE_STDOUT);
  assert.equal(port.messages.at(-1).type, "command.complete");
  assert.equal(port.messages.at(-1).result.exitCode, 0);
});

test("resolveBrowserPackageSource normalizes URL raw WASI modules", async () => {
  const source = await resolveBrowserPackageSource(
    {
      argsText: "--version",
      command: "codex",
      executorType: "smoke",
      kind: "package-url",
      packageId: "codex-url",
      url: "https://user:secret@example.test/codex.wasm?token=hidden#frag",
    },
    {
      fetchImpl: async () =>
        new Response(CODEX_VERSION_SMOKE_WASM, {
          headers: {
            "Content-Length": String(CODEX_VERSION_SMOKE_WASM.byteLength),
          },
          status: 200,
        }),
    },
  );

  assert.equal(source.loadMessage.package.artifactKind, "wasi-module");
  assert.equal(source.loadMessage.package.type, "wasi-module");
  assert.equal(source.loadMessage.package.executorType, "wasi-module");
  assert.equal(source.metadata.sourceLabel, "https://example.test/codex.wasm");
  assert(!JSON.stringify(source.metadata).includes("secret"));
  assert(!JSON.stringify(source.metadata).includes("token=hidden"));
  assert.equal(source.runMessage.stdinOpen, false);
});

test("resolveBrowserPackageSource normalizes URL packages without exposing secrets", async () => {
  const seen = {};
  const source = await resolveBrowserPackageSource(
    {
      argsText: "--version",
      command: "smoke",
      executorType: "smoke",
      kind: "package-url",
      packageId: "url-pkg",
      url: "https://user:secret@example.test/pkg.webc?token=hidden#frag",
    },
    {
      fetchImpl: async (url, init) => {
        seen.url = url;
        seen.init = init;
        return new Response(webcBytes("url"), {
          headers: { "Content-Length": String(webcBytes("url").byteLength) },
          status: 200,
        });
      },
    },
  );

  assert.equal(
    seen.url,
    "https://user:secret@example.test/pkg.webc?token=hidden#frag",
  );
  assert.equal(seen.init.credentials, "same-origin");
  assert.equal(source.metadata.sourceLabel, "https://example.test/pkg.webc");
  assert(!JSON.stringify(source.metadata).includes("secret"));
  assert(!JSON.stringify(source.metadata).includes("token=hidden"));
  assert.equal(source.loadMessage.package.bytes.byteLength, webcBytes("url").byteLength);
});

test("resolveBrowserPackageSource accepts manifest JSON with local artifact bytes", async () => {
  const manifest = await codexVersionSmokeManifest(CODEX_VERSION_SMOKE_WASM, {
    artifactPath: "local/codex-version-smoke.wasm",
  });
  const source = await resolveBrowserPackageSource({
    file: file("codex-version-smoke.wasm", CODEX_VERSION_SMOKE_WASM),
    kind: "manifest-json",
    manifestText: JSON.stringify(manifest),
  });

  assert.equal(source.commandLabel, "codex --version");
  assert.equal(source.loadMessage.package.id, "codex");
  assert.equal(source.loadMessage.package.wasiModule.byteLength, 146);
  assert.equal(source.metadata.sourceKind, "manifest-json");
  assert.equal(source.metadata.sourceLabel, "codex-version-smoke.wasm");
});

test("resolveBrowserPackageSource resolves manifest URLs relative to their artifact", async () => {
  const manifest = await codexVersionSmokeManifest(CODEX_VERSION_SMOKE_WASM, {
    artifactPath: "codex-version-smoke.wasm",
  });
  const seen = [];
  const source = await resolveBrowserPackageSource(
    {
      kind: "manifest-url",
      url: "https://example.test/dist/artifact-manifest.json?token=hidden",
    },
    {
      fetchImpl: async (url) => {
        seen.push(url);
        if (url.includes("artifact-manifest.json")) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        return new Response(CODEX_VERSION_SMOKE_WASM, {
          headers: {
            "Content-Length": String(CODEX_VERSION_SMOKE_WASM.byteLength),
          },
          status: 200,
        });
      },
    },
  );

  assert.deepEqual(seen, [
    "https://example.test/dist/artifact-manifest.json?token=hidden",
    "https://example.test/dist/codex-version-smoke.wasm",
  ]);
  assert.equal(source.metadata.packageId, "codex");
  assert.equal(source.metadata.sourceKind, "manifest-url");
  assert.equal(source.metadata.sourceLabel, "Codex artifact manifest");
  assert(!JSON.stringify(source.metadata).includes("token=hidden"));
  assert.equal(source.loadMessage.package.wasiModule.byteLength, 146);
});

test("parsePackageArgs accepts whitespace args and JSON string arrays", () => {
  assert.deepEqual(parsePackageArgs("--one two"), ["--one", "two"]);
  assert.deepEqual(parsePackageArgs('["--one", "two words"]'), [
    "--one",
    "two words",
  ]);
  assert.throws(() => parsePackageArgs("[1]"), /array of strings/);
});

function file(name, bytes) {
  return {
    name,
    async arrayBuffer() {
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
    },
  };
}

function webcBytes(label) {
  return new Uint8Array([
    0x00,
    0x77,
    0x65,
    0x62,
    0x63,
    ...new TextEncoder().encode(label),
  ]);
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

function stdoutText(messages) {
  return decoder.decode(
    concatChunks(
      messages
        .filter((message) => message.type === "command.stdout")
        .map((message) => message.chunk),
    ),
  );
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
