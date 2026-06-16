import { parentPort, workerData } from "node:worker_threads";

import { startBrowserCommandWorker } from "../src/command-worker-entry.js";

if (!parentPort) {
  throw new Error("command worker entry fixture requires parentPort");
}

startBrowserCommandWorker({
  gatewayEndpoint: workerData?.gatewayEndpoint,
  port: parentPort,
});
