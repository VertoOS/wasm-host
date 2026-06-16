import { createBrowserCommandWorkerRuntime } from "./command-worker.js";

export function startBrowserCommandWorker(options = {}) {
  const runtime = createBrowserCommandWorkerRuntime({
    ...options,
    port: options.port ?? globalThis,
  });
  runtime.start();
  return runtime;
}

export function isBrowserWorkerGlobal(scope = globalThis) {
  return (
    typeof WorkerGlobalScope !== "undefined" &&
    scope instanceof WorkerGlobalScope
  );
}

if (isBrowserWorkerGlobal()) {
  startBrowserCommandWorker();
}
