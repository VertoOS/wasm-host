import { createBrowserCodexAppServerRuntime } from "./app-server.js";

const JSONRPC_VERSION = "2.0";
export const LOOPBACK_SOCKET_CONNECTING = 0;
export const LOOPBACK_SOCKET_OPEN = 1;
export const LOOPBACK_SOCKET_CLOSING = 2;
export const LOOPBACK_SOCKET_CLOSED = 3;
const NORMAL_CLOSE = 1000;
const DEFAULT_WAIT_TIMEOUT_MS = 5000;

const SOCKET_CONNECTING = LOOPBACK_SOCKET_CONNECTING;
const SOCKET_OPEN = LOOPBACK_SOCKET_OPEN;
const SOCKET_CLOSING = LOOPBACK_SOCKET_CLOSING;
const SOCKET_CLOSED = LOOPBACK_SOCKET_CLOSED;

export class BrowserCodexAppServerTransportError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "BrowserCodexAppServerTransportError";
    this.code = options.code ?? "transport_error";
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export class BrowserCodexAppServerJsonRpcError extends Error {
  constructor(error) {
    super(error?.message ?? "browser app-server JSON-RPC request failed");
    this.name = "BrowserCodexAppServerJsonRpcError";
    this.code = error?.code;
    this.data = error?.data;
    this.rpcError = error;
  }
}

export class BrowserCodexAppServerLoopbackSocket {
  constructor(options = {}) {
    const {
      runtime = createBrowserCodexAppServerRuntime(options.runtimeOptions),
      url = "browser-codex-app-server://loopback",
    } = options;
    if (!runtime || typeof runtime.handleMessage !== "function") {
      throw new BrowserCodexAppServerTransportError(
        "browser app-server loopback socket requires a runtime",
        { code: "invalid_runtime" },
      );
    }

    this.CONNECTING = SOCKET_CONNECTING;
    this.OPEN = SOCKET_OPEN;
    this.CLOSING = SOCKET_CLOSING;
    this.CLOSED = SOCKET_CLOSED;
    this.binaryType = "blob";
    this.bufferedAmount = 0;
    this.extensions = "";
    this.protocol = "jsonrpc";
    this.readyState = SOCKET_OPEN;
    this.runtime = runtime;
    this.url = url;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
    this.onopen = null;
    this._dispatchQueue = Promise.resolve();
    this._eventListeners = new Map();

    enqueueMicrotask(() => {
      if (this.readyState === SOCKET_OPEN) {
        emitEvent(this, "open");
      }
    });
  }

  addEventListener(type, listener, options = {}) {
    addEventListener(this, type, listener, options);
  }

  removeEventListener(type, listener) {
    removeEventListener(this, type, listener);
  }

  send(data) {
    if (this.readyState !== SOCKET_OPEN) {
      throw new BrowserCodexAppServerTransportError(
        "browser app-server loopback socket is not open",
        { code: "closed" },
      );
    }

    this._dispatchQueue = this._dispatchQueue
      .then(() => this._dispatch(data))
      .catch((error) => {
        emitEvent(this, "error", {
          error,
          message: error?.message ?? String(error),
        });
      });
  }

  async drain() {
    await this._dispatchQueue;
  }

  close(code = NORMAL_CLOSE, reason = "") {
    if (
      this.readyState === SOCKET_CLOSING ||
      this.readyState === SOCKET_CLOSED
    ) {
      return;
    }

    this.readyState = SOCKET_CLOSING;
    enqueueMicrotask(() => {
      if (this.readyState === SOCKET_CLOSED) {
        return;
      }
      this.readyState = SOCKET_CLOSED;
      emitEvent(this, "close", {
        code,
        reason: String(reason ?? ""),
        wasClean: true,
      });
    });
  }

  async _dispatch(data) {
    if (this.readyState !== SOCKET_OPEN) {
      return;
    }

    const frames = await this.runtime.handleMessage(data);
    if (!Array.isArray(frames)) {
      throw new BrowserCodexAppServerTransportError(
        "browser app-server runtime must return an array of frames",
        { code: "invalid_runtime_response" },
      );
    }

    for (const frame of frames) {
      if (this.readyState !== SOCKET_OPEN) {
        return;
      }
      emitEvent(this, "message", {
        data: JSON.stringify(frame),
      });
    }
  }
}

BrowserCodexAppServerLoopbackSocket.CONNECTING = SOCKET_CONNECTING;
BrowserCodexAppServerLoopbackSocket.OPEN = SOCKET_OPEN;
BrowserCodexAppServerLoopbackSocket.CLOSING = SOCKET_CLOSING;
BrowserCodexAppServerLoopbackSocket.CLOSED = SOCKET_CLOSED;

