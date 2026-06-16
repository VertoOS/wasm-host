import { mountCodexVersionTerminalShell } from "./codex-terminal-shell.js";

const root = document.getElementById("app");

window.__wasmHostTerminalAppStatus = { status: "booting" };

mountCodexVersionTerminalShell({
  onStateChange(state) {
    window.__wasmHostTerminalAppStatus = {
      ...state,
      status: state.phase,
    };
  },
  root,
})
  .then((controller) => {
    window.__wasmHostTerminalApp = controller;
    window.__wasmHostTerminalAppStatus = {
      phase: controller.phase,
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
