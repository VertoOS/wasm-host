import assert from "node:assert/strict";
import test from "node:test";

import {
  DirectFetchHttpTransport,
  GatewayFetchHttpTransport,
  HttpBridgeError,
  dispatchFetchRequest,
  dispatchGatewayRequest,
  readRequestBodyChunks,
} from "../src/http.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("dispatchFetchRequest maps request and response bytes", async () => {
  const seen = {};
  const fetchImpl = async (url, init) => {
    seen.url = url;
    seen.method = init.method;
    seen.duplex = init.duplex;
    seen.headers = Array.from(init.headers.entries());
    seen.body = await readableBodyText(init.body);
    return new Response(readableStream(["hello ", "fetch"]), {
      status: 207,
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        "X-Reply": "yes",
      },
    });
  };

  const response = await dispatchFetchRequest(
    {
      id: 1,
      method: "POST",
      url: "https://example.test/api",
      headers: [{ name: "x-test", value: "yes" }],
      body: asyncChunks(["request-", "body"]),
    },
    { fetchImpl },
  );

  assert.equal(seen.url, "https://example.test/api");
  assert.equal(seen.method, "POST");
  assert.equal(seen.duplex, "half");
  assert.deepEqual(seen.headers, [["x-test", "yes"]]);
  assert.equal(seen.body, "request-body");
  assert.equal(response.status, 207);
  assert.deepEqual(response.headers, [
    { name: "content-type", value: "text/plain;charset=UTF-8" },
    { name: "x-reply", value: "yes" },
  ]);
  assert.equal(chunksText(response.bodyChunks), "hello fetch");
});

test("DirectFetchHttpTransport writes response chunks to bridge writer", async () => {
  const transport = new DirectFetchHttpTransport({
    fetchImpl: async () =>
      new Response(readableStream(["chunk-", "ok"]), {
        status: 200,
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          "X-Mode": "direct",
        },
      }),
  });
  const writer = recordingWriter();

  await transport.dispatch(
    {
      id: 2,
      method: "GET",
      url: "https://example.test/direct",
      headers: [],
      body: null,
    },
    writer,
    new AbortController().signal,
  );

  assert.equal(chunksText(writer.chunks), "chunk-ok");
  assert.equal(writer.finished.status, 200);
  assert.deepEqual(writer.finished.headers, [
    { name: "content-type", value: "text/plain;charset=UTF-8" },
    { name: "x-mode", value: "direct" },
  ]);
  assert.equal(writer.finished.body.length, 0);
});

test("DirectFetchHttpTransport accepts bridge-style writer methods", async () => {
  const transport = new DirectFetchHttpTransport({
    fetchImpl: async () => new Response(readableStream(["bridge-style"])),
  });
  const writer = {
    chunks: [],
    finished: null,
    async write_body_chunk_async(chunk) {
      this.chunks.push(chunk);
    },
    async finish_async(status, headers, body) {
      this.finished = { status, headers, body };
    },
  };

  await transport.dispatch(
    {
      id: 7,
      method: "GET",
      url: "https://example.test/direct",
      headers: [],
      body: null,
    },
    writer,
    new AbortController().signal,
  );

  assert.equal(chunksText(writer.chunks), "bridge-style");
  assert.equal(writer.finished.status, 200);
  assert.equal(writer.finished.body.length, 0);
});

test("DirectFetchHttpTransport honors per-request response body limits", async () => {
  const transport = new DirectFetchHttpTransport({
    fetchImpl: async () => new Response(readableStream(["too-large"])),
  });

  await assert.rejects(
    transport.dispatch(
      {
        id: 20,
        method: "GET",
        url: "https://example.test/large",
        headers: [],
        body: null,
        responseBodyLimit: 4,
      },
      recordingWriter(),
      new AbortController().signal,
    ),
    (error) => {
      assert.equal(error.kind, "response_too_large");
      assert.equal(error.message, "HTTP response body exceeded 4 bytes");
      return true;
    },
  );
});

