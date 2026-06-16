import assert from "node:assert/strict";
import test from "node:test";

import { HttpBridgeError } from "../src/http.js";
import {
  HttpBridgeWorkerRuntime,
  createDefaultHttpTransports,
  createHttpBridgeWorkerRuntime,
} from "../src/http-worker.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("HttpBridgeWorkerRuntime dispatches requests and response events", async () => {
  const port = recordingPort();
  const seen = {};
  const transport = {
    async dispatch(request, writer, signal) {
      seen.request = request;
      seen.aborted = signal.aborted;
      await writer.writeBodyChunk(encoder.encode("hello "));
      await writer.writeBodyChunk(encoder.encode("worker"));
      await writer.finish(202, [{ name: "x-worker", value: "yes" }]);
    },
  };
  const runtime = createHttpBridgeWorkerRuntime({
    port,
    transports: { direct: transport },
  });

  await runtime.handleMessage({
    type: "http.dispatch",
    id: "request-1",
    request: {
      method: "POST",
      url: "https://example.test/worker",
      headers: [{ name: "X-Test", value: " yes " }],
      bodyChunksBase64: ["aGVsbG8=", "Ym9keQ=="],
      gatewayResponseLimit: 128,
      responseBodyLimit: 64,
      timeoutMs: 250,
    },
  });

  assert.equal(seen.aborted, false);
  assert.equal(seen.request.id, "request-1");
  assert.equal(seen.request.method, "POST");
  assert.equal(seen.request.url, "https://example.test/worker");
  assert.deepEqual(seen.request.headers, [{ name: "x-test", value: "yes" }]);
  assert.equal(chunksText(seen.request.body), "hellobody");
  assert.equal(seen.request.gatewayResponseLimit, 128);
  assert.equal(seen.request.responseBodyLimit, 64);
  assert.equal(seen.request.timeoutMs, 250);
  assert.deepEqual(port.messages, [
    {
      type: "http.response.body",
      id: "request-1",
      chunk: encoder.encode("hello "),
    },
    {
      type: "http.response.body",
      id: "request-1",
      chunk: encoder.encode("worker"),
    },
    {
      type: "http.response.complete",
      id: "request-1",
      status: 202,
      headers: [{ name: "x-worker", value: "yes" }],
      body: new Uint8Array(),
    },
  ]);
});

test("HttpBridgeWorkerRuntime selects configured transports", async () => {
  const port = recordingPort();
  const calls = [];
  const runtime = new HttpBridgeWorkerRuntime({
    port,
    defaultTransport: "direct",
    transports: {
      direct: recordingTransport("direct", calls),
      gateway: recordingTransport("gateway", calls),
    },
  });

  await runtime.handleMessage({
    type: "http.dispatch",
    id: "request-2",
    transport: "gateway",
    request: {
      method: "GET",
      url: "https://example.test/gateway",
      headers: [],
    },
  });

  assert.deepEqual(calls, ["gateway"]);
  assert.equal(port.messages.at(-1).type, "http.response.complete");
});

test("HttpBridgeWorkerRuntime normalizes transport errors", async () => {
  const port = recordingPort();
  const runtime = createHttpBridgeWorkerRuntime({
    port,
    transports: {
      direct: {
        async dispatch() {
          throw new HttpBridgeError("cors", "blocked by policy");
        },
      },
    },
  });

  await runtime.handleMessage({
    type: "http.dispatch",
    id: "request-3",
    request: {
      method: "GET",
      url: "https://example.test/error",
      headers: [],
    },
  });

  assert.deepEqual(port.messages, [
    {
      type: "http.response.error",
      id: "request-3",
      error: { kind: "cors", message: "blocked by policy" },
    },
  ]);

  await runtime.handleMessage({
    type: "http.dispatch",
    id: "request-4",
    transport: "missing",
    request: {
      method: "GET",
      url: "https://example.test/error",
      headers: [],
    },
  });

  assert.deepEqual(port.messages.at(-1), {
    type: "http.response.error",
    id: "request-4",
    error: {
      kind: "invalid_request",
      message: "unknown HTTP bridge transport: missing",
    },
  });
});

