import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

const decoder = new TextDecoder();

test("command worker entry runs the browser smoke command across a worker boundary", async () => {
  const worker = createCommandWorker();
  try {
    const load = await dispatchAndCollect(worker, {
      type: "command.load",
      id: "load-smoke",
      package: { id: "smoke", type: "smoke", commands: ["smoke"] },
    });
    const run = await dispatchAndCollect(worker, {
      type: "command.run",
      id: "run-smoke",
      packageId: "smoke",
      command: "smoke",
      args: ["--version"],
      cwd: "/workspace",
    });

    assert.equal(load.loaded.packageId, "smoke");
    assert.equal(load.loaded.packageType, "smoke");
    assert.equal(chunksText(run.stdout), "BROWSER_SMOKE_OK\n");
    assert.deepEqual(run.complete.result, {
      cancelled: false,
      exitCode: 0,
      failureStage: null,
      stderrBytes: 0,
      stdoutBytes: 17,
      timedOut: false,
    });
  } finally {
    await worker.terminate();
  }
});

function createCommandWorker(workerData = {}) {
  return new Worker(
    new URL("../fixtures/command-worker-entry-fixture.js", import.meta.url),
    {
      type: "module",
      workerData,
    },
  );
}

function dispatchAndCollect(worker, message) {
  const stdout = [];
  const stderr = [];
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      if (event.id !== message.id) {
        return;
      }
      if (event.type === "command.stdout") {
        stdout.push(event.chunk);
        return;
      }
      if (event.type === "command.stderr") {
        stderr.push(event.chunk);
        return;
      }
      if (event.type === "command.started") {
        return;
      }
      cleanup();
      if (event.type === "command.loaded") {
        resolve({ loaded: event });
        return;
      }
      if (event.type === "command.complete") {
        resolve({ complete: event, stderr, stdout });
        return;
      }
      if (event.type === "command.error") {
        reject(Object.assign(new Error(event.error.message), event.error));
        return;
      }
      reject(new Error(`unexpected worker event: ${event.type}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.postMessage(message);
  });
}

function chunksText(chunks) {
  return decoder.decode(concatChunks(chunks));
}

function concatChunks(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
