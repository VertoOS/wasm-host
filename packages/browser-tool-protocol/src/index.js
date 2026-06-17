const DEFAULT_BOUNDS = Object.freeze({
  maxArgumentBytes: 64 * 1024,
  maxContentItems: 32,
  maxItemBytes: 32 * 1024,
  maxResultBytes: 64 * 1024,
});
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const WORKSPACE_EFFECTS = new Set(["none", "read", "write", "patch"]);
const textEncoder = new TextEncoder();

export const DEFAULT_BROWSER_TOOL_BOUNDS = DEFAULT_BOUNDS;
export const DEFAULT_BROWSER_TOOL_MAX_RESULT_BYTES =
  DEFAULT_BOUNDS.maxResultBytes;

export class BrowserToolProtocolError extends Error {
  constructor(kind, message, stage, options = {}) {
    super(message);
    this.name = "BrowserToolProtocolError";
    this.kind = kind;
    this.code = kind;
    this.stage = stage;
    this.safe = options.safe ?? true;
    this.cause = options.cause;
  }
}

export function createBrowserToolRegistry(options = {}) {
  const defaultBounds = normalizeBounds({
    ...options.bounds,
    maxResultBytes:
      options.maxResultBytes ?? options.bounds?.maxResultBytes,
  });
  const entries = new Map();

  const registry = {
    registerTool(tool) {
      const entry = normalizeRegistryTool(tool);
      const key = toolKey(entry.descriptor);
      if (entries.has(key)) {
        throw protocolError(
          "duplicate_tool",
          `duplicate browser tool: ${formatToolName(entry.descriptor)}`,
          "discovery",
        );
      }
      entries.set(key, entry);
      return entry.descriptor;
    },

    listTools(filter = {}) {
      const namespace =
        filter.namespace === undefined
          ? undefined
          : optionalIdentifier(filter.namespace, "namespace", "discovery");
      return Array.from(entries.values())
        .map((entry) => entry.descriptor)
        .filter((descriptor) =>
          namespace === undefined ? true : descriptor.namespace === namespace,
        )
        .map(cloneJson);
    },

    async callTool(request) {
      const signal = optionalAbortSignal(request?.signal);
      const call = normalizeToolCall(request);
      const entry = entries.get(toolKey(call));
      if (!entry) {
        return failureResult(
          protocolError(
            "tool_not_found",
            `browser tool not found: ${formatToolName(call)}`,
            "invocation",
          ),
          { bounds: defaultBounds, callId: call.callId },
        );
      }

      const bounds = normalizeBounds({
        ...defaultBounds,
        ...entry.descriptor.bounds,
        ...call.bounds,
      });
      try {
        assertJsonByteLength(call.arguments, bounds.maxArgumentBytes, {
          kind: "arguments_too_large",
          message: `browser tool arguments exceeded ${bounds.maxArgumentBytes} bytes`,
          stage: "invocation",
        });
      } catch (error) {
        return failureResult(error, { bounds, callId: call.callId });
      }
      if (signal?.aborted) {
        return failureResult(cancelledError(), {
          bounds,
          callId: call.callId,
          cancelled: true,
        });
      }

      let timedOut = false;
      const controller = new AbortController();
      const abortFromCaller = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abortFromCaller, { once: true });
      const timeoutMs = call.deadlineMs
        ? Math.max(0, call.deadlineMs - Date.now())
        : bounds.timeoutMs;
      const timeoutId =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              controller.abort(new DOMException("timeout", "TimeoutError"));
            }, timeoutMs);

      try {
        const result = await entry.handle({
          arguments: cloneJson(call.arguments),
          bounds: cloneJson(bounds),
          callId: call.callId,
          descriptor: cloneJson(entry.descriptor),
          itemId: call.itemId,
          namespace: call.namespace,
          signal: controller.signal,
          startedAtMs: call.startedAtMs,
          threadId: call.threadId,
          tool: call.tool,
          turnId: call.turnId,
        });
        if (timedOut) {
          return failureResult(timeoutError(), {
            bounds,
            callId: call.callId,
            timedOut: true,
          });
        }
        if (signal?.aborted || controller.signal.aborted) {
          return failureResult(cancelledError(), {
            bounds,
            callId: call.callId,
            cancelled: true,
          });
        }
        return normalizeToolResult(result, { bounds, callId: call.callId });
      } catch (error) {
        return failureResult(classifyCallError(error, { signal, timedOut }), {
          bounds,
          callId: call.callId,
          cancelled: signal?.aborted || error?.name === "AbortError",
          timedOut,
        });
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        signal?.removeEventListener("abort", abortFromCaller);
      }
    },
  };

  for (const tool of options.tools ?? []) {
    registry.registerTool(tool);
  }
  return registry;
}

