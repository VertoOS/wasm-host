import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  assertCodexBrowserRequestPayload,
  codexBrowserRequestBuilderFixture,
} from "../fixtures/codex-browser-request-builder-core.js";
import {
  hasLocalCodexBrowserWasm,
  readLocalCodexBrowserWasm,
} from "../fixtures/codex-browser-request-builder-fixture.js";
import {
  CODEX_VERSION_SMOKE_STDOUT,
  CODEX_VERSION_SMOKE_STDOUT_PREFIX,
  CODEX_VERSION_SMOKE_WASM,
  codexVersionSmokeManifest,
  hasLocalCodexVersionSmokeArtifact,
  readLocalCodexVersionSmokeArtifact,
} from "../fixtures/codex-version-smoke-fixture.js";
import {
  fetchCodexArtifactBytes,
  parseArtifactManifestJson,
} from "../src/artifact-manifest.js";

const decoder = new TextDecoder();

test("command worker entry runs the browser smoke command across a worker boundary", async () => {
  const worker = createCommandWorker();
  try {
    const load = await dispatchAndCollect(worker, {
      type: "command.load",
      id: "load-smoke",
      package: { id: "smoke", type: "smoke", commands: ["smoke"] },
    });
    const run = await dispatchAndCollect(worker, {
      type: "command.run",
      id: "run-smoke",
      packageId: "smoke",
      command: "smoke",
      args: ["--version"],
      cwd: "/workspace",
    });

    assert.equal(load.loaded.packageId, "smoke");
    assert.equal(load.loaded.packageType, "smoke");
    assert.equal(chunksText(run.stdout), "BROWSER_SMOKE_OK\n");
    assert.deepEqual(run.complete.result, {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 17,
      timedOut: false,
    });
  } finally {
    await worker.terminate();
  }
});

test("command worker entry runs the Codex version smoke fixture across a worker boundary", async () => {
  const fixture = await codexVersionSmokeFixture(
    await codexVersionSmokeManifest(),
    CODEX_VERSION_SMOKE_WASM,
  );
  const worker = createCommandWorker();
  try {
    const load = await dispatchAndCollect(worker, fixture.commandLoad);
    const run = await dispatchAndCollect(worker, fixture.commandRun);

    assert.equal(load.loaded.packageId, "codex");
    assert.equal(load.loaded.artifactKind, "wasi-module");
    assert.equal(load.loaded.packageType, "wasi-module");
    assert.match(load.loaded.contentSha256, /^[a-f0-9]{64}$/);
    assert.equal(chunksText(run.stdout), CODEX_VERSION_SMOKE_STDOUT);
    assert.equal(chunksText(run.stderr), "");
    assert.deepEqual(run.complete.result, {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: CODEX_VERSION_SMOKE_STDOUT.length,
      timedOut: false,
    });
  } finally {
    await worker.terminate();
  }
});

test("command worker entry runs the Codex browser request builder across a worker boundary", async () => {
  const fixture = await codexBrowserRequestBuilderFixture();
  const worker = createCommandWorker();
  try {
    const load = await dispatchAndCollect(worker, fixture.commandLoad);
    const run = await dispatchAndCollect(worker, fixture.commandRun);

    assert.equal(load.loaded.packageId, "codex-browser");
    assert.equal(load.loaded.artifactKind, "codex-browser");
    assert.equal(load.loaded.packageType, "codex-browser");
    assertCodexBrowserRequestPayload(
      JSON.parse(chunksText(run.stdout)),
      fixture.expected,
    );
    assert.equal(chunksText(run.stderr), "");
    assert.equal(run.complete.result.exitCode, 0);
  } finally {
    await worker.terminate();
  }
});

test(
  "command worker entry runs the local Codex version-smoke artifact when available",
  {
    skip: !hasLocalCodexVersionSmokeArtifact()
      ? "local Codex WASI artifact is not available"
      : false,
  },
  async () => {
    const { bytes, manifestText } = await readLocalCodexVersionSmokeArtifact();
    const fixture = await codexVersionSmokeFixture(
      parseArtifactManifestJson(manifestText),
      bytes,
    );
    const worker = createCommandWorker();
    try {
      const load = await dispatchAndCollect(worker, fixture.commandLoad);
      const run = await dispatchAndCollect(worker, fixture.commandRun);

      assert.equal(load.loaded.packageId, "codex");
      assert.equal(load.loaded.artifactKind, "wasi-module");
      assert.equal(run.complete.result.exitCode, fixture.expected.exitCode);
      assert.match(chunksText(run.stdout), /^codex-cli /);
      assert.equal(chunksText(run.stderr), fixture.expected.stderr);
    } finally {
      await worker.terminate();
    }
  },
);

test(
  "command worker entry runs the local Codex browser artifact when available",
  {
    skip: !hasLocalCodexBrowserWasm()
      ? "local Codex browser artifact is not available"
      : false,
  },
  async () => {
    const fixture = await codexBrowserRequestBuilderFixture(
      await readLocalCodexBrowserWasm(),
      {
        model: "gpt-5-codex",
        prompt: "write tests",
      },
    );
    const worker = createCommandWorker();
    try {
      const load = await dispatchAndCollect(worker, fixture.commandLoad);
      const run = await dispatchAndCollect(worker, fixture.commandRun);

      assert.equal(load.loaded.packageId, "codex-browser");
      assert.equal(load.loaded.artifactKind, "codex-browser");
      assertCodexBrowserRequestPayload(
        JSON.parse(chunksText(run.stdout)),
        fixture.expected,
      );
      assert.equal(run.complete.result.exitCode, 0);
    } finally {
      await worker.terminate();
    }
  },
);

function createCommandWorker(workerData = {}) {
  return new Worker(
    new URL("../fixtures/command-worker-entry-fixture.js", import.meta.url),
    {
      type: "module",
      workerData,
    },
  );
}

async function codexVersionSmokeFixture(manifest, bytes) {
  const { fixture } = await fetchCodexArtifactBytes(manifest, {
    fetchImpl: async () =>
      new Response(bytes, {
        headers: { "Content-Length": String(bytes.byteLength) },
        status: 200,
      }),
  });
  assert.equal(fixture.expected.stdoutPrefix, CODEX_VERSION_SMOKE_STDOUT_PREFIX);
  return fixture;
}

function dispatchAndCollect(worker, message) {
  const stdout = [];
  const stderr = [];
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      if (event.id !== message.id) {
        return;
      }
      if (event.type === "command.stdout") {
        stdout.push(event.chunk);
        return;
      }
      if (event.type === "command.stderr") {
        stderr.push(event.chunk);
        return;
      }
      if (event.type === "command.started") {
        return;
      }
      if (
        event.type === "command.stdout.close" ||
        event.type === "command.stderr.close"
      ) {
        return;
      }
      cleanup();
      if (event.type === "command.loaded") {
        resolve({ loaded: event });
        return;
      }
      if (event.type === "command.complete") {
        resolve({ complete: event, stderr, stdout });
        return;
      }
      if (event.type === "command.error") {
        reject(Object.assign(new Error(event.error.message), event.error));
        return;
      }
      reject(new Error(`unexpected worker event: ${event.type}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.postMessage(message);
  });
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