export class BrowserCodexAppServerJsonRpcClient {
  constructor(options = {}) {
    const {
      initialRequestId = 1,
      requestTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
      socket = null,
      ...socketOptions
    } = options;
    this.socket =
      socket ?? new BrowserCodexAppServerLoopbackSocket(socketOptions);
    this.closed = this.socket.readyState !== SOCKET_OPEN;
    this.notifications = [];
    this.onclose = null;
    this.onerror = null;
    this.onnotification = null;
    this.onunmatchedresponse = null;
    this._eventListeners = new Map();
    this._notificationWaiters = [];
    this._pending = new Map();
    this._requestId = positiveInteger(
      initialRequestId,
      "initialRequestId must be a positive integer",
    );
    this.requestTimeoutMs = requestTimeoutMs;
    this._handleMessage = (event) => this._handleSocketMessage(event);
    this._handleClose = (event) => this._handleSocketClose(event);
    this._handleError = (event) => this._handleSocketError(event);
    this.ready = this._readyPromise();

    this.socket.addEventListener("message", this._handleMessage);
    this.socket.addEventListener("close", this._handleClose);
    this.socket.addEventListener("error", this._handleError);
  }

  addEventListener(type, listener, options = {}) {
    addEventListener(this, type, listener, options);
  }

  removeEventListener(type, listener) {
    removeEventListener(this, type, listener);
  }

  request(method, params) {
    this._assertOpen();
    const id = this._nextRequestId();
    const message = jsonRpcMessage(method, params, id);
    const promise = new Promise((resolve, reject) => {
      this._pending.set(requestKey(id), { reject, resolve });
    });

    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      this._pending.delete(requestKey(id));
      throw error;
    }

    return promise;
  }

  notify(method, params) {
    this._assertOpen();
    this.socket.send(JSON.stringify(jsonRpcMessage(method, params)));
  }

  waitForNotification(method, options = {}) {
    const predicate = options.predicate ?? (() => true);
    if (options.replay !== false) {
      const existing = this.notifications.find(
        (notification) =>
          notification.method === method && predicate(notification),
      );
      if (existing) {
        return Promise.resolve(existing);
      }
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        method,
        predicate,
        reject,
        resolve,
        timeout: null,
      };
      const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
      if (timeoutMs > 0) {
        waiter.timeout = setTimeout(() => {
          this._notificationWaiters = this._notificationWaiters.filter(
            (item) => item !== waiter,
          );
          reject(
            new BrowserCodexAppServerTransportError(
              `browser app-server notification timed out: ${method}`,
              { code: "timeout" },
            ),
          );
        }, timeoutMs);
      }
      this._notificationWaiters.push(waiter);
    });
  }

  async drain() {
    await this.socket.drain?.();
  }

  close(code = NORMAL_CLOSE, reason = "") {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this._rejectPending(
      new BrowserCodexAppServerTransportError(
        "browser app-server JSON-RPC client closed",
        { code: "closed" },
      ),
    );
    this.socket.close(code, reason);
  }

  _nextRequestId() {
    const id = this._requestId;
    this._requestId += 1;
    return id;
  }

  _assertOpen() {
    if (this.closed || this.socket.readyState !== SOCKET_OPEN) {
      throw new BrowserCodexAppServerTransportError(
        "browser app-server JSON-RPC client is closed",
        { code: "closed" },
      );
    }
  }

  _handleSocketMessage(event) {
    let message;
    try {
      message =
        typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    } catch (error) {
      emitEvent(this, "error", {
        error: new BrowserCodexAppServerTransportError(
          "browser app-server emitted a malformed JSON frame",
          { cause: error, code: "malformed_frame" },
        ),
      });
      return;
    }

    if (!isObject(message)) {
      emitEvent(this, "error", {
        error: new BrowserCodexAppServerTransportError(
          "browser app-server emitted a non-object frame",
          { code: "malformed_frame" },
        ),
      });
      return;
    }

    if (Object.hasOwn(message, "id")) {
      this._handleResponse(message);
      return;
    }

    if (typeof message.method === "string") {
      this.notifications.push(message);
      emitEvent(this, "notification", {
        message,
        method: message.method,
        params: message.params,
      });
      this._resolveNotificationWaiters(message);
      return;
    }

    emitEvent(this, "error", {
      error: new BrowserCodexAppServerTransportError(
        "browser app-server emitted an unknown frame",
        { code: "malformed_frame" },
      ),
    });
  }

  _handleResponse(message) {
    const key = requestKey(message.id);
    const pending = this._pending.get(key);
    if (!pending) {
      emitEvent(this, "unmatchedresponse", { message });
      emitEvent(this, "error", {
        error: new BrowserCodexAppServerTransportError(
          `browser app-server emitted a response for an unknown request id: ${String(
            message.id,
          )}`,
          { code: "unknown_response" },
        ),
      });
      return;
    }

    this._pending.delete(key);
    if (message.error !== undefined) {
      pending.reject(new BrowserCodexAppServerJsonRpcError(message.error));
      return;
    }
    pending.resolve(message.result);
  }

  _handleSocketClose(event) {
    this.closed = true;
    this._rejectPending(
      new BrowserCodexAppServerTransportError(
        "browser app-server JSON-RPC client closed",
        { code: "closed" },
      ),
    );
    emitEvent(this, "close", {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    });
  }

  _handleSocketError(event) {
    const error =
      event.error ??
      new BrowserCodexAppServerTransportError(
        event.message ?? "browser app-server transport error",
      );
    this._rejectPending(error);
    emitEvent(this, "error", {
      error,
      message: error?.message ?? String(error),
    });
  }

  _rejectPending(error) {
    for (const pending of this._pending.values()) {
      pending.reject(error);
    }
    this._pending.clear();
    for (const waiter of this._notificationWaiters) {
      if (waiter.timeout) {
        clearTimeout(waiter.timeout);
      }
      waiter.reject(error);
    }
    this._notificationWaiters = [];
  }

  _resolveNotificationWaiters(message) {
    const matched = this._notificationWaiters.filter(
      (waiter) => waiter.method === message.method && waiter.predicate(message),
    );
    if (matched.length === 0) {
      return;
    }
    this._notificationWaiters = this._notificationWaiters.filter(
      (waiter) => !matched.includes(waiter),
    );
    for (const waiter of matched) {
      if (waiter.timeout) {
        clearTimeout(waiter.timeout);
      }
      waiter.resolve(message);
    }
  }

  _readyPromise() {
    if (this.socket.readyState === SOCKET_OPEN) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.socket.removeEventListener("open", onOpen);
        this.socket.removeEventListener("error", onError);
        this.socket.removeEventListener("close", onClose);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (event) => {
        cleanup();
        reject(event.error);
      };
      const onClose = () => {
        cleanup();
        reject(
          new BrowserCodexAppServerTransportError(
            "browser app-server loopback socket closed before opening",
            { code: "closed" },
          ),
        );
      };
      this.socket.addEventListener("open", onOpen);
      this.socket.addEventListener("error", onError);
      this.socket.addEventListener("close", onClose);
    });
  }
}