test("HttpBridgeWorkerRuntime cancels in-flight dispatches", async () => {
  const port = recordingPort();
  const runtime = createHttpBridgeWorkerRuntime({
    port,
    transports: {
      direct: {
        async dispatch(_request, _writer, signal) {
          await rejectOnAbort(signal);
        },
      },
    },
  });

  const dispatch = runtime.handleMessage({
    type: "http.dispatch",
    id: "request-5",
    request: {
      method: "GET",
      url: "https://example.test/cancel",
      headers: [],
    },
  });
  await tick();
  runtime.handleMessage({ type: "http.cancel", id: "request-5" });
  await dispatch;

  assert.deepEqual(port.messages, [
    {
      type: "http.response.error",
      id: "request-5",
      error: { kind: "cancelled", message: "HTTP request cancelled" },
    },
  ]);
  assert.equal(runtime.inFlight.size, 0);
});

test("HttpBridgeWorkerRuntime streams request body messages", async () => {
  const port = recordingPort();
  const seen = {};
  const runtime = createHttpBridgeWorkerRuntime({
    port,
    transports: {
      direct: {
        async dispatch(request, writer) {
          seen.bodyText = await asyncChunksText(request.body);
          await writer.finish(200, [{ name: "x-stream", value: "yes" }]);
        },
      },
    },
  });

  const dispatch = runtime.handleMessage({
    type: "http.dispatch",
    id: "stream-1",
    request: {
      method: "POST",
      url: "https://example.test/stream",
      headers: [],
      streamingBody: true,
    },
  });
  await tick();
  await runtime.handleMessage({
    type: "http.request.body",
    id: "stream-1",
    chunk: "hello ",
  });
  await runtime.handleMessage({
    type: "http.request.body",
    id: "stream-1",
    chunkBase64: "d29ybGQ=",
  });
  await runtime.handleMessage({ type: "http.request.body.end", id: "stream-1" });
  await dispatch;

  assert.equal(seen.bodyText, "hello world");
  assert.deepEqual(port.messages, [
    {
      type: "http.response.complete",
      id: "stream-1",
      status: 200,
      headers: [{ name: "x-stream", value: "yes" }],
      body: new Uint8Array(),
    },
  ]);
});

test("HttpBridgeWorkerRuntime propagates streaming body producer failures", async () => {
  const port = recordingPort();
  const runtime = createHttpBridgeWorkerRuntime({
    port,
    transports: {
      direct: {
        async dispatch(request) {
          await asyncChunksText(request.body);
        },
      },
    },
  });

  const dispatch = runtime.handleMessage({
    type: "http.dispatch",
    id: "stream-2",
    request: {
      method: "POST",
      url: "https://example.test/stream-error",
      headers: [],
      streamingBody: true,
    },
  });
  await tick();
  await runtime.handleMessage({
    type: "http.request.body.error",
    id: "stream-2",
    error: { kind: "transport", message: "producer failed" },
  });
  await dispatch;

  assert.deepEqual(port.messages, [
    {
      type: "http.response.error",
      id: "stream-2",
      error: { kind: "transport", message: "producer failed" },
    },
  ]);
});

test("HttpBridgeWorkerRuntime cancels pending streaming body readers", async () => {
  const port = recordingPort();
  const runtime = createHttpBridgeWorkerRuntime({
    port,
    transports: {
      direct: {
        async dispatch(request) {
          await asyncChunksText(request.body);
        },
      },
    },
  });

  const dispatch = runtime.handleMessage({
    type: "http.dispatch",
    id: "stream-3",
    request: {
      method: "POST",
      url: "https://example.test/stream-cancel",
      headers: [],
      streamingBody: true,
    },
  });
  await tick();
  await runtime.handleMessage({ type: "http.cancel", id: "stream-3" });
  await dispatch;

  assert.deepEqual(port.messages, [
    {
      type: "http.response.error",
      id: "stream-3",
      error: { kind: "cancelled", message: "HTTP request cancelled" },
    },
  ]);
});