test("DirectFetchHttpTransport honors per-request timeouts", async () => {
  const transport = new DirectFetchHttpTransport({
    fetchImpl: fetchThatWaitsForAbort,
  });

  await assert.rejects(
    transport.dispatch(
      {
        id: 22,
        method: "GET",
        url: "https://example.test/timeout",
        headers: [],
        body: null,
        timeoutMs: 1,
      },
      recordingWriter(),
      new AbortController().signal,
    ),
    (error) => {
      assert.equal(error.kind, "timeout");
      assert.equal(error.message, "HTTP request exceeded wall time limit");
      return true;
    },
  );
});

test("dispatchFetchRequest maps non-policy failures to transport errors", async () => {
  await assert.rejects(
    dispatchFetchRequest(
      {
        id: 23,
        method: "GET",
        url: "https://example.test/transport",
        headers: [],
        body: null,
      },
      {
        fetchImpl: async () => {
          throw new Error("socket exploded");
        },
      },
    ),
    (error) => {
      assert.equal(error.kind, "transport");
      assert.equal(error.message, "Browser Fetch failed: socket exploded");
      return true;
    },
  );
});

test("GatewayFetchHttpTransport maps buffered gateway requests and responses", async () => {
  const seen = {};
  const transport = new GatewayFetchHttpTransport({
    endpoint: "https://gateway.example.test/bridge",
    fetchImpl: async (url, init) => {
      seen.url = url;
      seen.method = init.method;
      seen.headers = Array.from(init.headers.entries());
      seen.body = JSON.parse(await readableBodyText(init.body));
      return jsonResponse({
        ok: true,
        response: {
          status: 201,
          headers: [{ name: "x-gateway", value: "yes" }],
          body_chunks_base64: ["Z2F0ZXdheS0=", "b2s="],
        },
      });
    },
  });
  const writer = recordingWriter();

  await transport.dispatch(
    {
      id: 8,
      method: "POST",
      url: "https://example.test/gateway",
      headers: [{ name: "x-test", value: "yes" }],
      body: encoder.encode("request-body"),
    },
    writer,
    new AbortController().signal,
  );

  assert.equal(seen.url, "https://gateway.example.test/bridge");
  assert.equal(seen.method, "POST");
  assert.deepEqual(seen.headers, [
    ["accept", "application/json, application/x-ndjson"],
    ["content-type", "application/json"],
  ]);
  assert.deepEqual(seen.body, {
    schema: 1,
    id: 8,
    method: "POST",
    url: "https://example.test/gateway",
    headers: [{ name: "x-test", value: "yes" }],
    body_chunks_base64: ["cmVxdWVzdC1ib2R5"],
  });
  assert.equal(chunksText(writer.chunks), "gateway-ok");
  assert.equal(writer.finished.status, 201);
  assert.deepEqual(writer.finished.headers, [
    { name: "x-gateway", value: "yes" },
  ]);
});

test("GatewayFetchHttpTransport streams upload frames", async () => {
  const seen = {};
  const transport = new GatewayFetchHttpTransport({
    endpoint: "https://gateway.example.test/bridge",
    fetchImpl: async (_url, init) => {
      seen.duplex = init.duplex;
      seen.headers = Array.from(init.headers.entries());
      seen.frames = ndjsonLines(await readableBodyText(init.body)).map((line) =>
        JSON.parse(line),
      );
      return jsonResponse({
        ok: true,
        response: { status: 204, headers: [], body_chunks_base64: [] },
      });
    },
  });
  const writer = recordingWriter();

  await transport.dispatch(
    {
      id: 9,
      method: "PUT",
      url: "https://example.test/upload",
      headers: [],
      body: asyncChunks(["stream-", "upload"]),
    },
    writer,
    new AbortController().signal,
  );

  assert.equal(seen.duplex, "half");
  assert.deepEqual(seen.headers, [
    ["accept", "application/json, application/x-ndjson"],
    ["content-type", "application/x-ndjson"],
  ]);
  assert.deepEqual(seen.frames, [
    {
      type: "request",
      schema: 1,
      id: 9,
      method: "PUT",
      url: "https://example.test/upload",
      headers: [],
    },
    { type: "body_chunk", body_base64: "c3RyZWFtLQ==" },
    { type: "body_chunk", body_base64: "dXBsb2Fk" },
    { type: "body_end" },
  ]);
  assert.equal(writer.finished.status, 204);
});

