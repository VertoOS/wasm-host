import { createWasmerSdkCommandExecutor } from "../src/index.js";

const DEFAULT_SDK_MODULE_URL =
  "https://unpkg.com/@wasmer/sdk@0.10.0/dist/index.mjs";
const DEFAULT_SDK_WASM_INLINE_URL =
  "https://unpkg.com/@wasmer/sdk@0.10.0/dist/wasm-inlined.mjs";
const BASH_ARTIFACT = Object.freeze({
  name: "wasmer/bash",
  sha256: "059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1",
  url: "https://cdn.wasmer.io/webcimages/059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1.webc",
  version: "1.0.25",
});
const COREUTILS_PACKAGE = Object.freeze({
  name: "wasmer/coreutils",
  version: "1.0.25",
});
const COREUTILS_SPECIFIER = "wasmer/coreutils@1.0.25";
const SDK_PARITY_SCRIPT = [
  "set -u",
  "export LC_ALL=C",
  "cd /workspace",
  "printf 'PWD:%s\\n' \"$(pwd)\"",
  "printf 'SEED:'",
  "cat seed.txt",
  "rm -rf sdk-proof",
  "mkdir sdk-proof",
  "printf 'alpha\\nbeta\\n' > sdk-proof/input.txt",
  "printf 'LS:'",
  "ls sdk-proof",
  "cat sdk-proof/missing.txt 2> sdk-proof/stderr.txt",
  "cat_status=$?",
  "printf 'CAT_STATUS:%s\\n' \"$cat_status\"",
  "printf 'STDERR_CAPTURE:'",
  "cat sdk-proof/stderr.txt",
  "printf 'done\\n' > sdk-proof/output.txt",
  "printf 'ISSUE_228_SDK_OK\\n'",
  "exit 7",
].join("; ");
const EXPECTED_STDOUT =
  "PWD:/workspace\n" +
  "SEED:seed\n" +
  "LS:input.txt\n" +
  "CAT_STATUS:1\n" +
  "STDERR_CAPTURE:cat: sdk-proof/missing.txt: No such file or directory\n" +
  "ISSUE_228_SDK_OK\n";
const EXPECTED_STDERR = "";
const EXPECTED_WORKSPACE_OUTPUT = "done\n";
const STAGE_TIMEOUT_MS = 90000;
const textDecoder = new TextDecoder();

window.__wasmHostWasmerSdkParityStatus = {
  phase: "starting",
  status: "running",
};

runWasmerSdkBrowserParity()
  .then((result) => {
    const status = result.blocked ? "blocked" : "passed";
    setStatus({ phase: "complete", result, status });
  })
  .catch((error) => {
    setStatus({
      error: serializeError(error),
      phase: "failed",
      status: "failed",
    });
  });

