const DEFAULT_RESPONSE_BODY_LIMIT = 16 * 1024 * 1024;
const GATEWAY_NDJSON_CONTENT_TYPE = "application/x-ndjson";
const GATEWAY_JSON_CONTENT_TYPE = "application/json";
const GATEWAY_SCHEMA_VERSION = 1;
const POLL_INTERVAL_MS = 5;

const GATEWAY_ERROR_KINDS = new Set([
  "invalid_request",
  "invalid_response",
  "unsupported_scheme",
  "gateway_unavailable",
  "auth_failure",
  "cors",
  "timeout",
  "cancelled",
  "transport",
  "response_too_large",
]);

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
      responseBodyLimit: request.responseBodyLimit ?? this.responseBodyLimit,
      streamUploads: this.streamUploads,
    });
    await startResponse(responseWriter, response.status, response.headers);
    for (const chunk of response.bodyChunks) {
      await writeResponseChunk(responseWriter, chunk);
    }
    await finishResponse(responseWriter, response.status, response.headers);
  }
}

export class GatewayFetchHttpTransport {
  constructor(options = {}) {
    if (!options.endpoint) {
      throw new HttpBridgeError(
        "invalid_request",
        "HTTP gateway endpoint is required",
      );
    }
    this.endpoint = options.endpoint;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.credentials = options.credentials ?? "same-origin";
    this.streamUploads = options.streamUploads ?? true;
    this.responseBodyLimit =
      options.responseBodyLimit ?? DEFAULT_RESPONSE_BODY_LIMIT;
    this.gatewayResponseLimit =
      options.gatewayResponseLimit ?? DEFAULT_RESPONSE_BODY_LIMIT;
  }

  async dispatch(request, responseWriter, cancellation) {
    await dispatchGatewayRequest(request, responseWriter, {
      cancellation,
      credentials: this.credentials,
      endpoint: this.endpoint,
      fetchImpl: this.fetchImpl,
      gatewayResponseLimit:
        request.gatewayResponseLimit ?? this.gatewayResponseLimit,
      responseBodyLimit: request.responseBodyLimit ?? this.responseBodyLimit,
      streamUploads: this.streamUploads,
    });
  }
}

export async function dispatchFetchRequest(request, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new HttpBridgeError("transport", "Fetch API is unavailable");
  }

  const abort = createAbortController(
    options.cancellation,
    options.timeoutMs ?? request.timeoutMs,
  );
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

