import {
  CODEX_VERSION_SMOKE_STDOUT_PREFIX,
  CODEX_VERSION_SMOKE_WASM,
  codexVersionSmokeManifest,
} from "../fixtures/codex-version-smoke-core.js";
import { fetchCodexArtifactBytes } from "../src/artifact-manifest.js";

const decoder = new TextDecoder();

export async function runCodexVersionSmoke() {
  const manifest = await codexVersionSmokeManifest();
  const { artifactUrl, fixture } = await fetchCodexArtifactBytes(manifest, {
    fetchImpl: async () =>
      new Response(CODEX_VERSION_SMOKE_WASM, {
        headers: {
          "Content-Length": String(CODEX_VERSION_SMOKE_WASM.byteLength),
        },
        status: 200,
      }),
  });
  assert(
    fixture.expected.stdoutPrefix === CODEX_VERSION_SMOKE_STDOUT_PREFIX,
    "fixture stdout prefix must match the Codex version contract",
  );

  const worker = new Worker(
    new URL("../src/command-worker-entry.js", import.meta.url),
    { name: "codex-version-smoke", type: "module" },
  );
  try {
    const load = await dispatchAndCollect(worker, fixture.commandLoad);
    const run = await dispatchAndCollect(worker, fixture.commandRun);
    const stdout = chunksText(run.stdout);
    const stderr = chunksText(run.stderr);

    assert(load.loaded.packageId === "codex", "Codex package should load");
    assert(
      load.loaded.artifactKind === "wasi-module",
      "Codex package should load as a raw WASI module",
    );
    assert(
      run.complete.result.exitCode === fixture.expected.exitCode,
      "Codex version smoke should exit successfully",
    );
    assert(
      stdout.startsWith(fixture.expected.stdoutPrefix),
      "Codex version smoke stdout should report the codex-cli version",
    );
    assert(stderr === fixture.expected.stderr, "Codex stderr should be empty");

    return {
      artifactKind: load.loaded.artifactKind,
      artifactUrl,
      exitCode: run.complete.result.exitCode,
      stderr,
      stdout,
      stdoutBytes: run.complete.result.stdoutBytes,
      workerEntrypoint: new URL(
        "../src/command-worker-entry.js",
        import.meta.url,
      ).pathname,
    };
  } finally {
    worker.terminate();
  }
}

function dispatchAndCollect(worker, message) {
  const stdout = [];
  const stderr = [];
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const data = event.data;
      if (data.id !== message.id) {
        return;
      }
      if (data.type === "command.stdout") {
        stdout.push(data.chunk);
        return;
      }
      if (data.type === "command.stderr") {
        stderr.push(data.chunk);
        return;
      }
      if (data.type === "command.started") {
        return;
      }
      cleanup();
      if (data.type === "command.loaded") {
        resolve({ loaded: data });
        return;
      }
      if (data.type === "command.complete") {
        resolve({ complete: data, stderr, stdout });
        return;
      }
      if (data.type === "command.error") {
        reject(Object.assign(new Error(data.error.message), data.error));
        return;
      }
      reject(new Error(`unexpected worker event: ${data.type}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
