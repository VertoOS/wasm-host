const decoder = new TextDecoder();
const TARGET_SHELL_SCRIPT = "pwd; ls /workspace; echo BASH_BROWSER_OK";

const BASH_ARTIFACT = {
  name: "wasmer/bash",
  version: "1.0.25",
  url: "https://cdn.wasmer.io/webcimages/059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1.webc",
  sha256: "059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1",
};

const COREUTILS_ARTIFACT = {
  name: "wasmer/coreutils",
  version: "1.0.25",
  url: "https://cdn.wasmer.io/webcimages/36ea48f185ca15fe8454b1defb6a11754659dbed6330549662b62874d509f95f.webc",
  sha256: "36ea48f185ca15fe8454b1defb6a11754659dbed6330549662b62874d509f95f",
};

export async function runBashCoreutilsSmoke() {
  const worker = new Worker(
    new URL("../src/command-worker-entry.js", import.meta.url),
    { name: "bash-coreutils-smoke", type: "module" },
  );
  try {
    const bashLoad = await loadWebc(worker, "bash", BASH_ARTIFACT);
    const coreutilsLoad = await loadWebc(
      worker,
      "coreutils",
      COREUTILS_ARTIFACT,
    );

    assertEqual(bashLoad.contentSha256, BASH_ARTIFACT.sha256);
    assertEqual(coreutilsLoad.contentSha256, COREUTILS_ARTIFACT.sha256);
    assert(bashLoad.commands.includes("bash"), "Bash command should load");
    assert(bashLoad.commands.includes("sh"), "sh command should load");
    assert(coreutilsLoad.commands.includes("ls"), "ls command should load");
    assert(coreutilsLoad.commands.includes("pwd"), "pwd command should load");
    assert(coreutilsLoad.commands.includes("echo"), "echo command should load");

    const run = await dispatchAndCollect(
      worker,
      {
        type: "command.run",
        id: "run-bash-coreutils-target",
        packageId: "bash",
        command: "bash",
        args: ["-lc", TARGET_SHELL_SCRIPT],
        diagnostics: { unsupportedWasixCalls: true },
        env: { PATH: "/bin:/usr/bin" },
        timeoutMs: 30000,
      },
    );
    assert(run.complete, "target command should complete");

    const stdout = chunksText(run.stdout);
    const stderr = chunksText(run.stderr);
    const diagnostics =
      run.complete.result?.diagnostics?.unsupportedWasixCalls ?? [];

    assertEqual(stdout, "/workspace\nBASH_BROWSER_OK\n");
    assertEqual(stderr, "");
    assertEqual(run.complete.result?.exitCode, 0);
    assertEqual(run.complete.result?.failureStage, null);
    assertEqual(diagnosticCount(diagnostics, "process", "proc_fork"), 0);
    assertEqual(diagnosticCount(diagnostics, "process", "proc_join"), 0);
    assertEqual(
      diagnosticCount(diagnostics, "thread-event", "stack_restore"),
      0,
    );
    assertEqual(
      diagnosticCount(diagnostics, "thread-event", "stack_checkpoint"),
      0,
    );
    assert(stdout.includes("BASH_BROWSER_OK"), "Bash should reach the marker");

    return {
      artifacts: {
        bash: BASH_ARTIFACT,
        coreutils: COREUTILS_ARTIFACT,
      },
      blocked: false,
      blockerIssue: null,
      diagnostics,
      loadedCommands: {
        bash: bashLoad.commands,
        coreutils: coreutilsLoad.commands,
      },
      result: run.complete.result,
      stderr,
      stdout,
      targetCommand: ["bash", "-lc", TARGET_SHELL_SCRIPT],
    };
  } finally {
    worker.terminate();
  }
}

async function loadWebc(worker, id, artifact) {
  const load = await dispatchAndCollect(worker, {
    type: "command.load",
    id: `load-${id}`,
    package: {
      expectedSha256: artifact.sha256,
      id,
      metadata: {
        packageName: artifact.name,
        packageVersion: artifact.version,
      },
      url: artifact.url,
    },
  });
  assertEqual(load.loaded.packageId, id);
  assertEqual(load.loaded.artifactKind, "webc-package");
  return load.loaded;
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
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

function diagnosticCount(diagnostics, group, name) {
  const entry = diagnostics.find(
    (item) => item.group === group && item.name === name,
  );
  return entry?.count ?? 0;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}
