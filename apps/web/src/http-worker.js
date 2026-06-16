import {
  DirectFetchHttpTransport,
  GatewayFetchHttpTransport,
  HttpBridgeError,
} from "./http.js";

const DEFAULT_TRANSPORT = "direct";

export class HttpBridgeWorkerRuntime {
  constructor(options = {}) {
    this.port = options.port ?? globalThis;
    this.defaultTransport = options.defaultTransport ?? DEFAULT_TRANSPORT;
    this.transports = options.transports ?? createDefaultHttpTransports(options);
    this.inFlight = new Map();
    this.listener = null;
    this.detach = null;
  }

  start() {
    if (this.listener) {
      return;
    }
    this.listener = (event) => {
      void this.handleMessage(event?.data ?? event);
    };

    if (typeof this.port.addEventListener === "function") {
      this.port.addEventListener("message", this.listener);
      this.port.start?.();
      this.detach = () => this.port.removeEventListener("message", this.listener);
      return;
    }
    if (typeof this.port.on === "function") {
      this.port.on("message", this.listener);
      this.detach = () => this.port.off?.("message", this.listener);
      return;
    }
    const previous = this.port.onmessage;
    this.port.onmessage = this.listener;
    this.detach = () => {
      if (this.port.onmessage === this.listener) {
        this.port.onmessage = previous ?? null;
      }
    };
  }

  stop() {
    this.detach?.();
    this.listener = null;
    this.detach = null;
    for (const record of this.inFlight.values()) {
      record.controller.abort();
      record.bodyStream?.cancel();
    }
    this.inFlight.clear();
  }

  async handleMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }
    switch (message.type) {
      case "http.dispatch":
        await this.dispatch(message);
        break;
      case "http.cancel":
        this.cancel(message.id);
        break;
      case "http.request.body":
        this.handleBodyChunk(message);
        break;
      case "http.request.body.end":
        this.handleBodyEnd(message);
        break;
      case "http.request.body.error":
        this.handleBodyError(message);
        break;
    }
  }

  cancel(id) {
    const record = this.inFlight.get(id);
    if (!record) {
      return;
    }
    record.controller.abort();
    record.bodyStream?.cancel();
  }

  async dispatch(message) {
    const id = message.id ?? message.request?.id;
    const controller = new AbortController();
    const bodyStream = streamingBodyRequested(message)
      ? new WorkerRequestBodyStream()
      : null;
    const record = { controller, bodyStream, reportedError: false };
    this.inFlight.set(id, record);
    try {
      const transport = this.resolveTransport(message.transport);
      await transport.dispatch(
        requestFromDispatchMessage(message, bodyStream),
        new WorkerResponseWriter(this.port, id),
        controller.signal,
      );
    } catch (error) {
      if (!record.reportedError) {
        postMessageToPort(this.port, {
          type: "http.response.error",
          id,
          error: normalizeBridgeError(error),
        });
      }
    } finally {
      this.inFlight.delete(id);
    }
  }

  handleBodyChunk(message) {
    const record = this.recordForBodyMessage(message);
    if (!record) {
      return;
    }
    try {
      record.bodyStream.push(bodyChunkFromMessage(message));
    } catch (error) {
      this.failBodyMessage(record, message.id, error);
    }
  }

  handleBodyEnd(message) {
    const record = this.recordForBodyMessage(message);
    if (!record) {
      return;
    }
    try {
      record.bodyStream.end();
    } catch (error) {
      this.failBodyMessage(record, message.id, error);
    }
  }

  handleBodyError(message) {
    const record = this.recordForBodyMessage(message);
    if (!record) {
      return;
    }
    this.failBodyMessage(record, message.id, errorFromBodyStreamMessage(message));
  }

  recordForBodyMessage(message) {
    const record = this.inFlight.get(message.id);
    if (record?.bodyStream) {
      return record;
    }
    postMessageToPort(this.port, {
      type: "http.response.error",
      id: message.id,
      error: {
        kind: "invalid_request",
        message: "unknown streaming HTTP request body",
      },
    });
    return null;
  }

  failBodyMessage(record, id, error) {
    record.reportedError = true;
    record.bodyStream.fail(error);
    record.controller.abort();
    postMessageToPort(this.port, {
      type: "http.response.error",
      id,
      error: normalizeBridgeError(error),
    });
  }

  resolveTransport(name) {
    const transportName = name ?? this.defaultTransport;
    const transport = this.transports[transportName];
    if (!transport) {
      throw new HttpBridgeError(
        "invalid_request",
        `unknown HTTP bridge transport: ${String(transportName)}`,
      );
    }
    return transport;
  }
}

