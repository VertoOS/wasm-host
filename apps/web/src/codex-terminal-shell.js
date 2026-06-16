import {
  builtinCodexPackageSourceOptions,
  inlineCodexFetch,
} from "./package-source.js";
import { mountBrowserPackageTerminalShell } from "./package-source-ui.js";
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

export async function mountCodexPackageTerminalShell(options = {}) {
  return mountBrowserPackageTerminalShell(options);
}

export async function codexVersionTerminalShellOptions(options = {}) {
  return {
    ...(await builtinCodexPackageSourceOptions({
      ...options,
      codexFetchImpl: options.fetchImpl ?? inlineCodexFetch,
    })),
    createWorker: options.createWorker ?? createDefaultCommandWorker,
  };
}