export async function dispatchGatewayRequest(
  request,
  responseWriter,
  options = {},
) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new HttpBridgeError("transport", "Fetch API is unavailable");
  }
  if (!options.endpoint) {
    throw new HttpBridgeError(
      "invalid_request",
      "HTTP gateway endpoint is required",
    );
  }

  const abort = createAbortController(
    options.cancellation,
    options.timeoutMs ?? request.timeoutMs,
  );
  const cleanup = abort.cleanup;
  try {
    const streamingUpload = shouldStreamUpload(
      request.body,
      options.streamUploads ?? true,
    );
    const init = {
      method: "POST",
      headers: gatewayRequestHeaders(streamingUpload),
      signal: abort.controller.signal,
      credentials: options.credentials ?? "same-origin",
    };
    if (streamingUpload) {
      init.body = gatewayRequestReadableStream(
        request,
        abort.controller.signal,
      );
      init.duplex = "half";
    } else {
      init.body = JSON.stringify(await encodeGatewayWireRequest(request));
    }

    const response = await fetchImpl(options.endpoint, init);
    validateGatewayEndpointStatus(response.status);
    if (isGatewayStreamResponse(response.headers)) {
      await readGatewayStreamResponse(response, responseWriter, {
        gatewayResponseLimit:
          options.gatewayResponseLimit ?? DEFAULT_RESPONSE_BODY_LIMIT,
        responseBodyLimit:
          options.responseBodyLimit ?? DEFAULT_RESPONSE_BODY_LIMIT,
        signal: abort.controller.signal,
      });
      return;
    }

    const wireResponse = await readGatewayJsonResponse(response, {
      gatewayResponseLimit:
        options.gatewayResponseLimit ?? DEFAULT_RESPONSE_BODY_LIMIT,
      signal: abort.controller.signal,
    });
    await writeGatewayResponse(responseWriter, decodeGatewayWireResponse(wireResponse), {
      responseBodyLimit:
        options.responseBodyLimit ?? DEFAULT_RESPONSE_BODY_LIMIT,
    });
  } catch (error) {
    throw mapGatewayFetchError(error, abort.reason);
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

export async function encodeGatewayWireRequest(request) {
  const bodyChunks = await readRequestBodyChunks(request.body);
  return {
    schema: GATEWAY_SCHEMA_VERSION,
    id: request.id,
    method: request.method,
    url: request.url,
    headers: gatewayWireHeaders(request.headers),
    body_chunks_base64: bodyChunks.map(bytesToBase64),
  };
}

export function decodeGatewayWireResponse(wireResponse) {
  if (!wireResponse || typeof wireResponse !== "object") {
    throw new HttpBridgeError(
      "invalid_response",
      "HTTP gateway response must be a JSON object",
    );
  }
  if (typeof wireResponse.ok !== "boolean") {
    throw new HttpBridgeError(
      "invalid_response",
      "HTTP gateway response ok must be a boolean",
    );
  }
  if (!wireResponse.ok) {
    if (!wireResponse.error) {
      throw new HttpBridgeError(
        "invalid_response",
        "HTTP gateway error response is missing error",
      );
    }
    throw decodeGatewayWireError(wireResponse.error);
  }
  if (!wireResponse.response) {
    throw new HttpBridgeError(
      "invalid_response",
      "HTTP gateway success response is missing response",
    );
  }

  const response = wireResponse.response;
  const hasBody = response.body_base64 != null;
  const hasChunks = response.body_chunks_base64 != null;
  if (hasBody && hasChunks) {
    throw new HttpBridgeError(
      "invalid_response",
      "HTTP gateway response cannot include both body_base64 and body_chunks_base64",
    );
  }
  if (hasChunks && !Array.isArray(response.body_chunks_base64)) {
    throw new HttpBridgeError(
      "invalid_response",
      "HTTP gateway response body_chunks_base64 must be an array",
    );
  }

  return {
    status: validateGatewayResponseStatus(response.status),
    headers: gatewayWireHeaders(response.headers ?? []),
    bodyChunks: hasBody
      ? [base64ToBytes(response.body_base64)].filter((chunk) => chunk.length > 0)
      : hasChunks
        ? response.body_chunks_base64.map(base64ToBytes)
        : [],
  };
}

export async function readGatewayStreamResponse(
  response,
  responseWriter,
  options = {},
) {
  const frameLimit = options.gatewayResponseLimit ?? DEFAULT_RESPONSE_BODY_LIMIT;
  const responseBodyLimit =
    options.responseBodyLimit ?? DEFAULT_RESPONSE_BODY_LIMIT;
  let buffer = new Uint8Array();
  let completed = false;
  let responseHead = null;
  let responseBodyBytes = 0;

  const applyFrame = async (frame) => {
    if (completed) {
      throw new HttpBridgeError(
        "invalid_response",
        "HTTP gateway stream sent a frame after body_end",
      );
    }
    switch (frame.type) {
      case "response":
        if (responseHead) {
          throw new HttpBridgeError(
            "invalid_response",
            "HTTP gateway stream sent multiple response frames",
          );
        }
        responseHead = {
          status: validateGatewayResponseStatus(frame.status),
          headers: gatewayWireHeaders(frame.headers ?? []),
        };
        await startResponse(
          responseWriter,
          responseHead.status,
          responseHead.headers,
        );
        return;
      case "body_chunk": {
        if (!responseHead) {
          throw new HttpBridgeError(
            "invalid_response",
            "HTTP gateway stream body_chunk arrived before response",
          );
        }
        const chunk = base64ToBytes(frame.body_base64);
        responseBodyBytes = enforceResponseBodyLimit(
          responseBodyBytes,
          chunk,
          responseBodyLimit,
        );
        await writeResponseChunk(responseWriter, chunk);
        return;
      }
      case "body_end":
        if (!responseHead) {
          throw new HttpBridgeError(
            "invalid_response",
            "HTTP gateway stream body_end arrived before response",
          );
        }
        completed = true;
        return;
      case "error":
        throw decodeGatewayWireError(frame);
      default:
        throw new HttpBridgeError(
          "invalid_response",
          `unknown HTTP gateway stream frame type: ${String(frame.type)}`,
        );
    }
  };

  for await (const chunk of responseBodyChunks(response)) {
    if (options.signal?.aborted) {
      throw new DOMException("Fetch aborted", "AbortError");
    }
    buffer = appendBytes(buffer, chunk);
    if (buffer.length > frameLimit) {
      throw new HttpBridgeError(
        "response_too_large",
        "HTTP gateway stream frame exceeded bridge limit",
      );
    }
    while (true) {
      const newline = buffer.indexOf(10);
      if (newline === -1) {
        break;
      }
      let lineBytes = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (lineBytes.at(-1) === 13) {
        lineBytes = lineBytes.slice(0, -1);
      }
      if (isAsciiWhitespace(lineBytes)) {
        continue;
      }
      await applyFrame(parseGatewayStreamFrame(lineBytes));
    }
  }

  if (!isAsciiWhitespace(buffer)) {
    throw new HttpBridgeError(
      "invalid_response",
      "HTTP gateway stream ended with a partial frame",
    );
  }
  if (!completed) {
    throw new HttpBridgeError(
      "invalid_response",
      "HTTP gateway stream did not send body_end",
    );
  }
  await finishResponse(responseWriter, responseHead.status, responseHead.headers);
}

async function readGatewayJsonResponse(response, options) {
  const chunks = await readResponseBodyChunks(response, {
    limit: options.gatewayResponseLimit,
    signal: options.signal,
  });
  const bytes = concatChunks(chunks) ?? new Uint8Array();
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new HttpBridgeError(
      "invalid_response",
      `invalid HTTP gateway response JSON: ${error.message}`,
    );
  }
}

