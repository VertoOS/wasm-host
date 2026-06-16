import { parentPort } from "node:worker_threads";

const messageListeners = new Map();

globalThis.postMessage = (message) => {
  parentPort.postMessage(message);
};

globalThis.addEventListener = (type, listener) => {
  if (type !== "message") {
    return;
  }
  const wrapped = (data) => listener({ data });
  messageListeners.set(listener, wrapped);
  parentPort.on("message", wrapped);
};

globalThis.removeEventListener = (type, listener) => {
  if (type !== "message") {
    return;
  }
  const wrapped = messageListeners.get(listener);
  if (!wrapped) {
    return;
  }
  messageListeners.delete(listener);
  parentPort.off("message", wrapped);
};

await import("../src/wasi-module-worker-entry.js");