async function runWasmerSdkBrowserParity() {
  const environment = browserEnvironment();
  if (!environment.crossOriginIsolated || !environment.sharedArrayBuffer) {
    return blockedResult("environment", "cross_origin_isolation_required", {
      environment,
      message:
        "Wasmer SDK browser execution requires COOP/COEP and SharedArrayBuffer",
    });
  }

  const sdkModuleUrl = queryParam("sdkUrl", DEFAULT_SDK_MODULE_URL);
  const sdkWasmInlineUrl = queryParam(
    "sdkWasmInlineUrl",
    DEFAULT_SDK_WASM_INLINE_URL,
  );
  setStatus({
    environment,
    phase: "sdk-import",
    sdkModuleUrl,
    status: "running",
  });
  const sdkImport = await runStage("sdk-import", async () => import(sdkModuleUrl));
  if (!sdkImport.ok) {
    return blockedResult("sdk-import", "sdk_import_failed", {
      environment,
      sdkModuleUrl,
      blocker: sdkImport.blocker,
    });
  }

  const initOptions = {};
  const wasmInlineImport = await runStage("sdk-wasm-inline-import", async () =>
    import(sdkWasmInlineUrl),
  );
  if (wasmInlineImport.ok) {
    initOptions.module =
      wasmInlineImport.value.default ?? wasmInlineImport.value.module;
  }
  const sdkLoad = {
    moduleUrl: sdkModuleUrl,
    wasmInlineBlocker: wasmInlineImport.blocker ?? null,
    wasmInlineImported: wasmInlineImport.ok,
    wasmInlineUrl: sdkWasmInlineUrl,
  };

  const sdk = createInitializingSdkFacade(sdkImport.value, initOptions);
  const webcByteLoading = await attemptWebcByteLoading({
    environment,
    sdk,
    sdkWasmInlineUrl,
    wasmInlineImport,
  });

  const coreutils = await runStage("registry-coreutils-echo", () =>
    runRegistryCoreutilsEcho(sdk),
  );
  if (!coreutils.ok) {
    return blockedResult("registry-coreutils-echo", "coreutils_run_failed", {
      environment,
      webcByteLoading,
      blocker: coreutils.blocker,
    });
  }
  const coreutilsMismatch = coreutils.value.stdout !== "SDK_COREUTILS_OK\n" ||
    coreutils.value.stderr !== "" ||
    coreutils.value.exitCode !== 0;
  if (coreutilsMismatch) {
    return blockedResult("registry-coreutils-echo", "coreutils_mismatch", {
      coreutils: coreutils.value,
      environment,
      message: "registry coreutils echo did not match expected behavior",
      sdkLoad,
      webcByteLoading,
    });
  }

  const registry = await runStage("registry-bash-coreutils", () =>
    runRegistryBashCoreutils(sdk),
  );
  if (!registry.ok) {
    return blockedResult("registry-bash-coreutils", "registry_run_failed", {
      environment,
      coreutils: coreutils.value,
      sdkModuleUrl,
      sdkLoad,
      webcByteLoading,
      blocker: registry.blocker,
    });
  }

  const mismatches = exactMismatches(registry.value);
  if (mismatches.length > 0) {
    return blockedResult("behavior", "behavior_mismatch", {
      environment,
      coreutils: coreutils.value,
      mismatches,
      registry: registry.value,
      sdkLoad,
      webcByteLoading,
    });
  }

  return {
    blocked: false,
    coreutils: coreutils.value,
    environment,
    registry: registry.value,
    sdkLoad,
    sdkModuleUrl,
    sdkWasmInlineUrl,
    webcByteLoading,
  };
}

