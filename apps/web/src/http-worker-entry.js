import { createHttpBridgeWorkerRuntime } from "./http-worker.js";

export function startHttpBridgeWorker(options = {}) {
  const runtime = createHttpBridgeWorkerRuntime({
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
  startHttpBridgeWorker();
}
