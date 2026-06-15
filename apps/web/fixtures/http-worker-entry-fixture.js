import { parentPort, workerData } from "node:worker_threads";

import { startHttpBridgeWorker } from "../src/http-worker-entry.js";

if (!parentPort) {
  throw new Error("HTTP worker entry fixture requires parentPort");
}

startHttpBridgeWorker({
  gatewayEndpoint: workerData?.gatewayEndpoint,
  port: parentPort,
});