async function attemptWebcByteLoading(context) {
  const bytesStage = await runStage("webc-fetch", async () => {
    const response = await fetch(BASH_ARTIFACT.url);
    if (!response.ok) {
      throw new Error(`fetch failed ${response.status}: ${BASH_ARTIFACT.url}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const sha256 = await sha256Hex(bytes);
    return { bytes, sha256 };
  });
  if (!bytesStage.ok) {
    return {
      blocker: bytesStage.blocker,
      source: BASH_ARTIFACT,
      supported: false,
    };
  }
  if (bytesStage.value.sha256 !== BASH_ARTIFACT.sha256) {
    return {
      blocker: {
        kind: "artifact_hash_mismatch",
        message: `expected ${BASH_ARTIFACT.sha256}, got ${bytesStage.value.sha256}`,
        stage: "webc-fetch",
      },
      source: BASH_ARTIFACT,
      supported: false,
    };
  }

  const stdoutWriter = captureWriter();
  const stderrWriter = captureWriter();
  const executor = createWasmerSdkCommandExecutor({
    packageSource: { kind: "webc-bytes" },
    sdkLoader: async () => context.sdk,
  });
  const runStageResult = await runStage("webc-from-file", () =>
    executor.run(
      {
        args: ["--version"],
        command: "bash",
        env: { PATH: "/bin:/usr/bin" },
        package: {
          bytes: bytesStage.value.bytes,
          name: BASH_ARTIFACT.name,
          version: BASH_ARTIFACT.version,
        },
      },
      { stderr: stderrWriter, stdout: stdoutWriter },
    ),
  );

  if (!runStageResult.ok) {
    return {
      artifactSha256: bytesStage.value.sha256,
      blocker: runStageResult.blocker,
      loaded: false,
      source: BASH_ARTIFACT,
      supported: false,
    };
  }
  const stdout = stdoutWriter.text();
  const stderr = stderrWriter.text();
  return {
    artifactSha256: bytesStage.value.sha256,
    exitCode: runStageResult.value.exitCode,
    loaded: true,
    runnable:
      runStageResult.value.exitCode === 0 &&
      stderr === "" &&
      stdout.length > 0,
    source: BASH_ARTIFACT,
    stderr,
    stdout,
    supported:
      runStageResult.value.exitCode === 0 &&
      stderr === "" &&
      stdout.length > 0,
  };
}

async function runRegistryCoreutilsEcho(sdk) {
  const stdout = captureWriter();
  const stderr = captureWriter();
  const executor = createWasmerSdkCommandExecutor({
    packageSource: { kind: "registry" },
    sdkLoader: async () => sdk,
  });
  const result = await executor.run(
    {
      args: ["SDK_COREUTILS_OK"],
      command: "echo",
      package: COREUTILS_PACKAGE,
    },
    { stderr, stdout },
  );
  return {
    exitCode: result.exitCode,
    stderr: stderr.text(),
    stdout: stdout.text(),
  };
}

async function runRegistryBashCoreutils(sdk) {
  const stdout = captureWriter();
  const stderr = captureWriter();
  const executor = createWasmerSdkCommandExecutor({
    packageSource: { kind: "registry" },
    sdkLoader: async () => sdk,
  });
  const result = await executor.run(
    {
      args: ["-lc", SDK_PARITY_SCRIPT],
      command: "bash",
      cwd: "/workspace",
      env: { PATH: "/bin:/usr/bin" },
      package: {
        name: BASH_ARTIFACT.name,
        version: BASH_ARTIFACT.version,
      },
      uses: [COREUTILS_SPECIFIER],
      workspaceSnapshot: [{ contents: "seed\n", path: "/seed.txt" }],
    },
    { stderr, stdout },
  );
  return {
    exitCode: result.exitCode,
    stderr: stderr.text(),
    stdout: stdout.text(),
    stdoutBytes: result.stdoutBytes,
    workspaceSnapshot: serializeSnapshot(result.workspaceSnapshot),
  };
}

function exactMismatches(registry) {
  const mismatches = [];
  if (registry.stdout !== EXPECTED_STDOUT) {
    mismatches.push({
      actual: registry.stdout,
      expected: EXPECTED_STDOUT,
      field: "registry.stdout",
    });
  }
  if (registry.stderr !== EXPECTED_STDERR) {
    mismatches.push({
      actual: registry.stderr,
      expected: EXPECTED_STDERR,
      field: "registry.stderr",
    });
  }
  if (registry.exitCode !== 7) {
    mismatches.push({
      actual: registry.exitCode,
      expected: 7,
      field: "registry.exitCode",
    });
  }
  const output = registry.workspaceSnapshot.find(
    (entry) => entry.path === "/sdk-proof/output.txt",
  );
  if (output?.contents !== EXPECTED_WORKSPACE_OUTPUT) {
    mismatches.push({
      actual: output?.contents ?? null,
      expected: EXPECTED_WORKSPACE_OUTPUT,
      field: "workspace./sdk-proof/output.txt",
    });
  }
  return mismatches;
}

async function runStage(stage, callback) {
  try {
    const value = await withTimeout(callback(), STAGE_TIMEOUT_MS, stage);
    return { ok: true, value };
  } catch (error) {
    return {
      blocker: {
        kind: error?.kind ?? error?.name ?? "stage_error",
        message: error?.message ?? String(error),
        stage,
      },
      ok: false,
    };
  }
}

async function withTimeout(promise, timeoutMs, stage) {
  let timeout = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(`${stage} timed out after ${timeoutMs}ms`);
          error.kind = "stage_timeout";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function createInitializingSdkFacade(sdk, initOptions) {
  let initialized = false;
  return {
    Directory: sdk.Directory,
    Wasmer: sdk.Wasmer,
    async init() {
      if (!initialized && typeof sdk.init === "function") {
        initialized = true;
        await sdk.init(initOptions);
      }
    },
  };
}

function captureWriter() {
  const chunks = [];
  return {
    async write(chunk) {
      chunks.push(new Uint8Array(chunk));
    },
    text() {
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return textDecoder.decode(bytes);
    },
  };
}

function serializeSnapshot(snapshot) {
  return snapshot.map((entry) => ({
    contents: entry.bytes ? textDecoder.decode(entry.bytes) : "",
    path: entry.path,
    type: entry.type,
  }));
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function browserEnvironment() {
  return {
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    secureContext: globalThis.isSecureContext === true,
    sharedArrayBuffer: typeof globalThis.SharedArrayBuffer === "function",
  };
}

function blockedResult(stage, kind, details) {
  return {
    blocked: true,
    blocker: {
      kind,
      message: details.message ?? details.blocker?.message ?? kind,
      stage,
    },
    ...details,
  };
}

function queryParam(name, fallback) {
  const value = new URL(location.href).searchParams.get(name);
  return value && value.length > 0 ? value : fallback;
}

function setStatus(status) {
  window.__wasmHostWasmerSdkParityStatus = status;
  const output = document.querySelector("[data-status]");
  if (output) {
    output.textContent = JSON.stringify(status, null, 2);
  }
}

function serializeError(error) {
  return {
    kind: error?.kind ?? error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack ?? null,
  };
}
