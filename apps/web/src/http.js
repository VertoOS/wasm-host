const DEFAULT_RESPONSE_BODY_LIMIT = 16 * 1024 * 1024;
const POLL_INTERVAL_MS = 5;

export class HttpBridgeError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "HttpBridgeError";
    this.kind = kind;
  }
}

export class DirectFetchHttpTransport {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.credentials = options.credentials ?? "same-origin";
    this.streamUploads = options.streamUploads ?? true;
    this.responseBodyLimit =
      options.responseBodyLimit ?? DEFAULT_RESPONSE_BODY_LIMIT;
  }

  async dispatch(request, responseWriter, cancellation) {
    const response = await dispatchFetchRequest(request, {
      cancellation,
      credentials: this.credentials,
      fetchImpl: this.fetchImpl,
      responseBodyLimit: this.responseBodyLimit,
      streamUploads: this.streamUploads,
    });
    for (const chunk of response.bodyChunks) {
      await writeResponseChunk(responseWriter, chunk);
    }
    await finishResponse(responseWriter, response.status, response.headers);
  }
}

export async function dispatchFetchRequest(request, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new HttpBridgeError("transport", "Fetch API is unavailable");
  }

  const abort = createAbortController(options.cancellation, options.timeoutMs);
  const cleanup = abort.cleanup;
  try {
    const body = await requestBodyForFetch(request, {
      signal: abort.controller.signal,
      streamUploads: options.streamUploads ?? true,
    });
    const init = {
      method: request.method,
      headers: headersForFetch(request.headers),
      signal: abort.controller.signal,
      credentials: options.credentials ?? "same-origin",
    };
    if (body !== undefined) {
      init.body = body;
      if (isReadableStream(body)) {
        init.duplex = "half";
      }
    }

    const response = await fetchImpl(request.url, init);
    const bodyChunks = await readResponseBodyChunks(response, {
      limit: options.responseBodyLimit ?? DEFAULT_RESPONSE_BODY_LIMIT,
      signal: abort.controller.signal,
    });
    return {
      status: response.status,
      headers: headersFromFetch(response.headers),
      bodyChunks,
    };
  } catch (error) {
    throw mapFetchError(error, abort.reason);
  } finally {
    cleanup();
  }
}

export function headersForFetch(headers = []) {
  const result = new Headers();
  for (const header of headers) {
    result.append(header.name, header.value);
  }
  return result;
}

export function headersFromFetch(headers) {
  if (!headers) {
    return [];
  }
  return Array.from(headers.entries(), ([name, value]) => ({
    name: name.toLowerCase(),
    value,
  }));
}

export async function readRequestBodyChunks(body) {
  if (body == null) {
    return [];
  }
  if (body instanceof Uint8Array) {
    return body.length === 0 ? [] : [body];
  }
  if (body instanceof ArrayBuffer) {
    const chunk = new Uint8Array(body);
    return chunk.length === 0 ? [] : [chunk];
  }
  if (Array.isArray(body)) {
    return body.map(toUint8Array).filter((chunk) => chunk.length > 0);
  }
  if (hasBodyChunkReader(body)) {
    const chunks = [];
    while (true) {
      const chunk = await readNextBodyChunk(body);
      if (chunk == null) {
        return chunks;
      }
      const bytes = toUint8Array(chunk);
      if (bytes.length > 0) {
        chunks.push(bytes);
      }
    }
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of body) {
      const bytes = toUint8Array(chunk);
      if (bytes.length > 0) {
        chunks.push(bytes);
      }
    }
    return chunks;
  }
  return [toUint8Array(body)].filter((chunk) => chunk.length > 0);
}

export async function readResponseBodyChunks(response, options = {}) {
  const limit = options.limit ?? DEFAULT_RESPONSE_BODY_LIMIT;
  let total = 0;
  const chunks = [];
  for await (const chunk of responseBodyChunks(response)) {
    if (options.signal?.aborted) {
      throw new DOMException("Fetch aborted", "AbortError");
    }
    total += chunk.length;
    if (total > limit) {
      throw new HttpBridgeError(
        "response_too_large",
        `HTTP response body exceeded ${limit} bytes`,
      );
    }
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
  }
  return chunks;
}

async function requestBodyForFetch(request, options) {
  if (request.body == null) {
    return undefined;
  }
  if (shouldStreamUpload(request.body, options.streamUploads)) {
    return requestBodyReadableStream(request.body, options.signal);
  }
  const chunks = await readRequestBodyChunks(request.body);
  return concatChunks(chunks);
}

function requestBodyReadableStream(body, signal) {
  const iterator = bodyReader(body);
  return new ReadableStream({
    async pull(controller) {
      if (signal?.aborted) {
        controller.error(new DOMException("Fetch aborted", "AbortError"));
        return;
      }
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel() {
      if (typeof iterator.return === "function") {
        await iterator.return();
      }
    },
  });
}

async function* bodyReader(body) {
  if (hasBodyChunkReader(body)) {
    while (true) {
      const chunk = await readNextBodyChunk(body);
      if (chunk == null) {
        return;
      }
      const bytes = toUint8Array(chunk);
      if (bytes.length > 0) {
        yield bytes;
      }
    }
  } else if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) {
      const bytes = toUint8Array(chunk);
      if (bytes.length > 0) {
        yield bytes;
      }
    }
  } else {
    for (const chunk of await readRequestBodyChunks(body)) {
      yield chunk;
    }
  }
}

