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

test("HTTP worker entry enforces direct Fetch response body limits", async () => {
  const server = await localHttpServer(async (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("too-large");
  });
  const worker = createHttpWorker();
  try {
    await assert.rejects(
      dispatchAndCollect(worker, {
        type: "http.dispatch",
        id: "direct-limit-1",
        request: {
          method: "GET",
          url: `${server.url}/large`,
          headers: [],
          responseBodyLimit: 4,
        },
      }),
      (error) => {
        assert.equal(error.kind, "response_too_large");
        assert.equal(error.message, "HTTP response body exceeded 4 bytes");
        return true;
      },
    );
  } finally {
    await worker.terminate();
    await server.close();
  }
});

test("HTTP worker entry maps direct Fetch request timeouts", async () => {
  const server = await localHttpServer(async (_request, response) => {
    await delay(250);
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("late");
  });
  const worker = createHttpWorker();
  try {
    await assert.rejects(
      dispatchAndCollect(worker, {
        type: "http.dispatch",
        id: "direct-timeout-1",
        request: {
          method: "GET",
          url: `${server.url}/slow`,
          headers: [],
          timeoutMs: 25,
        },
      }),
      (error) => {
        assert.equal(error.kind, "timeout");
        assert.equal(error.message, "HTTP request exceeded wall time limit");
        return true;
      },
    );
  } finally {
    await worker.terminate();
    await server.close();
  }
});

test("HTTP worker entry maps direct Fetch failures to browser policy errors", async () => {
  const worker = createHttpWorker();
  try {
    await assert.rejects(
      dispatchAndCollect(worker, {
        type: "http.dispatch",
        id: "direct-fetch-failure-1",
        request: {
          method: "GET",
          url: await closedLocalHttpUrl("/closed"),
          headers: [],
        },
      }),
      (error) => {
        assert.equal(error.kind, "cors");
        assert.equal(error.message, "Browser Fetch blocked or failed the request");
        return true;
      },
    );
  } finally {
    await worker.terminate();
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

test("HTTP worker entry streams gateway request bodies", async () => {
  let captured = null;
  const server = await localHttpServer(async (request, response) => {
    captured = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      frames: ndjsonLines(await readRequestText(request)).map((line) =>
        JSON.parse(line),
      ),
    };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        response: {
          status: 211,
          headers: [{ name: "x-gateway", value: "upload" }],
          body_chunks_base64: ["Z2F0ZXdheS11cGxvYWQ="],
        },
      }),
    );
  });
  const worker = createHttpWorker({ gatewayEndpoint: `${server.url}/bridge` });
  try {
    const result = dispatchAndCollect(worker, {
      type: "http.dispatch",
      id: "gateway-stream-upload-1",
      transport: "gateway",
      request: {
        method: "PUT",
        url: "https://example.test/upload",
        headers: [{ name: "x-test", value: "yes" }],
        streamingBody: true,
      },
    });
    await delay(25);
    worker.postMessage({
      type: "http.request.body",
      id: "gateway-stream-upload-1",
      chunk: "hello ",
    });
    worker.postMessage({
      type: "http.request.body",
      id: "gateway-stream-upload-1",
      chunkBase64: "d29ybGQ=",
    });
    worker.postMessage({
      type: "http.request.body.end",
      id: "gateway-stream-upload-1",
    });

    const response = await result;
    assert.equal(captured.method, "POST");
    assert.equal(captured.url, "/bridge");
    assert.equal(captured.headers["content-type"], "application/x-ndjson");
    assert.deepEqual(captured.frames, [
      {
        type: "request",
        schema: 1,
        id: "gateway-stream-upload-1",
        method: "PUT",
        url: "https://example.test/upload",
        headers: [{ name: "x-test", value: "yes" }],
      },
      { type: "body_chunk", body_base64: "aGVsbG8g" },
      { type: "body_chunk", body_base64: "d29ybGQ=" },
      { type: "body_end" },
    ]);
    assert.equal(response.complete.status, 211);
    assert.deepEqual(response.complete.headers, [
      { name: "x-gateway", value: "upload" },
    ]);
    assert.equal(chunksText(response.bodyChunks), "gateway-upload");
  } finally {
    await worker.terminate();
    await server.close();
  }
});

