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
    for (const controller of this.inFlight.values()) {
      controller.abort();
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
    }
  }

  cancel(id) {
    this.inFlight.get(id)?.abort();
  }

  async dispatch(message) {
    const id = message.id ?? message.request?.id;
    const controller = new AbortController();
    this.inFlight.set(id, controller);
    try {
      const transport = this.resolveTransport(message.transport);
      await transport.dispatch(
        requestFromDispatchMessage(message),
        new WorkerResponseWriter(this.port, id),
        controller.signal,
      );
    } catch (error) {
      postMessageToPort(this.port, {
        type: "http.response.error",
        id,
        error: normalizeBridgeError(error),
      });
    } finally {
      this.inFlight.delete(id);
    }
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

function requestFromDispatchMessage(message) {
  const request = message.request ?? {};
  return {
    id: request.id ?? message.id,
    method: request.method,
    url: request.url,
    headers: normalizeHeaders(request.headers ?? []),
    body: requestBodyFromMessage(request),
    gatewayResponseLimit:
      request.gatewayResponseLimit ?? message.gatewayResponseLimit,
    responseBodyLimit: request.responseBodyLimit ?? message.responseBodyLimit,
    timeoutMs: request.timeoutMs ?? message.timeoutMs,
  };
}

function requestBodyFromMessage(request) {
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
