import { createDefaultBrowserWorkspaceStore } from "../src/workspace.js";

const decoder = new TextDecoder();
const PATH_SHELL_SCRIPT = "pwd; ls /workspace; echo BASH_BROWSER_OK";
const WORKSPACE_SHELL_SCRIPT = [
  "set -eu",
  "export LC_ALL=C",
  "cd /workspace",
  "rm -rf issue-215-smoke",
  "mkdir issue-215-smoke",
  "printf 'alpha\\nbeta\\n' > issue-215-smoke/input.txt",
  "cat issue-215-smoke/input.txt",
  "ls issue-215-smoke",
  "rm issue-215-smoke/input.txt",
  "ls issue-215-smoke",
  "rm -r issue-215-smoke",
  "printf 'ISSUE_215_WORKSPACE_OK\\n'",
].join("; ");
const PATH_EXPECTED_STDOUT = "/workspace\nBASH_BROWSER_OK\n";
const WORKSPACE_EXPECTED_STDOUT =
  "alpha\nbeta\ninput.txt\nISSUE_215_WORKSPACE_OK\n";

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
  await resetBrowserWorkspace();
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
    assert(coreutilsLoad.commands.includes("cat"), "cat command should load");
    assert(coreutilsLoad.commands.includes("mkdir"), "mkdir command should load");
    assert(coreutilsLoad.commands.includes("rm"), "rm command should load");

    const pathRun = await dispatchAndCollect(
      worker,
      {
        type: "command.run",
        id: "run-bash-coreutils-path",
        packageId: "bash",
        command: "bash",
        args: ["-lc", PATH_SHELL_SCRIPT],
        diagnostics: { unsupportedWasixCalls: true },
        env: { PATH: "/bin:/usr/bin" },
        timeoutMs: 30000,
      },
    );
    assert(pathRun.complete, "PATH command should complete");

    const pathStdout = chunksText(pathRun.stdout);
    const pathStderr = chunksText(pathRun.stderr);
    const pathDiagnostics =
      pathRun.complete.result?.diagnostics?.unsupportedWasixCalls ?? [];

    assertEqual(pathStdout, PATH_EXPECTED_STDOUT);
    assertEqual(pathStderr, "");
    assertEqual(pathRun.complete.result?.exitCode, 0);
    assertEqual(pathRun.complete.result?.failureStage, null);
    assertEqual(diagnosticCount(pathDiagnostics, "process", "proc_fork"), 0);
    assertEqual(diagnosticCount(pathDiagnostics, "process", "proc_join"), 0);
    assertEqual(
      diagnosticCount(pathDiagnostics, "thread-event", "stack_restore"),
      0,
    );
    assertEqual(
      diagnosticCount(pathDiagnostics, "thread-event", "stack_checkpoint"),
      0,
    );
    assert(
      pathStdout.includes("BASH_BROWSER_OK"),
      "Bash should reach the PATH marker",
    );

    const workspaceRun = await dispatchAndCollect(
      worker,
      {
        type: "command.run",
        id: "run-bash-coreutils-workspace",
        packageId: "bash",
        command: "bash",
        args: ["-lc", WORKSPACE_SHELL_SCRIPT],
        diagnostics: { unsupportedWasixCalls: true },
        env: { PATH: "/bin:/usr/bin" },
        timeoutMs: 30000,
      },
    );
    assert(workspaceRun.complete, "workspace command should complete");

    const workspaceStdout = chunksText(workspaceRun.stdout);
    const workspaceStderr = chunksText(workspaceRun.stderr);
    const workspaceDiagnostics =
      workspaceRun.complete.result?.diagnostics?.unsupportedWasixCalls ?? [];

    assertEqual(workspaceStdout, WORKSPACE_EXPECTED_STDOUT);
    assertEqual(workspaceStderr, "");
    assertEqual(workspaceRun.complete.result?.exitCode, 0);
    assertEqual(workspaceRun.complete.result?.failureStage, null);
    assertEqual(
      diagnosticCount(workspaceDiagnostics, "process", "proc_fork"),
      0,
    );
    assertEqual(
      diagnosticCount(workspaceDiagnostics, "process", "proc_join"),
      0,
    );
    assertEqual(
      diagnosticCount(workspaceDiagnostics, "thread-event", "stack_restore"),
      0,
    );
    assert(
      workspaceStdout.includes("ISSUE_215_WORKSPACE_OK"),
      "Bash should reach the workspace marker",
    );

    return {
      artifacts: {
        bash: BASH_ARTIFACT,
        coreutils: COREUTILS_ARTIFACT,
      },
      blocked: false,
      blockerIssue: null,
      diagnostics: pathDiagnostics,
      loadedCommands: {
        bash: bashLoad.commands,
        coreutils: coreutilsLoad.commands,
      },
      result: pathRun.complete.result,
      stages: [
        {
          exitCode: pathRun.complete.result?.exitCode,
          name: "path-command",
          status: "passed",
          stdoutBytes: byteLength(pathStdout),
        },
        {
          exitCode: workspaceRun.complete.result?.exitCode,
          name: "workspace-files",
          status: "passed",
          stdoutBytes: byteLength(workspaceStdout),
        },
      ],
      stderr: pathStderr,
      stdout: pathStdout,
      targetCommand: ["bash", "-lc", PATH_SHELL_SCRIPT],
      workspaceWorkflow: {
        diagnostics: workspaceDiagnostics,
        result: workspaceRun.complete.result,
        stderr: workspaceStderr,
        stdout: workspaceStdout,
        targetCommand: ["bash", "-lc", WORKSPACE_SHELL_SCRIPT],
      },
    };
  } finally {
    worker.terminate();
  }
}

async function resetBrowserWorkspace() {
  const workspace = createDefaultBrowserWorkspaceStore();
  await workspace.importSnapshot({
    directories: [],
    files: [],
    root: "/workspace",
    version: 1,
  });
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

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
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