test("HttpBridgeWorkerRuntime rejects unknown body stream messages", async () => {
  const port = recordingPort();
  const runtime = createHttpBridgeWorkerRuntime({
    port,
    transports: { direct: recordingTransport("direct", []) },
  });

  await runtime.handleMessage({
    type: "http.request.body",
    id: "missing-stream",
    chunk: "orphan",
  });

  assert.deepEqual(port.messages, [
    {
      type: "http.response.error",
      id: "missing-stream",
      error: {
        kind: "invalid_request",
        message: "unknown streaming HTTP request body",
      },
    },
  ]);
});

test("HttpBridgeWorkerRuntime rejects malformed body stream chunks once", async () => {
  const port = recordingPort();
  const runtime = createHttpBridgeWorkerRuntime({
    port,
    transports: {
      direct: {
        async dispatch(request) {
          await asyncChunksText(request.body);
        },
      },
    },
  });

  const dispatch = runtime.handleMessage({
    type: "http.dispatch",
    id: "stream-4",
    request: {
      method: "POST",
      url: "https://example.test/stream-invalid",
      headers: [],
      streamingBody: true,
    },
  });
  await tick();
  await runtime.handleMessage({
    type: "http.request.body",
    id: "stream-4",
    chunk: "bad",
    chunkBase64: "YmFk",
  });
  await dispatch;

  assert.deepEqual(port.messages, [
    {
      type: "http.response.error",
      id: "stream-4",
      error: {
        kind: "invalid_request",
        message: "HTTP request body messages must include exactly one chunk",
      },
    },
  ]);
});

test("HttpBridgeWorkerRuntime can attach to a worker-style port", async () => {
  const port = eventPort();
  const runtime = createHttpBridgeWorkerRuntime({
    port,
    transports: { direct: recordingTransport("direct", []) },
  });

  runtime.start();
  port.emit({
    type: "http.dispatch",
    id: "request-6",
    request: {
      method: "GET",
      url: "https://example.test/start",
      headers: [],
    },
  });
  await tick();
  runtime.stop();

  assert.equal(port.started, true);
  assert.equal(port.listenerCount(), 0);
  assert.equal(port.messages.at(-1).type, "http.response.complete");
});

test("createDefaultHttpTransports includes gateway when configured", () => {
  const transports = createDefaultHttpTransports({
    fetchImpl: async () => new Response(""),
    gatewayEndpoint: "https://gateway.example.test/bridge",
  });

  assert.equal(typeof transports.direct.dispatch, "function");
  assert.equal(typeof transports.gateway.dispatch, "function");
});

function recordingTransport(name, calls) {
  return {
    async dispatch(_request, writer) {
      calls.push(name);
      await writer.finish(204, [], new Uint8Array());
    },
  };
}

function recordingPort() {
  return {
    messages: [],
    postMessage(message) {
      this.messages.push(message);
    },
  };
}

function eventPort() {
  const listeners = new Set();
  return {
    messages: [],
    started: false,
    addEventListener(type, listener) {
      if (type === "message") {
        listeners.add(listener);
      }
    },
    removeEventListener(type, listener) {
      if (type === "message") {
        listeners.delete(listener);
      }
    },
    postMessage(message) {
      this.messages.push(message);
    },
    start() {
      this.started = true;
    },
    emit(data) {
      for (const listener of listeners) {
        listener({ data });
      }
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

function chunksText(chunks) {
  const bytes = concatChunks(chunks);
  return decoder.decode(bytes);
}

async function asyncChunksText(chunks) {
  const result = [];
  for await (const chunk of chunks) {
    result.push(chunk);
  }
  return chunksText(result);
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

function rejectOnAbort(signal) {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () =>
      reject(new HttpBridgeError("cancelled", "HTTP request cancelled"));
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
