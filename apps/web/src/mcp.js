const JSONRPC_VERSION = "2.0";
const DEFAULT_MAX_RESULT_BYTES = 64 * 1024;
const DEFAULT_BROWSER_MCP_TOOL_NAME = "browser.echo";

export const BROWSER_MCP_ECHO_TOOL_NAME = DEFAULT_BROWSER_MCP_TOOL_NAME;
export const DEFAULT_BROWSER_MCP_MAX_RESULT_BYTES = DEFAULT_MAX_RESULT_BYTES;

export class BrowserMcpTransportError extends Error {
  constructor(kind, message, options = {}) {
    super(message);
    this.name = "BrowserMcpTransportError";
    this.kind = kind;
    this.code = options.code ?? kind;
    this.rpcCode = options.rpcCode ?? jsonRpcCodeForKind(kind);
    this.stage = options.stage ?? "mcp";
    this.data = {
      ...(options.data ?? {}),
      browserHosted: true,
      code: this.code,
      kind,
      stage: this.stage,
    };
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export class BrowserMcpLoopbackRuntime {
  constructor(options = {}) {
    this.maxResultBytes = positiveInteger(
      options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
      "maxResultBytes must be a positive integer",
    );
    this.tools = normalizeTools(options);
  }

  async handleMessage(rawMessage, context = {}) {
    const parsed = parseJsonRpcMessage(rawMessage);
    if (parsed.error) {
      return [jsonRpcError(null, parsed.error)];
    }

    const message = parsed.message;
    const id = isPlainObject(message) && Object.hasOwn(message, "id")
      ? message.id
      : undefined;
    try {
      validateJsonRpcEnvelope(message);
      if (id === undefined) {
        await this.handleNotification(message.method, message.params, context);
        return [];
      }
      const result = await this.handleRequest(
        message.method,
        message.params,
        context,
      );
      return [jsonRpcResult(id, result)];
    } catch (error) {
      const normalized = normalizeMcpError(error);
      return [jsonRpcError(id ?? null, normalized)];
    }
  }

  async handleNotification(method) {
    throw unsupportedMethod(method);
  }

  async handleRequest(method, params, context = {}) {
    throwIfAborted(context.signal);
    switch (method) {
      case "tools/list":
        objectParam(params ?? {}, "tools/list params must be an object");
        return this.listTools();
      case "tools/call":
        return this.callTool(params, context);
      default:
        throw unsupportedMethod(method);
    }
  }

  listTools() {
    return {
      tools: Array.from(this.tools.values(), (tool) => tool.descriptor),
    };
  }

  async callTool(params, context = {}) {
    const value = objectParam(params, "tools/call params must be an object");
    const name = nonEmptyString(value.name, "tools/call tool name is required");
    const tool = this.tools.get(name);
    if (!tool) {
      throw new BrowserMcpTransportError(
        "tool_not_found",
        `browser MCP tool not found: ${name}`,
        {
          data: {
            name,
          },
          rpcCode: -32602,
        },
      );
    }

    const input = value.arguments === undefined
      ? {}
      : objectParam(value.arguments, "tools/call arguments must be an object");
    throwIfAborted(context.signal);
    const rawResult = await tool.call(input, {
      signal: context.signal,
      tool: tool.descriptor,
    });
    throwIfAborted(context.signal);
    const result = normalizeToolResult(rawResult);
    enforceResultSize(result, this.maxResultBytes);
    return result;
  }
}

export class BrowserMcpLoopbackClient {
  constructor(options = {}) {
    const {
      initialRequestId = 1,
      runtime = createBrowserMcpLoopbackRuntime(options),
    } = options;
    if (!runtime || typeof runtime.handleMessage !== "function") {
      throw new BrowserMcpTransportError(
        "invalid_runtime",
        "browser MCP loopback client requires a runtime",
      );
    }
    this.closed = false;
    this.runtime = runtime;
    this._pending = new Map();
    this._requestId = positiveInteger(
      initialRequestId,
      "initialRequestId must be a positive integer",
    );
  }

  listTools(options = {}) {
    return this.request("tools/list", {}, options);
  }

  callTool(name, args = {}, options = {}) {
    return this.request(
      "tools/call",
      {
        arguments: args,
        name,
      },
      options,
    );
  }

  request(method, params, options = {}) {
    this._assertOpen();
    if (options.signal?.aborted) {
      return Promise.reject(cancelledError(options.signal.reason));
    }
    validateAbortSignal(options.signal);

    const id = this._nextRequestId();
    const key = requestKey(id);
    const controller = new AbortController();
    const message = jsonRpcMessage(method, params, id);
    const pending = {
      cleanup: () => {},
      controller,
      key,
      reject: null,
      resolve: null,
    };
    const promise = new Promise((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    pending.cleanup = attachExternalAbort(options.signal, () => {
      controller.abort(options.signal.reason);
      this._rejectPending(pending, cancelledError(options.signal.reason));
    });
    this._pending.set(key, pending);

    void this._dispatch(message, pending);
    return promise;
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const error = new BrowserMcpTransportError(
      "closed",
      "browser MCP loopback client closed",
    );
    for (const pending of Array.from(this._pending.values())) {
      this._pending.delete(pending.key);
      pending.cleanup();
      pending.controller.abort(error);
      pending.reject(error);
    }
  }

  _nextRequestId() {
    const id = this._requestId;
    this._requestId += 1;
    return id;
  }

  _assertOpen() {
    if (this.closed) {
      throw new BrowserMcpTransportError(
        "closed",
        "browser MCP loopback client is closed",
      );
    }
  }

  async _dispatch(message, pending) {
    try {
      throwIfAborted(pending.controller.signal);
      const frames = await this.runtime.handleMessage(message, {
        signal: pending.controller.signal,
      });
      throwIfAborted(pending.controller.signal);
      if (!Array.isArray(frames)) {
        throw new BrowserMcpTransportError(
          "invalid_response",
          "browser MCP loopback runtime must return response frames",
        );
      }
      const response = responseForRequest(frames, message.id);
      if (response.error !== undefined) {
        throw errorFromJsonRpc(response.error);
      }
      this._resolvePending(pending, response.result);
    } catch (error) {
      this._rejectPending(pending, normalizeMcpError(error));
    }
  }

  _resolvePending(pending, value) {
    if (this._pending.get(pending.key) !== pending) {
      return;
    }
    this._pending.delete(pending.key);
    pending.cleanup();
    pending.resolve(value);
  }

  _rejectPending(pending, error) {
    if (this._pending.get(pending.key) !== pending) {
      return;
    }
    this._pending.delete(pending.key);
    pending.cleanup();
    pending.controller.abort(error);
    pending.reject(error);
  }
}

export function createBrowserMcpLoopbackRuntime(options = {}) {
  return new BrowserMcpLoopbackRuntime(options);
}

export function createBrowserMcpLoopbackClient(options = {}) {
  return new BrowserMcpLoopbackClient(options);
}

export function createBrowserMcpToolFixture(options = {}) {
  return createBrowserMcpLoopbackRuntime(options);
}

export function validateBrowserMcpServerConfig(config) {
  objectParam(config, "browser MCP server config must be an object");
  const unsupported = findUnsupportedServerCapability(config);
  if (unsupported) {
    throw new BrowserMcpTransportError(
      "unsupported_capability",
      `browser MCP server config requires unsupported ${unsupported.capability}`,
      {
        data: unsupported,
        rpcCode: -32601,
      },
    );
  }
  return config;
}

function normalizeTools(options) {
  const tools = new Map();
  const includeDefaultTools = options.includeDefaultTools !== false;
  const inputTools = [
    ...(includeDefaultTools ? [browserEchoTool()] : []),
    ...(options.tools ?? []),
  ];
  for (const tool of inputTools) {
    const normalized = normalizeTool(tool);
    if (tools.has(normalized.descriptor.name)) {
      throw new BrowserMcpTransportError(
        "invalid_request",
        `duplicate browser MCP tool: ${normalized.descriptor.name}`,
      );
    }
    tools.set(normalized.descriptor.name, normalized);
  }
  return tools;
}

function normalizeTool(tool) {
  const value = objectParam(tool, "browser MCP tools must be objects");
  const name = nonEmptyString(value.name, "browser MCP tool name is required");
  if (typeof value.call !== "function") {
    throw new BrowserMcpTransportError(
      "invalid_request",
      `browser MCP tool must be callable: ${name}`,
    );
  }
  const inputSchema = value.inputSchema ?? {
    additionalProperties: true,
    type: "object",
  };
  objectParam(inputSchema, `browser MCP tool input schema must be an object: ${name}`);
  const descriptor = {
    name,
    description: typeof value.description === "string"
      ? value.description
      : "",
    inputSchema,
  };
  if (typeof value.title === "string") {
    descriptor.title = value.title;
  }
  return {
    call: value.call,
    descriptor,
  };
}

function browserEchoTool() {
  return {
    name: DEFAULT_BROWSER_MCP_TOOL_NAME,
    title: "Browser Echo",
    description: "Deterministically echoes JSON input for browser MCP tests.",
    inputSchema: {
      additionalProperties: true,
      properties: {
        message: {
          type: "string",
        },
        text: {
          type: "string",
        },
      },
      type: "object",
    },
    call(input) {
      const keys = Object.keys(input).sort();
      const summary = keys.length === 0
        ? "no keys"
        : `keys=${keys.join(",")}`;
      const text = typeof input.text === "string"
        ? input.text
        : typeof input.message === "string"
          ? input.message
          : null;
      const lines = [
        DEFAULT_BROWSER_MCP_TOOL_NAME,
        `input=${stableStringify(input)}`,
        `summary=${summary}`,
      ];
      if (text !== null) {
        lines.push(`text=${text}`);
      }
      return {
        content: [
          {
            type: "text",
            text: lines.join("\n"),
          },
        ],
      };
    },
  };
}

function parseJsonRpcMessage(rawMessage) {
  if (typeof rawMessage !== "string") {
    return {
      message: rawMessage,
    };
  }
  try {
    return {
      message: JSON.parse(rawMessage),
    };
  } catch (error) {
    return {
      error: new BrowserMcpTransportError(
        "parse_error",
        "browser MCP received malformed JSON",
        {
          cause: error,
          rpcCode: -32700,
        },
      ),
    };
  }
}

function validateJsonRpcEnvelope(message) {
  if (!isPlainObject(message)) {
    throw new BrowserMcpTransportError(
      "invalid_request",
      "browser MCP JSON-RPC message must be an object",
      {
        rpcCode: -32600,
      },
    );
  }
  if (message.jsonrpc !== JSONRPC_VERSION) {
    throw new BrowserMcpTransportError(
      "invalid_request",
      "browser MCP JSON-RPC version must be 2.0",
      {
        rpcCode: -32600,
      },
    );
  }
  if (typeof message.method !== "string" || message.method.length === 0) {
    throw new BrowserMcpTransportError(
      "invalid_request",
      "browser MCP JSON-RPC method is required",
      {
        rpcCode: -32600,
      },
    );
  }
  if (Object.hasOwn(message, "id") && !validRequestId(message.id)) {
    throw new BrowserMcpTransportError(
      "invalid_request",
      "browser MCP JSON-RPC id must be a string, number, or null",
      {
        rpcCode: -32600,
      },
    );
  }
}

function jsonRpcMessage(method, params, id) {
  if (typeof method !== "string" || method.length === 0) {
    throw new BrowserMcpTransportError(
      "invalid_request",
      "browser MCP JSON-RPC method is required",
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

function jsonRpcResult(id, result) {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    result,
  };
}

function jsonRpcError(id, error) {
  const normalized = normalizeMcpError(error);
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: {
      code: normalized.rpcCode,
      data: normalized.data,
      message: normalized.message,
    },
  };
}

function responseForRequest(frames, id) {
  const response = frames.find(
    (frame) => isPlainObject(frame) && frame.id === id,
  );
  if (!response) {
    throw new BrowserMcpTransportError(
      "invalid_response",
      `browser MCP loopback runtime did not return a response for id: ${String(id)}`,
    );
  }
  return response;
}

function errorFromJsonRpc(error) {
  const data = isPlainObject(error?.data) ? error.data : {};
  const kind = typeof data.kind === "string" ? data.kind : "transport";
  return new BrowserMcpTransportError(
    kind,
    error?.message ?? "browser MCP JSON-RPC request failed",
    {
      code: typeof data.code === "string" ? data.code : kind,
      data,
      rpcCode: Number.isInteger(error?.code)
        ? error.code
        : jsonRpcCodeForKind(kind),
    },
  );
}

function unsupportedMethod(method) {
  return new BrowserMcpTransportError(
    "unsupported_capability",
    `unsupported browser MCP method: ${method}`,
    {
      data: {
        method,
        supportedMethods: ["tools/list", "tools/call"],
      },
      rpcCode: -32601,
    },
  );
}

function normalizeToolResult(result) {
  if (typeof result === "string") {
    return {
      content: [
        {
          type: "text",
          text: result,
        },
      ],
    };
  }
  const value = objectParam(result, "browser MCP tool result must be an object");
  if (!Array.isArray(value.content)) {
    throw new BrowserMcpTransportError(
      "invalid_response",
      "browser MCP tool result content must be an array",
    );
  }
  const normalized = {
    ...value,
    content: value.content.map(normalizeContentItem),
  };
  if (
    Object.hasOwn(normalized, "isError") &&
    typeof normalized.isError !== "boolean"
  ) {
    throw new BrowserMcpTransportError(
      "invalid_response",
      "browser MCP tool result isError must be a boolean",
    );
  }
  return normalized;
}

function normalizeContentItem(item) {
  const value = objectParam(
    item,
    "browser MCP tool result content items must be objects",
  );
  if (value.type !== "text" || typeof value.text !== "string") {
    throw new BrowserMcpTransportError(
      "invalid_response",
      "browser MCP fixture only supports text content",
    );
  }
  return {
    text: value.text,
    type: "text",
  };
}

function enforceResultSize(result, maxResultBytes) {
  const size = jsonByteLength(result);
  if (size > maxResultBytes) {
    throw new BrowserMcpTransportError(
      "result_too_large",
      `browser MCP tool result exceeded ${maxResultBytes} bytes`,
      {
        data: {
          maxResultBytes,
          resultBytes: size,
        },
        rpcCode: -32001,
      },
    );
  }
}

function findUnsupportedServerCapability(value, path = "config") {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = findUnsupportedServerCapability(
        value[index],
        `${path}[${index}]`,
      );
      if (nested) {
        return nested;
      }
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    const keyCapability = unsupportedCapabilityForKey(key);
    if (keyCapability) {
      return {
        capability: keyCapability,
        field: itemPath,
      };
    }
    if (
      typeof item === "string" &&
      transportKey(key) &&
      unsupportedCapabilityForValue(item)
    ) {
      return {
        capability: unsupportedCapabilityForValue(item),
        field: itemPath,
      };
    }
    const nested = findUnsupportedServerCapability(item, itemPath);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function unsupportedCapabilityForKey(key) {
  switch (key) {
    case "command":
      return "local_process";
    case "localProcess":
    case "local_process":
    case "process":
      return "local_process";
    case "stdio":
      return "stdio";
    default:
      return null;
  }
}

function unsupportedCapabilityForValue(value) {
  switch (value.trim().toLowerCase()) {
    case "command":
    case "local-process":
    case "local_process":
    case "process":
      return "local_process";
    case "stdio":
      return "stdio";
    default:
      return null;
  }
}

function transportKey(key) {
  return key === "transport" || key === "type" || key === "kind";
}

function normalizeMcpError(error) {
  if (error instanceof BrowserMcpTransportError) {
    return error;
  }
  if (isAbortError(error)) {
    return cancelledError(error);
  }
  if (typeof error?.kind === "string") {
    return new BrowserMcpTransportError(
      error.kind,
      error.message ?? "browser MCP request failed",
      {
        cause: error,
        data: isPlainObject(error.data) ? error.data : {},
      },
    );
  }
  return new BrowserMcpTransportError(
    "internal_error",
    error?.message ?? "browser MCP internal error",
    {
      cause: error,
      rpcCode: -32603,
    },
  );
}

function cancelledError(cause) {
  return new BrowserMcpTransportError(
    "cancelled",
    "browser MCP request cancelled",
    {
      cause,
      rpcCode: -32000,
    },
  );
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw cancelledError(signal.reason);
  }
}

function attachExternalAbort(signal, onAbort) {
  if (!signal) {
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function validateAbortSignal(signal) {
  if (
    signal !== undefined &&
    signal !== null &&
    (typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  ) {
    throw new BrowserMcpTransportError(
      "invalid_request",
      "browser MCP request signal must be an AbortSignal",
    );
  }
}

function objectParam(value, message) {
  if (!isPlainObject(value)) {
    throw new BrowserMcpTransportError("invalid_request", message, {
      rpcCode: -32602,
    });
  }
  return value;
}

function nonEmptyString(value, message) {
  if (typeof value !== "string" || value.length === 0) {
    throw new BrowserMcpTransportError("invalid_request", message, {
      rpcCode: -32602,
    });
  }
  return value;
}

function positiveInteger(value, message) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new BrowserMcpTransportError("invalid_request", message, {
      rpcCode: -32602,
    });
  }
  return value;
}

function validRequestId(value) {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function requestKey(id) {
  return JSON.stringify(id);
}

function jsonRpcCodeForKind(kind) {
  switch (kind) {
    case "parse_error":
      return -32700;
    case "invalid_request":
    case "invalid_response":
    case "tool_not_found":
      return -32602;
    case "unsupported_capability":
      return -32601;
    case "internal_error":
      return -32603;
    case "result_too_large":
      return -32001;
    case "cancelled":
    case "closed":
    case "transport":
    default:
      return -32000;
  }
}

function stableStringify(value) {
  return JSON.stringify(stableJsonValue(value));
}

function stableJsonValue(value, seen = new Set()) {
  if (value === null) {
    return null;
  }
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") {
    return value;
  }
  if (type === "bigint") {
    throw new BrowserMcpTransportError(
      "invalid_request",
      "browser MCP values must be JSON serializable",
    );
  }
  if (type === "undefined" || type === "function" || type === "symbol") {
    return undefined;
  }
  if (seen.has(value)) {
    throw new BrowserMcpTransportError(
      "invalid_request",
      "browser MCP values must not contain cycles",
    );
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => {
        const normalized = stableJsonValue(item, seen);
        return normalized === undefined ? null : normalized;
      });
    }
    const output = {};
    for (const key of Object.keys(value).sort()) {
      const normalized = stableJsonValue(value[key], seen);
      if (normalized !== undefined) {
        output[key] = normalized;
      }
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function jsonByteLength(value) {
  return new TextEncoder().encode(stableStringify(value)).byteLength;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