export function createHttpBridgeWorkerRuntime(options = {}) {
  return new HttpBridgeWorkerRuntime(options);
}

export function createDefaultHttpTransports(options = {}) {
  const fetchOptions = {
    credentials: options.credentials,
    fetchImpl: options.fetchImpl,
    responseBodyLimit: options.responseBodyLimit,
    streamUploads: options.streamUploads,
  };
  const transports = {
    direct: new DirectFetchHttpTransport(fetchOptions),
  };

  const gateway = options.gateway ?? {};
  const endpoint = gateway.endpoint ?? options.gatewayEndpoint;
  if (endpoint) {
    transports.gateway = new GatewayFetchHttpTransport({
      ...fetchOptions,
      credentials: gateway.credentials ?? options.gatewayCredentials,
      endpoint,
      gatewayResponseLimit:
        gateway.gatewayResponseLimit ?? options.gatewayResponseLimit,
    });
  }

  return transports;
}

class WorkerResponseWriter {
  constructor(port, id) {
    this.port = port;
    this.id = id;
  }

  async writeBodyChunk(chunk) {
    postMessageToPort(this.port, {
      type: "http.response.body",
      id: this.id,
      chunk: toUint8Array(chunk),
    });
  }

  async finish(status, headers, body) {
    postMessageToPort(this.port, {
      type: "http.response.complete",
      id: this.id,
      status,
      headers: normalizeHeaders(headers),
      body: toUint8Array(body ?? new Uint8Array()),
    });
  }
}

class WorkerRequestBodyStream {
  constructor() {
    this.chunks = [];
    this.waiters = [];
    this.closed = false;
    this.error = null;
  }

  push(chunk) {
    if (this.closed) {
      throw new HttpBridgeError(
        "invalid_request",
        "HTTP request body stream is already closed",
      );
    }
    if (this.error) {
      throw this.error;
    }
    const bytes = toUint8Array(chunk);
    if (bytes.length === 0) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(bytes);
      return;
    }
    this.chunks.push(bytes);
  }

  end() {
    if (this.closed) {
      throw new HttpBridgeError(
        "invalid_request",
        "HTTP request body stream is already closed",
      );
    }
    this.closed = true;
    this.resolveWaiters(null);
  }

  fail(error) {
    if (this.error) {
      return;
    }
    this.error = normalizeStreamError(error);
    this.rejectWaiters(this.error);
  }

  cancel() {
    this.fail(new HttpBridgeError("cancelled", "HTTP request cancelled"));
  }

  readChunk() {
    if (this.chunks.length > 0) {
      return Promise.resolve(this.chunks.shift());
    }
    if (this.error) {
      return Promise.reject(this.error);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const chunk = await this.readChunk();
      if (chunk == null) {
        return;
      }
      yield chunk;
    }
  }

  resolveWaiters(value) {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.resolve(value);
    }
  }

  rejectWaiters(error) {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }
}