export function normalizeToolDescriptor(tool) {
  const value = objectParam(tool, "browser tool descriptors must be objects");
  const descriptor = {
    name: requiredIdentifier(value.name, "name", "discovery"),
    description: stringParam(value.description ?? "", "description", "discovery"),
    inputSchema: normalizeJsonObject(value.inputSchema ?? emptyObjectSchema(), {
      field: "inputSchema",
      stage: "discovery",
    }),
    capabilities: stringArrayParam(
      value.capabilities ?? [],
      "capabilities",
      "discovery",
    ),
    effects: normalizeEffects(value.effects ?? {}),
    bounds: normalizeBounds(value.bounds ?? {}, { partial: true }),
    deferLoading: booleanParam(
      value.deferLoading ?? false,
      "deferLoading",
      "discovery",
    ),
  };
  const namespace = optionalIdentifier(value.namespace, "namespace", "discovery");
  if (namespace !== undefined) {
    descriptor.namespace = namespace;
  }
  const outputSchema =
    value.outputSchema === undefined || value.outputSchema === null
      ? undefined
      : normalizeJsonObject(value.outputSchema, {
          field: "outputSchema",
          stage: "discovery",
        });
  if (outputSchema !== undefined) {
    descriptor.outputSchema = outputSchema;
  }
  return cloneJson(descriptor);
}

export function normalizeToolCall(request) {
  const value = objectParam(request, "browser tool calls must be objects");
  const call = {
    callId: nonEmptyString(value.callId, "callId", "invocation"),
    turnId: nonEmptyString(value.turnId, "turnId", "invocation"),
    namespace: optionalIdentifier(value.namespace, "namespace", "invocation"),
    tool: requiredIdentifier(value.tool, "tool", "invocation"),
    arguments: cloneJson(value.arguments ?? {}),
    bounds: normalizeBounds(value.bounds ?? {}, { partial: true }),
    startedAtMs: numberParam(
      value.startedAtMs ?? Date.now(),
      "startedAtMs",
      "invocation",
    ),
  };
  const threadId = optionalNonEmptyString(value.threadId, "threadId", "invocation");
  if (threadId !== undefined) {
    call.threadId = threadId;
  }
  const itemId = optionalNonEmptyString(value.itemId, "itemId", "invocation");
  if (itemId !== undefined) {
    call.itemId = itemId;
  }
  if (value.deadlineMs !== undefined) {
    call.deadlineMs = numberParam(value.deadlineMs, "deadlineMs", "invocation");
  }
  return call;
}

export function normalizeToolResult(result, options = {}) {
  assertJsonSerializable(result);
  const bounds = normalizeBounds(options.bounds ?? {}, {
    base: DEFAULT_BOUNDS,
  });
  const value = objectParam(result, "browser tool results must be objects");
  const normalized = {
    callId: nonEmptyString(
      value.callId ?? options.callId,
      "callId",
      "result",
    ),
    success: booleanParam(value.success ?? true, "success", "result"),
    contentItems: arrayParam(
      value.contentItems ?? [],
      "browser tool result contentItems must be an array",
    ).map((item) => normalizeContentItem(item, bounds)),
  };
  if (normalized.contentItems.length > bounds.maxContentItems) {
    throw protocolError(
      "too_many_content_items",
      `browser tool result exceeded ${bounds.maxContentItems} content items`,
      "result",
    );
  }
  if (value.structured !== undefined) {
    normalized.structured = cloneJson(value.structured);
  }
  if (value.error !== undefined) {
    normalized.error = normalizeResultError(value.error);
  }
  if (value.completedAtMs !== undefined) {
    normalized.completedAtMs = numberParam(
      value.completedAtMs,
      "completedAtMs",
      "result",
    );
  }
  if (value.durationMs !== undefined) {
    normalized.durationMs = numberParam(value.durationMs, "durationMs", "result");
  }
  if (value.cancelled === true) {
    normalized.cancelled = true;
  }
  if (value.timedOut === true) {
    normalized.timedOut = true;
  }
  assertJsonByteLength(normalized, bounds.maxResultBytes, {
    kind: "result_too_large",
    message: `browser tool result exceeded ${bounds.maxResultBytes} bytes`,
    stage: "result",
  });
  return cloneJson(normalized);
}

