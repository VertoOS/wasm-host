import { parentPort, workerData } from "node:worker_threads";

import { startBrowserCommandWorker } from "../src/command-worker-entry.js";
import { createMemorySecretProvider } from "../src/secrets.js";

if (!parentPort) {
  throw new Error("command worker entry fixture requires parentPort");
}

startBrowserCommandWorker({
  codexBrowser: workerData?.codexBrowserSecrets
    ? {
        secretProvider: createMemorySecretProvider(workerData.codexBrowserSecrets),
      }
    : undefined,
  gatewayEndpoint: workerData?.gatewayEndpoint,
  port: parentPort,
});