test("GatewayFetchHttpTransport streams gateway response frames", async () => {
  const transport = new GatewayFetchHttpTransport({
    endpoint: "https://gateway.example.test/bridge",
    fetchImpl: async () =>
      ndjsonResponse([
        {
          type: "response",
          status: 206,
          headers: [{ name: "x-gateway", value: "stream" }],
        },
        { type: "body_chunk", body_base64: "c3RyZWFtLQ==" },
        { type: "body_chunk", body_base64: "b2s=" },
        { type: "body_end" },
      ]),
  });
  const writer = recordingWriter();

  await transport.dispatch(
    {
      id: 10,
      method: "GET",
      url: "https://example.test/stream",
      headers: [],
      body: null,
    },
    writer,
    new AbortController().signal,
  );

  assert.equal(chunksText(writer.chunks), "stream-ok");
  assert.equal(writer.finished.status, 206);
  assert.deepEqual(writer.finished.headers, [
    { name: "x-gateway", value: "stream" },
  ]);
});

test("dispatchGatewayRequest maps gateway endpoint status failures", async () => {
  await assert.rejects(
    dispatchGatewayRequest(
      {
        id: 11,
        method: "GET",
        url: "https://example.test/auth",
        headers: [],
        body: null,
      },
      recordingWriter(),
      {
        endpoint: "https://gateway.example.test/bridge",
        fetchImpl: async () => new Response("", { status: 401 }),
      },
    ),
    (error) => {
      assert.equal(error.kind, "auth_failure");
      assert.equal(error.message, "HTTP gateway authentication failed");
      return true;
    },
  );

  await assert.rejects(
    dispatchGatewayRequest(
      {
        id: 12,
        method: "GET",
        url: "https://example.test/unavailable",
        headers: [],
        body: null,
      },
      recordingWriter(),
      {
        endpoint: "https://gateway.example.test/bridge",
        fetchImpl: async () => new Response("", { status: 503 }),
      },
    ),
    (error) => {
      assert.equal(error.kind, "gateway_unavailable");
      assert.equal(error.message, "HTTP gateway endpoint is unavailable");
      return true;
    },
  );
});

test("dispatchGatewayRequest maps gateway wire errors", async () => {
  await assert.rejects(
    dispatchGatewayRequest(
      {
        id: 13,
        method: "GET",
        url: "https://example.test/policy",
        headers: [],
        body: null,
      },
      recordingWriter(),
      {
        endpoint: "https://gateway.example.test/bridge",
        fetchImpl: async () =>
          jsonResponse({
            ok: false,
            error: {
              kind: "cors",
              message: "request blocked by gateway policy",
            },
          }),
      },
    ),
    (error) => {
      assert.equal(error.kind, "cors");
      assert.equal(error.message, "request blocked by gateway policy");
      return true;
    },
  );

  await assert.rejects(
    dispatchGatewayRequest(
      {
        id: 14,
        method: "GET",
        url: "https://example.test/upstream-auth",
        headers: [],
        body: null,
      },
      recordingWriter(),
      {
        endpoint: "https://gateway.example.test/bridge",
        fetchImpl: async () =>
          jsonResponse({
            ok: false,
            error: {
              kind: "auth_failure",
              message: "upstream authentication failed",
            },
          }),
      },
    ),
    (error) => {
      assert.equal(error.kind, "auth_failure");
      assert.equal(error.message, "upstream authentication failed");
      return true;
    },
  );
});