export function createBrowserCodexAppServerLoopbackSocket(options = {}) {
  return new BrowserCodexAppServerLoopbackSocket(options);
}

export function createBrowserCodexAppServerJsonRpcClient(options = {}) {
  return new BrowserCodexAppServerJsonRpcClient(options);
}

function jsonRpcMessage(method, params, id) {
  if (typeof method !== "string" || method.length === 0) {
    throw new BrowserCodexAppServerTransportError(
      "JSON-RPC method must be a non-empty string",
      { code: "invalid_request" },
    );
  }
  const message = {
    jsonrpc: JSONRPC_VERSION,
    method,
  };
  if (id !== undefined) {
    message.id = id;
  }
  if (params !== undefined) {
    message.params = params;
  }
  return message;
}

function requestKey(id) {
  return JSON.stringify(id);
}

function positiveInteger(value, message) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new BrowserCodexAppServerTransportError(message, {
      code: "invalid_request",
    });
  }
  return value;
}

function addEventListener(target, type, listener, options = {}) {
  if (listener == null) {
    return;
  }
  let listeners = target._eventListeners.get(type);
  if (!listeners) {
    listeners = new Set();
    target._eventListeners.set(type, listeners);
  }
  listeners.add({
    listener,
    once: typeof options === "object" && options !== null && options.once,
  });
}

function removeEventListener(target, type, listener) {
  const listeners = target._eventListeners.get(type);
  if (!listeners) {
    return;
  }
  for (const record of listeners) {
    if (record.listener === listener) {
      listeners.delete(record);
    }
  }
}

function emitEvent(target, type, init = {}) {
  const event = {
    currentTarget: target,
    target,
    type,
    ...init,
  };
  const propertyListener = target[`on${type}`];
  if (typeof propertyListener === "function") {
    callEventListener(propertyListener, event, target);
  }

  const listeners = target._eventListeners.get(type);
  if (!listeners) {
    return event;
  }
  for (const record of Array.from(listeners)) {
    callEventListener(record.listener, event, target);
    if (record.once) {
      listeners.delete(record);
    }
  }
  return event;
}

function callEventListener(listener, event, target) {
  try {
    if (typeof listener === "function") {
      listener.call(target, event);
    } else if (typeof listener?.handleEvent === "function") {
      listener.handleEvent(event);
    }
  } catch (error) {
    enqueueMicrotask(() => {
      throw error;
    });
  }
}

function enqueueMicrotask(callback) {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(callback);
    return;
  }
  Promise.resolve().then(callback);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