test("HTTP worker entry streams gateway response frames", async () => {
  const server = await localHttpServer(async (_request, response) => {
    response.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
    });
    response.write(
      `${JSON.stringify({
        type: "response",
        status: 206,
        headers: [{ name: "X-Gateway", value: " stream " }],
      })}\n`,
    );
    response.write(
      `${JSON.stringify({ type: "body_chunk", body_base64: "c3RyZWFtLQ==" })}\n`,
    );
    response.write(
      `${JSON.stringify({ type: "body_chunk", body_base64: "b2s=" })}\n`,
    );
    response.end(`${JSON.stringify({ type: "body_end" })}\n`);
  });
  const worker = createHttpWorker({ gatewayEndpoint: `${server.url}/bridge` });
  try {
    const result = await dispatchAndCollect(worker, {
      type: "http.dispatch",
      id: "gateway-stream-response-1",
      transport: "gateway",
      request: {
        method: "GET",
        url: "https://example.test/stream",
        headers: [],
      },
    });

    assert.equal(result.complete.status, 206);
    assert.deepEqual(result.complete.headers, [
      { name: "x-gateway", value: "stream" },
    ]);
    assert.equal(chunksText(result.bodyChunks), "stream-ok");
  } finally {
    await worker.terminate();
    await server.close();
  }
});

test("HTTP worker entry maps gateway stream error frames", async () => {
  const server = await localHttpServer(async (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/x-ndjson" });
    response.end(
      `${JSON.stringify({
        type: "error",
        kind: "transport",
        message: "upstream connection reset",
      })}\n`,
    );
  });
  const worker = createHttpWorker({ gatewayEndpoint: `${server.url}/bridge` });
  try {
    await assert.rejects(
      dispatchAndCollect(worker, {
        type: "http.dispatch",
        id: "gateway-stream-error-1",
        transport: "gateway",
        request: {
          method: "GET",
          url: "https://example.test/error",
          headers: [],
        },
      }),
      (error) => {
        assert.equal(error.kind, "transport");
        assert.equal(error.message, "upstream connection reset");
        return true;
      },
    );
  } finally {
    await worker.terminate();
    await server.close();
  }
});

test("HTTP worker entry maps gateway unavailable failures", async () => {
  const worker = createHttpWorker({
    gatewayEndpoint: await closedLocalHttpUrl("/bridge"),
  });
  try {
    await assert.rejects(
      dispatchAndCollect(worker, {
        type: "http.dispatch",
        id: "gateway-unavailable-1",
        transport: "gateway",
        request: {
          method: "GET",
          url: "https://example.test/api",
          headers: [],
        },
      }),
      (error) => {
        assert.equal(error.kind, "gateway_unavailable");
        assert.equal(error.message, "HTTP gateway endpoint is unavailable");
        return true;
      },
    );
  } finally {
    await worker.terminate();
  }
});

test("HTTP worker entry maps invalid gateway responses", async () => {
  const server = await localHttpServer(async (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{");
  });
  const worker = createHttpWorker({ gatewayEndpoint: `${server.url}/bridge` });
  try {
    await assert.rejects(
      dispatchAndCollect(worker, {
        type: "http.dispatch",
        id: "gateway-invalid-1",
        transport: "gateway",
        request: {
          method: "GET",
          url: "https://example.test/api",
          headers: [],
        },
      }),
      (error) => {
        assert.equal(error.kind, "invalid_response");
        assert.match(error.message, /invalid HTTP gateway response JSON/);
        return true;
      },
    );
  } finally {
    await worker.terminate();
    await server.close();
  }
});

test("HTTP worker entry enforces gateway response body limits", async () => {
  const server = await localHttpServer(async (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        response: {
          status: 200,
          headers: [],
          body_chunks_base64: ["dG9vLWxhcmdl"],
        },
      }),
    );
  });
  const worker = createHttpWorker({ gatewayEndpoint: `${server.url}/bridge` });
  try {
    await assert.rejects(
      dispatchAndCollect(worker, {
        type: "http.dispatch",
        id: "gateway-limit-1",
        transport: "gateway",
        request: {
          method: "GET",
          url: "https://example.test/api",
          headers: [],
          responseBodyLimit: 4,
        },
      }),
      (error) => {
        assert.equal(error.kind, "response_too_large");
        assert.equal(error.message, "HTTP response body exceeded 4 bytes");
        return true;
      },
    );
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

async function closedLocalHttpUrl(path) {
  const server = await localHttpServer(async (_request, response) => {
    response.writeHead(500, { "Content-Type": "text/plain" });
    response.end("should be closed");
  });
  const url = `${server.url}${path}`;
  await server.close();
  return url;
}

function readRequestText(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ndjsonLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
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