async function writeGatewayResponse(responseWriter, response, options) {
  let total = 0;
  await startResponse(responseWriter, response.status, response.headers);
  for (const chunk of response.bodyChunks) {
    total = enforceResponseBodyLimit(
      total,
      chunk,
      options.responseBodyLimit,
    );
    await writeResponseChunk(responseWriter, chunk);
  }
  await finishResponse(responseWriter, response.status, response.headers);
}

function gatewayRequestHeaders(streamingUpload) {
  const headers = new Headers();
  headers.set("accept", `${GATEWAY_JSON_CONTENT_TYPE}, ${GATEWAY_NDJSON_CONTENT_TYPE}`);
  headers.set(
    "content-type",
    streamingUpload ? GATEWAY_NDJSON_CONTENT_TYPE : GATEWAY_JSON_CONTENT_TYPE,
  );
  return headers;
}

function gatewayWireHeaders(headers = []) {
  if (!Array.isArray(headers)) {
    throw new HttpBridgeError(
      "invalid_response",
      "HTTP gateway headers must be an array",
    );
  }
  return headers.map((header) => {
    const name = String(header?.name ?? "").trim().toLowerCase();
    const value = String(header?.value ?? "").trim();
    if (!name) {
      throw new HttpBridgeError(
        "invalid_response",
        "HTTP gateway header names must be non-empty",
      );
    }
    return { name, value };
  });
}

function gatewayRequestReadableStream(request, signal) {
  const iterator = gatewayRequestBodyFrames(request, signal);
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

async function* gatewayRequestBodyFrames(request, signal) {
  yield encodeGatewayStreamFrame({
    type: "request",
    schema: GATEWAY_SCHEMA_VERSION,
    id: request.id,
    method: request.method,
    url: request.url,
    headers: gatewayWireHeaders(request.headers),
  });
  for await (const chunk of bodyReader(request.body)) {
    if (signal?.aborted) {
      throw new DOMException("Fetch aborted", "AbortError");
    }
    yield encodeGatewayStreamFrame({
      type: "body_chunk",
      body_base64: bytesToBase64(chunk),
    });
  }
  yield encodeGatewayStreamFrame({ type: "body_end" });
}

function encodeGatewayStreamFrame(frame) {
  return new TextEncoder().encode(`${JSON.stringify(frame)}\n`);
}

function parseGatewayStreamFrame(lineBytes) {
  const line = new TextDecoder().decode(lineBytes);
  try {
    const frame = JSON.parse(line);
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      throw new HttpBridgeError(
        "invalid_response",
        "HTTP gateway stream frame must be a JSON object",
      );
    }
    return frame;
  } catch (error) {
    if (error instanceof HttpBridgeError) {
      throw error;
    }
    throw new HttpBridgeError(
      "invalid_response",
      `invalid HTTP gateway stream frame: ${error.message}`,
    );
  }
}