function requestFromDispatchMessage(message, bodyStream = null) {
  const request = message.request ?? {};
  return {
    id: request.id ?? message.id,
    method: request.method,
    url: request.url,
    headers: normalizeHeaders(request.headers ?? []),
    body: requestBodyFromMessage(request, bodyStream),
    gatewayResponseLimit:
      request.gatewayResponseLimit ?? message.gatewayResponseLimit,
    responseBodyLimit: request.responseBodyLimit ?? message.responseBodyLimit,
    timeoutMs: request.timeoutMs ?? message.timeoutMs,
  };
}

function requestBodyFromMessage(request, bodyStream = null) {
  if (bodyStream) {
    if (hasBufferedBody(request)) {
      throw new HttpBridgeError(
        "invalid_request",
        "streaming HTTP request bodies cannot include buffered body fields",
      );
    }
    return bodyStream;
  }
  if (request.body != null) {
    return toUint8Array(request.body);
  }
  if (request.bodyBase64 != null) {
    return base64ToBytes(request.bodyBase64);
  }
  if (Array.isArray(request.bodyChunks)) {
    return request.bodyChunks.map(toUint8Array);
  }
  if (Array.isArray(request.bodyChunksBase64)) {
    return request.bodyChunksBase64.map(base64ToBytes);
  }
  return null;
}

function streamingBodyRequested(message) {
  return message.streamingBody === true || message.request?.streamingBody === true;
}

function hasBufferedBody(request) {
  return (
    request.body != null ||
    request.bodyBase64 != null ||
    request.bodyChunks != null ||
    request.bodyChunksBase64 != null
  );
}

function bodyChunkFromMessage(message) {
  const hasChunk = message.chunk != null;
  const hasChunkBase64 = message.chunkBase64 != null;
  if (hasChunk === hasChunkBase64) {
    throw new HttpBridgeError(
      "invalid_request",
      "HTTP request body messages must include exactly one chunk",
    );
  }
  return hasChunk ? toUint8Array(message.chunk) : base64ToBytes(message.chunkBase64);
}

function errorFromBodyStreamMessage(message) {
  const error = message.error ?? {};
  const kind =
    typeof error.kind === "string" && error.kind.trim()
      ? error.kind.trim()
      : "transport";
  const text =
    typeof error.message === "string" && error.message
      ? error.message
      : "HTTP request body producer failed";
  return new HttpBridgeError(kind, text);
}

function normalizeStreamError(error) {
  if (error instanceof HttpBridgeError) {
    return error;
  }
  if (typeof error?.kind === "string") {
    return new HttpBridgeError(error.kind, String(error.message ?? ""));
  }
  return new HttpBridgeError(
    "transport",
    error?.message ?? "HTTP request body stream failed",
  );
}

function normalizeHeaders(headers) {
  if (!Array.isArray(headers)) {
    throw new HttpBridgeError(
      "invalid_request",
      "HTTP bridge headers must be an array",
    );
  }
  return headers.map((header) => {
    const name = String(header?.name ?? "").trim().toLowerCase();
    const value = String(header?.value ?? "").trim();
    if (!name) {
      throw new HttpBridgeError(
        "invalid_request",
        "HTTP bridge header names must be non-empty",
      );
    }
    return { name, value };
  });
}

function normalizeBridgeError(error) {
  if (error instanceof HttpBridgeError && error.kind) {
    return {
      kind: error.kind,
      message: error.message,
    };
  }
  if (typeof error?.kind === "string") {
    return {
      kind: error.kind,
      message: String(error.message ?? ""),
    };
  }
  return {
    kind: "transport",
    message: "HTTP bridge worker transport failed",
  };
}

function postMessageToPort(port, message) {
  if (typeof port.postMessage !== "function") {
    throw new HttpBridgeError(
      "transport",
      "HTTP bridge worker port does not support postMessage",
    );
  }
  port.postMessage(message);
}

function base64ToBytes(value) {
  if (typeof value !== "string" || !isValidBase64(value)) {
    throw new HttpBridgeError("invalid_request", "invalid HTTP body base64");
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
  throw new HttpBridgeError("invalid_request", "HTTP body chunks must be bytes");
}
