import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Worker } from "node:worker_threads";

const decoder = new TextDecoder();

test("HTTP worker entry dispatches direct Fetch through worker messages", async () => {
  const server = await localHttpServer(async (_request, response) => {
    response.writeHead(209, { "Content-Type": "text/plain", "X-Mode": "direct" });
    response.end("direct-ok");
  });
  const worker = createHttpWorker();
  try {
    const result = await dispatchAndCollect(worker, {
      type: "http.dispatch",
      id: "direct-1",
      request: {
        method: "GET",
        url: `${server.url}/direct`,
        headers: [{ name: "x-test", value: "yes" }],
      },
    });

    assert.equal(result.complete.status, 209);
    assert.equal(headerValue(result.complete.headers, "content-type"), "text/plain");
    assert.equal(headerValue(result.complete.headers, "x-mode"), "direct");
    assert.equal(chunksText(result.bodyChunks), "direct-ok");
  } finally {
    await worker.terminate();
    await server.close();
  }
});

test("HTTP worker entry streams direct Fetch request bodies", async () => {
  let captured = null;
  const server = await localHttpServer(async (request, response) => {
    captured = {
      method: request.method,
      url: request.url,
      body: await readRequestText(request),
    };
    response.writeHead(210, { "Content-Type": "text/plain" });
    response.end("stream-ok");
  });
  const worker = createHttpWorker();
  try {
    const result = dispatchAndCollect(worker, {
      type: "http.dispatch",
      id: "direct-stream-1",
      request: {
        method: "POST",
        url: `${server.url}/stream`,
        headers: [{ name: "content-type", value: "text/plain" }],
        streamingBody: true,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    worker.postMessage({
      type: "http.request.body",
      id: "direct-stream-1",
      chunk: "hello ",
    });
    worker.postMessage({
      type: "http.request.body",
      id: "direct-stream-1",
      chunkBase64: "d29ybGQ=",
    });
    worker.postMessage({
      type: "http.request.body.end",
      id: "direct-stream-1",
    });

    const response = await result;
    assert.deepEqual(captured, {
      method: "POST",
      url: "/stream",
      body: "hello world",
    });
    assert.equal(response.complete.status, 210);
    assert.equal(chunksText(response.bodyChunks), "stream-ok");
  } finally {
    await worker.terminate();
    await server.close();
  }
});

test("HTTP worker entry dispatches gateway requests through worker messages", async () => {
  let captured = null;
  const server = await localHttpServer(async (request, response) => {
    captured = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: JSON.parse(await readRequestText(request)),
    };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        response: {
          status: 208,
          headers: [{ name: "x-gateway", value: "yes" }],
          body_chunks_base64: ["Z2F0ZXdheS0=", "b2s="],
        },
      }),
    );
  });
  const worker = createHttpWorker({ gatewayEndpoint: `${server.url}/bridge` });
  try {
    const result = await dispatchAndCollect(worker, {
      type: "http.dispatch",
      id: "gateway-1",
      transport: "gateway",
      request: {
        method: "POST",
        url: "https://example.test/api",
        headers: [{ name: "x-test", value: "yes" }],
        bodyBase64: "cGF5bG9hZA==",
      },
    });

    assert.equal(captured.method, "POST");
    assert.equal(captured.url, "/bridge");
    assert.equal(captured.headers["content-type"], "application/json");
    assert.deepEqual(captured.body, {
      schema: 1,
      id: "gateway-1",
      method: "POST",
      url: "https://example.test/api",
      headers: [{ name: "x-test", value: "yes" }],
      body_chunks_base64: ["cGF5bG9hZA=="],
    });
    assert.equal(result.complete.status, 208);
    assert.deepEqual(result.complete.headers, [
      { name: "x-gateway", value: "yes" },
    ]);
    assert.equal(chunksText(result.bodyChunks), "gateway-ok");
  } finally {
    await worker.terminate();
    await server.close();
  }
});

test("HTTP worker entry cancels in-flight direct Fetch requests", async () => {
  const server = await localHttpServer(async (_request, response) => {
    await new Promise((resolve) => _request.on("close", resolve));
    response.destroy();
  });
  const worker = createHttpWorker();
  try {
    const result = dispatchAndCollect(worker, {
      type: "http.dispatch",
      id: "cancel-1",
      request: {
        method: "GET",
        url: `${server.url}/slow`,
        headers: [],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    worker.postMessage({ type: "http.cancel", id: "cancel-1" });

    await assert.rejects(result, (error) => {
      assert.equal(error.kind, "cancelled");
      assert.equal(error.message, "HTTP request cancelled");
      return true;
    });
  } finally {
    await worker.terminate();
    await server.close();
  }
});

function createHttpWorker(workerData = {}) {
  return new Worker(
    new URL("../fixtures/http-worker-entry-fixture.js", import.meta.url),
    {
      type: "module",
      workerData,
    },
  );
}

function dispatchAndCollect(worker, message) {
  const bodyChunks = [];
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      if (event.id !== message.id) {
        return;
      }
      if (event.type === "http.response.body") {
        bodyChunks.push(event.chunk);
        return;
      }
      cleanup();
      if (event.type === "http.response.complete") {
        resolve({ bodyChunks, complete: event });
        return;
      }
      if (event.type === "http.response.error") {
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

async function localHttpServer(handler) {
  const server = createServer((request, response) => {
    void handler(request, response).catch((error) => {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(error.message);
    });
  });
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function readRequestText(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function chunksText(chunks) {
  return decoder.decode(concatChunks(chunks));
}

function headerValue(headers, name) {
  return headers.find((header) => header.name === name)?.value;
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
