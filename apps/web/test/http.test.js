import assert from "node:assert/strict";
import test from "node:test";

import {
  DirectFetchHttpTransport,
  HttpBridgeError,
  dispatchFetchRequest,
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
