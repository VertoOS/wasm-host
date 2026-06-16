import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserCommandWorkerRuntime } from "../src/command-worker.js";
import {
  MemoryPackageCache,
  commandPackageFromRecord,
  createBrowserPackageLoader,
  detectPackageFormat,
  packageCacheKeys,
} from "../src/package-loader.js";

const decoder = new TextDecoder();

test("BrowserPackageLoader loads explicit WebC bytes and normalizes command package metadata", async () => {
  const cache = new MemoryPackageCache();
  const loader = createBrowserPackageLoader({ cache });
  const record = await loader.loadBytes({
    bytes: webcBytes("fake"),
    commands: ["smoke", "version"],
    defaultCommand: "smoke",
    executorType: "smoke",
    id: "pkg",
    metadata: { name: "fixture" },
  });

  assert.equal(record.id, "pkg");
  assert.equal(record.format, "webc");
  assert.equal(record.executorType, "smoke");
  assert.equal(record.defaultCommand, "smoke");
  assert.deepEqual(record.commands, ["smoke", "version"]);
  assert.match(record.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(record.cache, {
    backend: "indexeddb",
    modulePath: `wasm-host/v1/modules/sha256/${record.sha256}/`,
    packagePath: `wasm-host/v1/packages/sha256/${record.sha256}.webc`,
  });
  assert.equal(
    record.cacheKeys.packageBytes,
    `indexeddb://wasm-host/package-by-sha256/webc/${record.sha256}`,
  );
  assert.equal(
    record.cacheKeys.moduleArtifactsPrefix,
    `indexeddb://wasm-host/module-artifacts/webc/${record.sha256}/`,
  );

  assert.deepEqual(await cache.getPackage("pkg"), {
    artifactKind: "webc-package",
    byteLength: record.byteLength,
    cache: record.cache,
    cacheKeys: record.cacheKeys,
    commands: ["smoke", "version"],
    contentSha256: record.sha256,
    defaultCommand: "smoke",
    entrypoint: "smoke",
    executorType: "smoke",
    format: "webc",
    id: "pkg",
    metadata: record.metadata,
    sha256: record.sha256,
    source: { kind: "bytes", label: "explicit-bytes" },
  });
  assert.equal(await cache.getPackageBytes(record), record.bytes);

  assert.deepEqual(commandPackageFromRecord(record), {
    artifactKind: "webc-package",
    cache: record.cache,
    id: "pkg",
    type: "smoke",
    contentSha256: record.sha256,
    commands: ["smoke", "version"],
    entrypoint: "smoke",
    metadata: {
      name: "fixture",
      artifactKind: "webc-package",
      byteLength: record.byteLength,
      cache: record.cache,
      cacheKeys: record.cacheKeys,
      defaultCommand: "smoke",
      entrypoint: "smoke",
      format: "webc",
      sha256: record.sha256,
      source: { kind: "bytes", label: "explicit-bytes" },
    },
  });
});

test("BrowserPackageLoader command load message feeds the command lifecycle worker", async () => {
  const loader = createBrowserPackageLoader();
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  const record = await loader.loadBytes({
    bytes: webcBytes("smoke"),
    command: "smoke",
    executorType: "smoke",
    id: "smoke-pkg",
  });
  await runtime.handleMessage(
    loader.commandLoadMessage(record, { id: "load-smoke" }),
  );
  await runtime.handleMessage({
    type: "command.run",
    id: "run-smoke",
    packageId: "smoke-pkg",
    command: "smoke",
  });

  assert.equal(port.messages[0].type, "command.loaded");
  assert.equal(port.messages[0].packageId, "smoke-pkg");
  assert.equal(chunksText(stdoutChunks(port.messages)), "BROWSER_SMOKE_OK\n");
  assert.equal(port.messages.at(-1).type, "command.complete");
});

test("command lifecycle worker loads package bytes through BrowserPackageLoader", async () => {
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage({
    type: "command.load",
    id: "load-bytes",
    package: {
      bytes: webcBytes("worker"),
      command: "smoke",
      executorType: "smoke",
      id: "worker-pkg",
    },
  });
  await runtime.handleMessage({
    type: "command.run",
    id: "run-worker-pkg",
    packageId: "worker-pkg",
    command: "smoke",
  });

  assert.equal(port.messages[0].type, "command.loaded");
  assert.equal(port.messages[0].artifactKind, "webc-package");
  assert.equal(port.messages[0].entrypoint, "smoke");
  assert.match(port.messages[0].contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(port.messages[0].cache.backend, "indexeddb");
  assert.equal(chunksText(stdoutChunks(port.messages)), "BROWSER_SMOKE_OK\n");
});

test("BrowserPackageLoader loads URL-backed Wasm bytes without external network", async () => {
  const seen = {};
  const loader = createBrowserPackageLoader({
    fetchImpl: async (url, init) => {
      seen.url = url;
      seen.init = init;
      return new Response(wasmBytes("fake"), {
        headers: { "Content-Length": String(wasmBytes("fake").byteLength) },
        status: 200,
      });
    },
  });

  const record = await loader.loadUrl({
    commands: ["main"],
    id: "wasm-pkg",
    url: "https://user:secret@example.test/pkg.wasm?token=hidden#frag",
  });

  assert.equal(seen.init.credentials, "same-origin");
  assert.equal(record.format, "wasm");
  assert.equal(record.artifactKind, "wasm-module");
  assert.equal(
    seen.url,
    "https://user:secret@example.test/pkg.wasm?token=hidden#frag",
  );
  assert.deepEqual(record.source, {
    kind: "url",
    label: "https://example.test/pkg.wasm",
  });

  const dataRecord = await loader.loadUrl({
    command: "main",
    id: "data-pkg",
    url: "data:application/octet-stream;base64,AGFzbQAAAAA=",
  });
  assert.deepEqual(dataRecord.source, {
    kind: "url",
    label: "data: URL",
  });
});

test("BrowserPackageLoader verifies expected sha256 pins", async () => {
  const loader = createBrowserPackageLoader();
  const bytes = webcBytes("pinned");
  const record = await loader.loadBytes({
    bytes,
    command: "main",
    expectedSha256: await sha256Hex(bytes),
  });

  assert.equal(record.contentSha256, record.sha256);

  await assert.rejects(
    loader.loadBytes({
      bytes,
      command: "main",
      expectedSha256: "0".repeat(64),
    }),
    (error) => {
      assert.equal(error.kind, "invalid_package");
      assert.match(error.message, /^browser package sha256 mismatch:/);
      return true;
    },
  );
});

test("BrowserPackageLoader rejects invalid packages and command metadata", async () => {
  const loader = createBrowserPackageLoader();
  await assert.rejects(
    loader.loadBytes({ bytes: new Uint8Array([1, 2, 3]), commands: ["main"] }),
    (error) => {
      assert.equal(error.kind, "invalid_package");
      assert.equal(
        error.message,
        "invalid browser package bytes: expected WebC or Wasm magic",
      );
      return true;
    },
  );

  await assert.rejects(
    loader.loadBytes({ bytes: webcBytes("fake"), commands: [] }),
    (error) => {
      assert.equal(error.kind, "invalid_package");
      assert.equal(
        error.message,
        "browser package commands must be a non-empty array",
      );
      return true;
    },
  );

  await assert.rejects(
    loader.loadBytes({ bytes: webcBytes("fake"), command: "bin/tool" }),
    (error) => {
      assert.equal(error.kind, "invalid_package");
      assert.equal(
        error.message,
        "browser package command names must not contain NUL or /",
      );
      return true;
    },
  );
});

test("BrowserPackageLoader rejects raw WASI module artifact kind for this slice", async () => {
  const loader = createBrowserPackageLoader();
  await assert.rejects(
    loader.loadBytes({
      artifactKind: "wasi-module",
      bytes: wasmBytes("wasi"),
      command: "main",
    }),
    (error) => {
      assert.equal(error.kind, "unsupported");
      assert.equal(
        error.message,
        "raw WASI module packages are not supported by the browser package loader yet",
      );
      return true;
    },
  );
});

test("BrowserPackageLoader rejects package byte limits and fetch failures cleanly", async () => {
  const smallLoader = createBrowserPackageLoader({ packageBytesLimit: 4 });
  await assert.rejects(
    smallLoader.loadBytes({ bytes: webcBytes("large"), commands: ["main"] }),
    (error) => {
      assert.equal(error.kind, "package_too_large");
      assert.equal(error.message, "browser package bytes exceeded 4 bytes");
      return true;
    },
  );

  const fetchLoader = createBrowserPackageLoader({
    fetchImpl: async () => new Response("", { status: 404 }),
  });
  await assert.rejects(
    fetchLoader.loadUrl({
      commands: ["main"],
      url: "https://example.test/missing.webc",
    }),
    (error) => {
      assert.equal(error.kind, "transport");
      assert.equal(error.message, "browser package fetch failed with status 404");
      return true;
    },
  );

  const streamingLoader = createBrowserPackageLoader({
    fetchImpl: async () =>
      new Response(readableStream([webcBytes("large")]), { status: 200 }),
    packageBytesLimit: 4,
  });
  await assert.rejects(
    streamingLoader.loadUrl({
      command: "main",
      url: "https://example.test/large.webc",
    }),
    (error) => {
      assert.equal(error.kind, "package_too_large");
      assert.equal(error.message, "browser package bytes exceeded 4 bytes");
      return true;
    },
  );
});

test("MemoryPackageCache stores module artifacts by explicit cache key", async () => {
  const cache = new MemoryPackageCache();
  const artifact = new Uint8Array([1, 2, 3]);

  await cache.putModuleArtifact("module-key", artifact);

  assert.equal(await cache.getModuleArtifact("module-key"), artifact);
  assert.equal(await cache.getModuleArtifact("missing"), null);
});

test("package helpers detect formats and expose deterministic browser cache keys", () => {
  assert.equal(detectPackageFormat(webcBytes("x")), "webc");
  assert.equal(detectPackageFormat(wasmBytes("x")), "wasm");
  assert.deepEqual(
    packageCacheKeys({
      format: "webc",
      sha256: "a".repeat(64),
      namespace: "custom",
    }),
    {
      cache: {
        backend: "indexeddb",
        modulePath: `custom/v1/modules/sha256/${"a".repeat(64)}/`,
        packagePath: `custom/v1/packages/sha256/${"a".repeat(64)}.webc`,
      },
      moduleArtifactsPrefix: `indexeddb://custom/module-artifacts/webc/${"a".repeat(64)}/`,
      packageBytes: `indexeddb://custom/package-by-sha256/webc/${"a".repeat(64)}`,
    },
  );
});

function webcBytes(suffix) {
  return concatBytes(new Uint8Array([0x00, 0x77, 0x65, 0x62, 0x63]), suffix);
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function wasmBytes(suffix) {
  return concatBytes(new Uint8Array([0x00, 0x61, 0x73, 0x6d]), suffix);
}

function concatBytes(prefix, suffix) {
  const tail = new TextEncoder().encode(suffix);
  const bytes = new Uint8Array(prefix.byteLength + tail.byteLength);
  bytes.set(prefix);
  bytes.set(tail, prefix.byteLength);
  return bytes;
}

function recordingPort() {
  return {
    messages: [],
    postMessage(message) {
      this.messages.push(message);
    },
  };
}

function stdoutChunks(messages) {
  return messages
    .filter((message) => message.type === "command.stdout")
    .map((message) => message.chunk);
}

function chunksText(chunks) {
  return decoder.decode(concatChunks(chunks));
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

function readableStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}
