import {
  CODEX_VERSION_SMOKE_STDOUT_PREFIX,
  CODEX_VERSION_SMOKE_WASM,
  codexVersionSmokeManifest,
} from "../fixtures/codex-version-smoke-core.js";
import { fetchCodexArtifactBytes } from "./artifact-manifest.js";
import {
  createDefaultCommandWorker,
  mountBrowserTerminalShell,
} from "./terminal-ui.js";

export async function mountCodexVersionTerminalShell(options = {}) {
  const shellOptions = await codexVersionTerminalShellOptions(options);
  return mountBrowserTerminalShell({
    ...shellOptions,
    ...options,
  });
}

export async function codexVersionTerminalShellOptions(options = {}) {
  const manifest = await codexVersionSmokeManifest();
  const { artifactUrl, fixture } = await fetchCodexArtifactBytes(manifest, {
    fetchImpl: options.fetchImpl ?? inlineCodexArtifactFetch,
  });
  return {
    commandLabel: "codex --version",
    createWorker: options.createWorker ?? createDefaultCommandWorker,
    expected: {
      exitCode: fixture.expected.exitCode,
      stderr: fixture.expected.stderr,
      stdoutPrefix: CODEX_VERSION_SMOKE_STDOUT_PREFIX,
    },
    loadMessage: fixture.commandLoad,
    runMessage: fixture.commandRun,
    subtitle: `Loaded from ${artifactUrl}`,
    title: "wasm-host terminal",
  };
}

export async function inlineCodexArtifactFetch() {
  return new Response(CODEX_VERSION_SMOKE_WASM, {
    headers: {
      "Content-Length": String(CODEX_VERSION_SMOKE_WASM.byteLength),
    },
    status: 200,
  });
}
