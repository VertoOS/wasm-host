import {
  CODEX_VERSION_SMOKE_STDOUT_PREFIX,
  CODEX_VERSION_SMOKE_WASM,
  codexVersionSmokeManifest,
} from "../fixtures/codex-version-smoke-core.js";
import { fetchCodexArtifactBytes } from "../src/artifact-manifest.js";
import {
  createBrowserTerminalSession,
  createTerminalTranscript,
} from "../src/terminal.js";

const decoder = new TextDecoder();
const NON_COOPERATIVE_LOOP_WASM = base64ToBytes(
  "AGFzbQEAAAABBAFgAAADAgEABQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAAKCQEHAANADAALCw==",
);
const HTTP_BRIDGE_SMOKE_STDOUT = "HTTP_BRIDGE_OK\n";

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
    const transcript = createTerminalTranscript();
    const terminal = createBrowserTerminalSession({
      port: worker,
      sink: transcript.sink,
    });
    const result = await terminal.start(fixture.commandRun);
    const stdout = transcript.stdoutText();
    const stderr = transcript.stderrText();

    assert(load.loaded.packageId === "codex", "Codex package should load");
    assert(
      load.loaded.artifactKind === "wasi-module",
      "Codex package should load as a raw WASI module",
    );
    assert(
      result.exitCode === fixture.expected.exitCode,
      "Codex version smoke should exit successfully",
    );
    assert(
      stdout.startsWith(fixture.expected.stdoutPrefix),
      "Codex version smoke stdout should report the codex-cli version",
    );
    assert(stderr === fixture.expected.stderr, "Codex stderr should be empty");
    const hardTimeout = await runNonCooperativeTimeout(worker);
    const httpBridge = await runHttpBridgeSmoke(worker);

    return {
      artifactKind: load.loaded.artifactKind,
      artifactUrl,
      exitCode: result.exitCode,
      hardTimeout,
      httpBridge,
      stderr,
      stdout,
      stdoutBytes: result.stdoutBytes,
      workerEntrypoint: new URL(
        "../src/command-worker-entry.js",
        import.meta.url,
      ).pathname,
    };
  } finally {
    worker.terminate();
  }
}

async function runHttpBridgeSmoke(worker) {
  const url = new URL("./http-bridge-smoke.txt", import.meta.url).href;
  assert(
    new URL(url).origin === location.origin,
    "HTTP bridge smoke fixture should be same-origin",
  );
  const load = await dispatchAndCollect(worker, {
    type: "command.load",
    id: "load-http-smoke",
    package: {
      commands: ["http-smoke"],
      id: "http-smoke",
      type: "http-smoke",
    },
  });
  assert(load.loaded.packageId === "http-smoke", "HTTP smoke package should load");
  assert(
    load.loaded.packageType === "http-smoke",
    "HTTP smoke package should use the built-in executor",
  );
  const run = await dispatchAndCollect(worker, {
    type: "command.run",
    id: "run-http-smoke",
    packageId: "http-smoke",
    command: "http-smoke",
    args: [url],
    timeoutMs: 5000,
  });
  const stdout = chunksText(run.stdout);
  const stderr = chunksText(run.stderr);
  const result = run.complete.result;
  assert(
    result?.exitCode === 0,
    "HTTP bridge smoke should exit successfully",
  );
  assert(
    stdout === HTTP_BRIDGE_SMOKE_STDOUT,
    "HTTP bridge smoke stdout should match the fixture",
  );
  assert(stderr === "", "HTTP bridge smoke stderr should be empty");
  return {
    exitCode: result.exitCode,
    stderr,
    stderrBytes: result.stderrBytes,
    stdout,
    stdoutBytes: result.stdoutBytes,
    urlPath: new URL(url).pathname,
  };
}

async function runNonCooperativeTimeout(worker) {
  const load = await dispatchAndCollect(worker, {
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
  assert(load.loaded.packageId === "loop", "loop package should load");
  const run = await dispatchAndCollect(
    worker,
    {
      type: "command.run",
      id: "run-loop-timeout",
      packageId: "loop",
      command: "loop",
      timeoutMs: 50,
    },
    { resolveError: true },
  );
  assert(
    run.error?.error?.kind === "timeout",
    "non-cooperative raw WASI module should time out",
  );
  assert(
    run.error?.result?.exitCode === 124,
    "non-cooperative timeout should use exit code 124",
  );
  return {
    errorKind: run.error.error.kind,
    exitCode: run.error.result.exitCode,
    timedOut: run.error.result.timedOut,
  };
}

function dispatchAndCollect(worker, message, options = {}) {
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
      if (
        data.type === "command.stdout.close" ||
        data.type === "command.stderr.close"
      ) {
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
        if (options.resolveError) {
          resolve({ error: data, stderr, stdout });
          return;
        }
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

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