async function* responseBodyChunks(response) {
  if (!response.body) {
    return;
  }
  if (typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          return;
        }
        yield toUint8Array(value);
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  if (typeof response.body[Symbol.asyncIterator] === "function") {
    for await (const chunk of response.body) {
      yield toUint8Array(chunk);
    }
    return;
  }
  const buffer = await response.arrayBuffer();
  const chunk = new Uint8Array(buffer);
  if (chunk.length > 0) {
    yield chunk;
  }
}

function createAbortController(cancellation, timeoutMs) {
  const controller = new AbortController();
  let reason = null;
  const cleanupHandlers = [];

  const abort = (nextReason) => {
    if (!controller.signal.aborted) {
      reason = nextReason;
      controller.abort();
    }
  };

  const signal = cancellationSignal(cancellation);
  if (signal) {
    if (signal.aborted) {
      abort("cancelled");
    } else {
      const onAbort = () => abort("cancelled");
      signal.addEventListener("abort", onAbort, { once: true });
      cleanupHandlers.push(() => signal.removeEventListener("abort", onAbort));
    }
  }

  if (isCancellationObject(cancellation)) {
    const interval = setInterval(() => {
      if (isCancellationObjectCancelled(cancellation)) {
        abort("cancelled");
      }
    }, POLL_INTERVAL_MS);
    cleanupHandlers.push(() => clearInterval(interval));
  }

  if (timeoutMs != null) {
    const timeout = setTimeout(() => abort("timeout"), timeoutMs);
    cleanupHandlers.push(() => clearTimeout(timeout));
  }

  return {
    controller,
    get reason() {
      return reason;
    },
    cleanup() {
      for (const cleanup of cleanupHandlers) {
        cleanup();
      }
    },
  };
}

function mapFetchError(error, abortReason) {
  if (error instanceof HttpBridgeError) {
    return error;
  }
  if (abortReason === "timeout") {
    return new HttpBridgeError("timeout", "HTTP request exceeded wall time limit");
  }
  if (abortReason === "cancelled" || error?.name === "AbortError") {
    return new HttpBridgeError("cancelled", "HTTP request cancelled");
  }
  if (error instanceof TypeError) {
    return new HttpBridgeError(
      "cors",
      "Browser Fetch blocked or failed the request",
    );
  }
  return new HttpBridgeError(
    "transport",
    `Browser Fetch failed: ${error?.message ?? String(error)}`,
  );
}

function canStreamUploadBody(body) {
  return body != null && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer);
}

function shouldStreamUpload(body, enabled) {
  return (
    enabled &&
    typeof ReadableStream === "function" &&
    canStreamUploadBody(body) &&
    (hasBodyChunkReader(body) ||
      typeof body[Symbol.asyncIterator] === "function")
  );
}

async function writeResponseChunk(responseWriter, chunk) {
  if (typeof responseWriter.writeBodyChunk === "function") {
    return responseWriter.writeBodyChunk(chunk);
  }
  if (typeof responseWriter.writeBodyChunkAsync === "function") {
    return responseWriter.writeBodyChunkAsync(chunk);
  }
  if (typeof responseWriter.write_body_chunk_async === "function") {
    return responseWriter.write_body_chunk_async(chunk);
  }
  throw new HttpBridgeError(
    "transport",
    "HTTP bridge response writer does not support body chunks",
  );
}

async function finishResponse(responseWriter, status, headers) {
  const body = new Uint8Array();
  if (typeof responseWriter.finish === "function") {
    return responseWriter.finish(status, headers, body);
  }
  if (typeof responseWriter.finishAsync === "function") {
    return responseWriter.finishAsync(status, headers, body);
  }
  if (typeof responseWriter.finish_async === "function") {
    return responseWriter.finish_async(status, headers, body);
  }
  throw new HttpBridgeError(
    "transport",
    "HTTP bridge response writer does not support completion",
  );
}

function hasBodyChunkReader(body) {
  return (
    typeof body.readChunk === "function" ||
    typeof body.readChunkAsync === "function" ||
    typeof body.read_chunk_async === "function"
  );
}

function readNextBodyChunk(body) {
  if (typeof body.readChunk === "function") {
    return body.readChunk();
  }
  if (typeof body.readChunkAsync === "function") {
    return body.readChunkAsync();
  }
  return body.read_chunk_async();
}

function cancellationSignal(cancellation) {
  if (!cancellation) {
    return null;
  }
  if (typeof AbortSignal !== "undefined" && cancellation instanceof AbortSignal) {
    return cancellation;
  }
  if (
    typeof AbortSignal !== "undefined" &&
    cancellation.signal instanceof AbortSignal
  ) {
    return cancellation.signal;
  }
  return null;
}

function isCancellationObject(cancellation) {
  return (
    cancellation &&
    (typeof cancellation.isCancelled === "function" ||
      typeof cancellation.is_cancelled === "function" ||
      typeof cancellation.aborted === "boolean")
  );
}

function isCancellationObjectCancelled(cancellation) {
  return Boolean(
    cancellation.aborted ||
      cancellation.isCancelled?.() ||
      cancellation.is_cancelled?.(),
  );
}

function concatChunks(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body.length === 0 ? undefined : body;
}

function isReadableStream(value) {
  return typeof ReadableStream === "function" && value instanceof ReadableStream;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  throw new TypeError("HTTP body chunks must be bytes or strings");
}
