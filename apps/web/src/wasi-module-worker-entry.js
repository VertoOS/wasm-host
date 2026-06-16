import { handleRawWasiModuleWorkerMessage } from "./wasi-module.js";

globalThis.addEventListener?.("message", (event) => {
  void handleRawWasiModuleWorkerMessage(event.data);
});