function normalizeRegistryTool(tool) {
  const value = objectParam(tool, "browser registry tools must be objects");
  if (typeof value.handle !== "function") {
    throw protocolError(
      "invalid_tool_handler",
      "browser registry tools require a handle function",
      "discovery",
    );
  }
  return {
    descriptor: normalizeToolDescriptor(value),
    handle: value.handle,
  };
}

function normalizeContentItem(item, bounds) {
  const value = objectParam(item, "browser tool content items must be objects");
  let normalized;
  switch (value.type) {
    case "text":
      normalized = {
        type: "text",
        text: stringParam(value.text, "text", "result"),
      };
      if (value.mimeType !== undefined) {
        normalized.mimeType = nonEmptyString(value.mimeType, "mimeType", "result");
      }
      break;
    case "json":
      normalized = {
        type: "json",
        value: cloneJson(value.value),
      };
      break;
    case "image":
      normalized = {
        type: "image",
        imageUrl: nonEmptyString(value.imageUrl, "imageUrl", "result"),
      };
      if (value.mimeType !== undefined) {
        normalized.mimeType = nonEmptyString(value.mimeType, "mimeType", "result");
      }
      if (value.altText !== undefined) {
        normalized.altText = stringParam(value.altText, "altText", "result");
      }
      break;
    default:
      throw protocolError(
        "invalid_content_item",
        "browser tool content items must be text, json, or image",
        "result",
      );
  }
  assertJsonByteLength(normalized, bounds.maxItemBytes, {
    kind: "content_item_too_large",
    message: `browser tool content item exceeded ${bounds.maxItemBytes} bytes`,
    stage: "result",
  });
  return normalized;
}

function normalizeResultError(error) {
  const value = objectParam(error, "browser tool result errors must be objects");
  const normalized = {
    kind: nonEmptyString(value.kind, "error.kind", "result"),
    message: nonEmptyString(value.message, "error.message", "result"),
  };
  if (value.stage !== undefined) {
    normalized.stage = nonEmptyString(value.stage, "error.stage", "result");
  }
  return normalized;
}

function normalizeJsonObject(value, options) {
  return cloneJson(
    objectParam(value, `browser tool ${options.field} must be an object`),
  );
}

function normalizeEffects(value) {
  const effects = objectParam(value, "browser tool effects must be an object");
  const normalized = {};
  if (effects.workspace !== undefined) {
    if (!WORKSPACE_EFFECTS.has(effects.workspace)) {
      throw protocolError(
        "invalid_effect",
        "browser tool workspace effect must be none, read, write, or patch",
        "discovery",
      );
    }
    normalized.workspace = effects.workspace;
  }
  return cloneJson(normalized);
}

function normalizeBounds(value, options = {}) {
  const base = options.base ?? (options.partial ? {} : DEFAULT_BOUNDS);
  const input = objectParam(value, "browser tool bounds must be an object");
  const bounds = { ...base };
  for (const field of [
    "maxArgumentBytes",
    "maxContentItems",
    "maxItemBytes",
    "maxResultBytes",
    "timeoutMs",
  ]) {
    if (input[field] === undefined) {
      continue;
    }
    bounds[field] = positiveInteger(input[field], field, "bounds");
  }
  return cloneJson(bounds);
}

function failureResult(error, options) {
  const result = {
    callId: options.callId,
    contentItems: [{ type: "text", text: error.message }],
    error: {
      kind: error.kind ?? error.code ?? "tool_failed",
      message: error.message,
    },
    success: false,
  };
  if (error.stage !== undefined) {
    result.error.stage = error.stage;
  }
  if (options.cancelled === true) {
    result.cancelled = true;
  }
  if (options.timedOut === true) {
    result.timedOut = true;
  }
  return normalizeToolResult(result, {
    bounds: failureResultBounds(options.bounds),
    callId: options.callId,
  });
}

function failureResultBounds(bounds = {}) {
  return {
    ...bounds,
    maxContentItems: Math.max(
      bounds.maxContentItems ?? DEFAULT_BOUNDS.maxContentItems,
      1,
    ),
    maxItemBytes: Math.max(
      bounds.maxItemBytes ?? DEFAULT_BOUNDS.maxItemBytes,
      DEFAULT_BOUNDS.maxItemBytes,
    ),
    maxResultBytes: Math.max(
      bounds.maxResultBytes ?? DEFAULT_BOUNDS.maxResultBytes,
      DEFAULT_BOUNDS.maxResultBytes,
    ),
  };
}

