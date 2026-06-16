import { mountCodexPackageTerminalShell } from "./codex-terminal-shell.js";

const root = document.getElementById("app");

window.__wasmHostTerminalAppStatus = { status: "booting" };

mountCodexPackageTerminalShell({
  onStateChange(state) {
    window.__wasmHostTerminalAppStatus = {
      ...(window.__wasmHostTerminalAppStatus ?? {}),
      ...state,
      status: state.phase,
    };
  },
  onPackageStateChange(state) {
    window.__wasmHostTerminalAppStatus = {
      ...(window.__wasmHostTerminalAppStatus ?? {}),
      packageSource: {
        error: state.error
          ? {
              message: state.error.message,
              name: state.error.name,
            }
          : null,
        metadata: state.metadata,
        phase: state.phase,
      },
    };
  },
  root,
})
  .then((app) => {
    window.__wasmHostTerminalApp = app;
    window.__wasmHostTerminalAppStatus = {
      packageSource: {
        metadata: app.packageSources.state.metadata,
        phase: app.packageSources.state.phase,
      },
      phase: app.terminal.phase,
      status: "ready",
    };
  })
  .catch((error) => {
    window.__wasmHostTerminalAppStatus = {
      error: {
        message: error?.message ?? String(error),
        name: error?.name ?? "Error",
        stack: error?.stack ?? null,
      },
      status: "failed",
    };
    root.textContent = error?.message ?? String(error);
  });

window.addEventListener("beforeunload", () => {
  window.__wasmHostTerminalApp?.destroy();
});
