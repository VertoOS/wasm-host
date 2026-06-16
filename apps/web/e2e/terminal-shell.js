import { mountCodexPackageTerminalShell } from "../src/codex-terminal-shell.js";

const root = document.getElementById("app");
const state = {
  packageSource: null,
};

mountCodexPackageTerminalShell({
  onStateChange: updateStatus,
  onPackageStateChange: updatePackageStatus,
  root,
})
  .then((app) => {
    window.__wasmHostTerminalShellController = app;
    window.__wasmHostTerminalShellStatus = {
      packageSource: app.packageSources.state,
      phase: app.terminal.phase,
      status: "ready",
    };
  })
  .catch((error) => {
    window.__wasmHostTerminalShellStatus = failureStatus(error);
  });

window.addEventListener("beforeunload", () => {
  window.__wasmHostTerminalShellController?.destroy();
});

function updateStatus(terminalState) {
  const output = document.querySelector("[data-terminal-output]");
  const columns = document.querySelector("[data-terminal-columns]");
  const rows = document.querySelector("[data-terminal-rows]");
  const status = {
    output: output?.textContent ?? "",
    packageSource: window.__wasmHostTerminalShellStatus?.packageSource ?? null,
    phase: terminalState.phase,
    result: terminalState.result ?? null,
    size: {
      columns: columns?.value ?? null,
      rows: rows?.value ?? null,
    },
    status: terminalState.phase,
  };
  if (terminalState.phase === "complete") {
    if (
      (status.output.startsWith("codex-cli ") ||
        status.output.startsWith("BROWSER_SMOKE_OK")) &&
      terminalState.result?.exitCode === 0
    ) {
      status.status = "passed";
    } else {
      status.status = "failed";
      status.error = {
        message: "terminal shell output did not match Codex version smoke",
      };
    }
  }
  if (terminalState.phase === "error" || terminalState.phase === "cancelled") {
    status.status = "failed";
    status.error = terminalState.error ?? { message: terminalState.status };
  }
  window.__wasmHostTerminalShellStatus = status;
}

function updatePackageStatus(packageState) {
  state.packageSource = {
    error: packageState.error
      ? {
          message: packageState.error.message,
          name: packageState.error.name,
        }
      : null,
    metadata: packageState.metadata ?? null,
    phase: packageState.phase,
  };
  window.__wasmHostTerminalShellStatus = {
    ...(window.__wasmHostTerminalShellStatus ?? {}),
    packageSource: state.packageSource,
  };
}

function failureStatus(error) {
  return {
    error: {
      message: error?.message ?? String(error),
      name: error?.name ?? "Error",
      stack: error?.stack ?? null,
    },
    status: "failed",
  };
}