function classifyCallError(error, options) {
  if (options.timedOut || error?.name === "TimeoutError") {
    return timeoutError();
  }
  if (options.signal?.aborted || error?.name === "AbortError") {
    return cancelledError();
  }
  if (error instanceof BrowserToolProtocolError && error.safe) {
    return error;
  }
  return protocolError("tool_failed", "browser tool failed", "invocation", {
    cause: error,
    safe: true,
  });
}

function cancelledError() {
  return protocolError("cancelled", "tool call cancelled", "invocation");
}

function timeoutError() {
  return protocolError("timeout", "tool call timed out", "invocation");
}

function assertJsonByteLength(value, maxBytes, error) {
  const bytes = textEncoder.encode(jsonString(value)).byteLength;
  if (bytes > maxBytes) {
    throw protocolError(error.kind, error.message, error.stage);
  }
}

function cloneJson(value) {
  assertJsonSerializable(value);
  return JSON.parse(jsonString(value));
}

function jsonString(value) {
  return JSON.stringify(value);
}

function assertJsonSerializable(value, seen = new Set()) {
  if (value === null) {
    return;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        break;
      }
      return;
    case "object": {
      if (seen.has(value)) {
        throw protocolError(
          "invalid_json",
          "browser tool values must not contain cycles",
          "serialization",
        );
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== Array.prototype) {
        throw protocolError(
          "invalid_json",
          "browser tool values must be plain JSON values",
          "serialization",
        );
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw protocolError(
          "invalid_json",
          "browser tool values must not contain symbol keys",
          "serialization",
        );
      }
      seen.add(value);
      const values = Array.isArray(value) ? value : Object.values(value);
      for (const child of values) {
        assertJsonSerializable(child, seen);
      }
      seen.delete(value);
      return;
    }
  }
  throw protocolError(
    "invalid_json",
    "browser tool values must be JSON serializable",
    "serialization",
  );
}

function toolKey(value) {
  return `${value.namespace ?? ""}\u0000${value.name ?? value.tool}`;
}

function formatToolName(value) {
  const name = value.name ?? value.tool;
  return value.namespace ? `${value.namespace}.${name}` : name;
}

function emptyObjectSchema() {
  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

function objectParam(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError("invalid_object", message, "validation");
  }
  return value;
}

function arrayParam(value, message) {
  if (!Array.isArray(value)) {
    throw protocolError("invalid_array", message, "validation");
  }
  return value;
}

function stringArrayParam(value, field, stage) {
  return arrayParam(value, `browser tool ${field} must be an array`).map((item) =>
    requiredIdentifier(item, field, stage),
  );
}

function stringParam(value, field, stage) {
  if (typeof value !== "string") {
    throw protocolError(
      "invalid_string",
      `browser tool ${field} must be a string`,
      stage,
    );
  }
  return value;
}

function nonEmptyString(value, field, stage) {
  const text = stringParam(value, field, stage);
  if (text.length === 0) {
    throw protocolError(
      "invalid_string",
      `browser tool ${field} must not be empty`,
      stage,
    );
  }
  return text;
}

function optionalNonEmptyString(value, field, stage) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return nonEmptyString(value, field, stage);
}

function requiredIdentifier(value, field, stage) {
  const text = nonEmptyString(value, field, stage);
  if (!IDENTIFIER_PATTERN.test(text)) {
    throw protocolError(
      "invalid_identifier",
      `browser tool ${field} is not a supported identifier: ${text}`,
      stage,
    );
  }
  return text;
}

function optionalIdentifier(value, field, stage) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requiredIdentifier(value, field, stage);
}

function booleanParam(value, field, stage) {
  if (typeof value !== "boolean") {
    throw protocolError(
      "invalid_boolean",
      `browser tool ${field} must be a boolean`,
      stage,
    );
  }
  return value;
}

function numberParam(value, field, stage) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw protocolError(
      "invalid_number",
      `browser tool ${field} must be a finite number`,
      stage,
    );
  }
  return value;
}

function positiveInteger(value, field, stage) {
  if (!Number.isInteger(value) || value <= 0) {
    throw protocolError(
      "invalid_bounds",
      `browser tool ${field} must be a positive integer`,
      stage,
    );
  }
  return value;
}

function optionalAbortSignal(signal) {
  if (signal === undefined || signal === null) {
    return undefined;
  }
  if (
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    throw protocolError(
      "invalid_signal",
      "browser tool signal must be an AbortSignal",
      "invocation",
    );
  }
  return signal;
}

function protocolError(kind, message, stage, options) {
  return new BrowserToolProtocolError(kind, message, stage, options);
}
