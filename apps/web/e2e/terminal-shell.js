import { mountCodexVersionTerminalShell } from "../src/codex-terminal-shell.js";

const root = document.getElementById("app");

mountCodexVersionTerminalShell({
  onStateChange: updateStatus,
  root,
})
  .then((controller) => {
    window.__wasmHostTerminalShellController = controller;
    window.__wasmHostTerminalShellStatus = {
      phase: controller.phase,
      status: "ready",
    };
  })
  .catch((error) => {
    window.__wasmHostTerminalShellStatus = failureStatus(error);
  });

window.addEventListener("beforeunload", () => {
  window.__wasmHostTerminalShellController?.destroy();
});

function updateStatus(state) {
  const output = document.querySelector("[data-terminal-output]");
  const columns = document.querySelector("[data-terminal-columns]");
  const rows = document.querySelector("[data-terminal-rows]");
  const status = {
    output: output?.textContent ?? "",
    phase: state.phase,
    result: state.result ?? null,
    size: {
      columns: columns?.value ?? null,
      rows: rows?.value ?? null,
    },
    status: state.phase,
  };
  if (state.phase === "complete") {
    if (
      status.output.startsWith("codex-cli ") &&
      state.result?.exitCode === 0
    ) {
      status.status = "passed";
    } else {
      status.status = "failed";
      status.error = {
        message: "terminal shell output did not match Codex version smoke",
      };
    }
  }
  if (state.phase === "error" || state.phase === "cancelled") {
    status.status = "failed";
    status.error = state.error ?? { message: state.status };
  }
  window.__wasmHostTerminalShellStatus = status;
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