function validateGatewayEndpointStatus(status) {
  if (status >= 200 && status <= 299) {
    return;
  }
  if (status === 401 || status === 403) {
    throw new HttpBridgeError(
      "auth_failure",
      "HTTP gateway authentication failed",
    );
  }
  if ([404, 502, 503, 504].includes(status)) {
    throw new HttpBridgeError(
      "gateway_unavailable",
      "HTTP gateway endpoint is unavailable",
    );
  }
  throw new HttpBridgeError(
    "transport",
    `HTTP gateway returned status ${status}`,
  );
}

function validateGatewayResponseStatus(status) {
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    return status;
  }
  throw new HttpBridgeError(
    "invalid_response",
    `HTTP response status must be between 100 and 599, got ${String(status)}`,
  );
}

function decodeGatewayWireError(error) {
  const kind = String(error?.kind ?? "");
  if (!GATEWAY_ERROR_KINDS.has(kind)) {
    throw new HttpBridgeError(
      "invalid_response",
      `unknown HTTP gateway error kind: ${kind}`,
    );
  }
  return new HttpBridgeError(kind, String(error?.message ?? ""));
}

function isGatewayStreamResponse(headers) {
  const contentType = headerValue(headers, "content-type");
  return contentType
    ?.split(";")
    .at(0)
    ?.trim()
    .toLowerCase() === GATEWAY_NDJSON_CONTENT_TYPE;
}

function headerValue(headers, name) {
  if (!headers) {
    return null;
  }
  if (typeof headers.get === "function") {
    return headers.get(name);
  }
  const entry = headers.find?.(
    (header) => header.name?.toLowerCase() === name.toLowerCase(),
  );
  return entry?.value ?? null;
}

function enforceResponseBodyLimit(total, chunk, limit) {
  const nextTotal = total + chunk.length;
  if (nextTotal > limit) {
    throw new HttpBridgeError(
      "response_too_large",
      `HTTP response body exceeded ${limit} bytes`,
    );
  }
  return nextTotal;
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

function mapGatewayFetchError(error, abortReason) {
  if (error instanceof HttpBridgeError) {
    return error;
  }
  if (abortReason === "timeout") {
    return new HttpBridgeError("timeout", "HTTP gateway request timed out");
  }
  if (abortReason === "cancelled" || error?.name === "AbortError") {
    return new HttpBridgeError("cancelled", "HTTP gateway request cancelled");
  }
  if (error instanceof TypeError) {
    return new HttpBridgeError(
      "gateway_unavailable",
      "HTTP gateway endpoint is unavailable",
    );
  }
  return new HttpBridgeError(
    "transport",
    "HTTP gateway endpoint transport failed",
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

async function startResponse(responseWriter, status, headers) {
  if (typeof responseWriter.start === "function") {
    return responseWriter.start(status, headers);
  }
  if (typeof responseWriter.startAsync === "function") {
    return responseWriter.startAsync(status, headers);
  }
  if (typeof responseWriter.start_async === "function") {
    return responseWriter.start_async(status, headers);
  }
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

function appendBytes(left, right) {
  if (left.length === 0) {
    return right;
  }
  if (right.length === 0) {
    return left;
  }
  const result = new Uint8Array(left.length + right.length);
  result.set(left, 0);
  result.set(right, left.length);
  return result;
}

function isAsciiWhitespace(bytes) {
  return bytes.every((byte) => byte === 9 || byte === 10 || byte === 13 || byte === 32);
}

function bytesToBase64(bytes) {
  const chunk = toUint8Array(bytes);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(chunk).toString("base64");
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < chunk.length; offset += chunkSize) {
    binary += String.fromCharCode(...chunk.slice(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  if (typeof value !== "string" || !isValidBase64(value)) {
    throw new HttpBridgeError(
      "invalid_response",
      "invalid gateway body base64",
    );
  }
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isValidBase64(value) {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
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