test("dispatchGatewayRequest rejects invalid gateway responses", async () => {
  await assert.rejects(
    dispatchGatewayRequest(
      {
        id: 15,
        method: "GET",
        url: "https://example.test/invalid",
        headers: [],
        body: null,
      },
      recordingWriter(),
      {
        endpoint: "https://gateway.example.test/bridge",
        fetchImpl: async () =>
          new Response("{", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
    ),
    (error) => {
      assert.equal(error.kind, "invalid_response");
      assert.match(error.message, /invalid HTTP gateway response JSON/);
      return true;
    },
  );

  await assert.rejects(
    dispatchGatewayRequest(
      {
        id: 20,
        method: "GET",
        url: "https://example.test/invalid-chunks",
        headers: [],
        body: null,
      },
      recordingWriter(),
      {
        endpoint: "https://gateway.example.test/bridge",
        fetchImpl: async () =>
          jsonResponse({
            ok: true,
            response: {
              status: 200,
              headers: [],
              body_chunks_base64: "not-an-array",
            },
          }),
      },
    ),
    (error) => {
      assert.equal(error.kind, "invalid_response");
      assert.equal(
        error.message,
        "HTTP gateway response body_chunks_base64 must be an array",
      );
      return true;
    },
  );

  await assert.rejects(
    dispatchGatewayRequest(
      {
        id: 21,
        method: "GET",
        url: "https://example.test/invalid-ok",
        headers: [],
        body: null,
      },
      recordingWriter(),
      {
        endpoint: "https://gateway.example.test/bridge",
        fetchImpl: async () => jsonResponse({ ok: "yes", response: {} }),
      },
    ),
    (error) => {
      assert.equal(error.kind, "invalid_response");
      assert.equal(error.message, "HTTP gateway response ok must be a boolean");
      return true;
    },
  );
});

test("dispatchGatewayRequest enforces streamed gateway response body limits", async () => {
  await assert.rejects(
    dispatchGatewayRequest(
      {
        id: 16,
        method: "GET",
        url: "https://example.test/large",
        headers: [],
        body: null,
      },
      recordingWriter(),
      {
        endpoint: "https://gateway.example.test/bridge",
        fetchImpl: async () =>
          ndjsonResponse([
            { type: "response", status: 200, headers: [] },
            { type: "body_chunk", body_base64: "dG9vLWxhcmdl" },
            { type: "body_end" },
          ]),
        responseBodyLimit: 4,
      },
    ),
    (error) => {
      assert.equal(error.kind, "response_too_large");
      assert.equal(error.message, "HTTP response body exceeded 4 bytes");
      return true;
    },
  );
});

test("dispatchGatewayRequest maps timeout and cancellation", async () => {
  await assert.rejects(
    dispatchGatewayRequest(
      {
        id: 17,
        method: "GET",
        url: "https://example.test/timeout",
        headers: [],
        body: null,
      },
      recordingWriter(),
      {
        endpoint: "https://gateway.example.test/bridge",
        fetchImpl: fetchThatWaitsForAbort,
        timeoutMs: 1,
      },
    ),
    (error) => {
      assert.equal(error.kind, "timeout");
      assert.equal(error.message, "HTTP gateway request timed out");
      return true;
    },
  );

  const cancellation = new AbortController();
  const request = dispatchGatewayRequest(
    {
      id: 18,
      method: "GET",
      url: "https://example.test/cancel",
      headers: [],
      body: null,
    },
    recordingWriter(),
    {
      cancellation: cancellation.signal,
      endpoint: "https://gateway.example.test/bridge",
      fetchImpl: fetchThatWaitsForAbort,
    },
  );
  cancellation.abort();

  await assert.rejects(request, (error) => {
    assert.equal(error.kind, "cancelled");
    assert.equal(error.message, "HTTP gateway request cancelled");
    return true;
  });
});

test("dispatchGatewayRequest hides gateway endpoint details on fetch failure", async () => {
  const endpoint = "https://gateway.example.test/bridge?token=secret";
  await assert.rejects(
    dispatchGatewayRequest(
      {
        id: 19,
        method: "GET",
        url: "https://api.example.test/data?key=secret",
        headers: [{ name: "authorization", value: "Bearer secret" }],
        body: null,
      },
      recordingWriter(),
      {
        endpoint,
        fetchImpl: async () => {
          throw new TypeError(`Failed to fetch ${endpoint}`);
        },
      },
    ),
    (error) => {
      assert.equal(error.kind, "gateway_unavailable");
      assert.equal(error.message, "HTTP gateway endpoint is unavailable");
      assert.doesNotMatch(error.message, /secret|gateway\.example|api\.example/);
      return true;
    },
  );
});

test("dispatchFetchRequest enforces response body limit", async () => {
  await assert.rejects(
    dispatchFetchRequest(
      {
        id: 3,
        method: "GET",
        url: "https://example.test/large",
        headers: [],
        body: null,
      },
      {
        fetchImpl: async () => new Response(readableStream(["too-large"])),
        responseBodyLimit: 4,
      },
    ),
    (error) => {
      assert.equal(error.kind, "response_too_large");
      assert.equal(error.message, "HTTP response body exceeded 4 bytes");
      return true;
    },
  );
});

test("dispatchFetchRequest maps browser fetch TypeError to cors", async () => {
  await assert.rejects(
    dispatchFetchRequest(
      {
        id: 4,
        method: "GET",
        url: "https://blocked.example.test/",
        headers: [],
        body: null,
      },
      {
        fetchImpl: async () => {
          throw new TypeError("Failed to fetch");
        },
      },
    ),
    (error) => {
      assert.equal(error.kind, "cors");
      assert.equal(error.message, "Browser Fetch blocked or failed the request");
      return true;
    },
  );
});

test("dispatchFetchRequest maps timeout aborts", async () => {
  await assert.rejects(
    dispatchFetchRequest(
      {
        id: 5,
        method: "GET",
        url: "https://example.test/slow",
        headers: [],
        body: null,
      },
      {
        fetchImpl: fetchThatWaitsForAbort,
        timeoutMs: 1,
      },
    ),
    (error) => {
      assert.equal(error.kind, "timeout");
      assert.equal(error.message, "HTTP request exceeded wall time limit");
      return true;
    },
  );
});

test("dispatchFetchRequest maps caller cancellation", async () => {
  const cancellation = new AbortController();
  const request = dispatchFetchRequest(
    {
      id: 6,
      method: "GET",
      url: "https://example.test/cancel",
      headers: [],
      body: null,
    },
    {
      cancellation: cancellation.signal,
      fetchImpl: fetchThatWaitsForAbort,
    },
  );
  cancellation.abort();

  await assert.rejects(request, (error) => {
    assert.equal(error.kind, "cancelled");
    assert.equal(error.message, "HTTP request cancelled");
    return true;
  });
});

test("readRequestBodyChunks accepts readChunk-style bodies", async () => {
  const chunks = ["hello", " ", "body"];
  const body = {
    async readChunk() {
      return chunks.length === 0 ? null : encoder.encode(chunks.shift());
    },
  };

  assert.equal(chunksText(await readRequestBodyChunks(body)), "hello body");
});

test("readRequestBodyChunks accepts bridge-style async body readers", async () => {
  const chunks = ["bridge", "-", "body"];
  const body = {
    async read_chunk_async() {
      return chunks.length === 0 ? null : encoder.encode(chunks.shift());
    },
  };

  assert.equal(chunksText(await readRequestBodyChunks(body)), "bridge-body");
});

function readableStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

function ndjsonResponse(frames) {
  return new Response(
    readableStream(frames.map((frame) => `${JSON.stringify(frame)}\n`)),
    {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    },
  );
}

function ndjsonLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function* asyncChunks(chunks) {
  for (const chunk of chunks) {
    yield encoder.encode(chunk);
  }
}

async function readableBodyText(body) {
  if (body == null) {
    return "";
  }
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  return decoder.decode(bytes);
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

function recordingWriter() {
  return {
    chunks: [],
    finished: null,
    async writeBodyChunk(chunk) {
      this.chunks.push(chunk);
    },
    async finish(status, headers, body) {
      this.finished = { status, headers, body };
    },
  };
}

function fetchThatWaitsForAbort(_url, init) {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () => reject(new DOMException("aborted", "AbortError"));
    if (init.signal.aborted) {
      rejectAbort();
      return;
    }
    init.signal.addEventListener(
      "abort",
      rejectAbort,
      { once: true },
    );
  });
}

test("HttpBridgeError carries bridge kind", () => {
  const error = new HttpBridgeError("transport", "failed");
  assert.equal(error.name, "HttpBridgeError");
  assert.equal(error.kind, "transport");
  assert.equal(error.message, "failed");
});
