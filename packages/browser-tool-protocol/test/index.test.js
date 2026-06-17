import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserToolProtocolError,
  createBrowserToolRegistry,
  normalizeToolCall,
  normalizeToolDescriptor,
  normalizeToolResult,
} from "../src/index.js";

test("normalizes tool descriptors with defaults and JSON copies", () => {
  const inputSchema = { type: "object", properties: { text: { type: "string" } } };
  const descriptor = normalizeToolDescriptor({
    name: "echo",
    namespace: "browser",
    description: "Echo text",
    inputSchema,
    capabilities: ["workspace.read"],
    effects: { workspace: "read" },
    bounds: { maxResultBytes: 1024 },
    deferLoading: true,
  });

  inputSchema.properties.text.type = "number";
  assert.deepEqual(descriptor, {
    name: "echo",
    namespace: "browser",
    description: "Echo text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
    },
    capabilities: ["workspace.read"],
    effects: { workspace: "read" },
    bounds: { maxResultBytes: 1024 },
    deferLoading: true,
  });
});

test("rejects unsupported descriptor names and non-json descriptor values", () => {
  assert.throws(
    () => normalizeToolDescriptor({ name: "bad/name" }),
    (error) =>
      error instanceof BrowserToolProtocolError &&
      error.kind === "invalid_identifier",
  );
  assert.throws(
    () =>
      normalizeToolDescriptor({
        name: "bad",
        inputSchema: { type: "object", value: 1n },
      }),
    (error) =>
      error instanceof BrowserToolProtocolError && error.kind === "invalid_json",
  );
});

test("lists tools and rejects duplicate tools in the same namespace", () => {
  const registry = createBrowserToolRegistry({
    tools: [
      {
        name: "read",
        namespace: "workspace",
        handle: async () => ({ contentItems: [], success: true }),
      },
      {
        name: "read",
        namespace: "package",
        handle: async () => ({ contentItems: [], success: true }),
      },
    ],
  });

  assert.deepEqual(
    registry.listTools().map((tool) => `${tool.namespace}:${tool.name}`),
    ["workspace:read", "package:read"],
  );
  assert.deepEqual(registry.listTools({ namespace: "package" }), [
    {
      name: "read",
      namespace: "package",
      description: "",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
      capabilities: [],
      effects: {},
      bounds: {},
      deferLoading: false,
    },
  ]);
  assert.throws(
    () =>
      registry.registerTool({
        name: "read",
        namespace: "workspace",
        handle: async () => ({ contentItems: [], success: true }),
      }),
    (error) =>
      error instanceof BrowserToolProtocolError &&
      error.kind === "duplicate_tool",
  );
});

test("calls registered tools with cloned arguments and turn metadata", async () => {
  const seen = [];
  const registry = createBrowserToolRegistry({
    tools: [
      {
        name: "summarize",
        namespace: "workspace",
        description: "Summarize a file",
        handle: async (call) => {
          seen.push(call);
          call.arguments.path = "/mutated";
          return {
            contentItems: [{ type: "text", text: call.arguments.path }],
            structured: { changed: true },
            success: true,
          };
        },
      },
    ],
  });
  const args = { path: "/workspace/notes.txt" };

  const result = await registry.callTool({
    arguments: args,
    callId: "call-1",
    itemId: "item-1",
    namespace: "workspace",
    startedAtMs: 12,
    threadId: "thread-1",
    tool: "summarize",
    turnId: "turn-1",
  });

  assert.deepEqual(args, { path: "/workspace/notes.txt" });
  assert.equal(seen[0].callId, "call-1");
  assert.equal(seen[0].turnId, "turn-1");
  assert.equal(seen[0].threadId, "thread-1");
  assert.equal(seen[0].itemId, "item-1");
  assert.equal(seen[0].startedAtMs, 12);
  assert.equal(seen[0].descriptor.name, "summarize");
  assert.deepEqual(result, {
    callId: "call-1",
    contentItems: [{ type: "text", text: "/mutated" }],
    structured: { changed: true },
    success: true,
  });
});

test("returns structured failures for missing tools and unsafe handler errors", async () => {
  const registry = createBrowserToolRegistry({
    tools: [
      {
        name: "explode",
        handle: async () => {
          throw new Error("secret token");
        },
      },
    ],
  });

  assert.deepEqual(
    await registry.callTool({
      arguments: {},
      callId: "call-1",
      tool: "missing",
      turnId: "turn-1",
    }),
    {
      callId: "call-1",
      contentItems: [
        { type: "text", text: "browser tool not found: missing" },
      ],
      error: {
        kind: "tool_not_found",
        message: "browser tool not found: missing",
        stage: "invocation",
      },
      success: false,
    },
  );
  assert.deepEqual(
    await registry.callTool({
      arguments: {},
      callId: "call-2",
      tool: "explode",
      turnId: "turn-1",
    }),
    {
      callId: "call-2",
      contentItems: [{ type: "text", text: "browser tool failed" }],
      error: {
        kind: "tool_failed",
        message: "browser tool failed",
        stage: "invocation",
      },
      success: false,
    },
  );
});

test("preserves safe protocol errors from handlers", async () => {
  const registry = createBrowserToolRegistry({
    tools: [
      {
        name: "deny",
        handle: async () => {
          throw new BrowserToolProtocolError(
            "permission_denied",
            "workspace read denied",
            "approval",
          );
        },
      },
    ],
  });

  assert.deepEqual(
    await registry.callTool({
      arguments: {},
      callId: "call-1",
      tool: "deny",
      turnId: "turn-1",
    }),
    {
      callId: "call-1",
      contentItems: [{ type: "text", text: "workspace read denied" }],
      error: {
        kind: "permission_denied",
        message: "workspace read denied",
        stage: "approval",
      },
      success: false,
    },
  );
});

test("enforces bounded and JSON-serializable arguments and results", async () => {
  assert.throws(
    () =>
      normalizeToolResult({
        callId: "call-1",
        contentItems: [{ type: "text", text: "hello" }],
        success: true,
        structured: { value: 1n },
      }),
    (error) =>
      error instanceof BrowserToolProtocolError && error.kind === "invalid_json",
  );
  assert.throws(
    () =>
      normalizeToolDescriptor({
        name: "bad",
        inputSchema: { [Symbol("hidden")]: "dropped", type: "object" },
      }),
    (error) =>
      error instanceof BrowserToolProtocolError && error.kind === "invalid_json",
  );

  const registry = createBrowserToolRegistry({
    bounds: {
      maxArgumentBytes: 30,
      maxResultBytes: 220,
    },
    tools: [
      {
        name: "large",
        handle: async () => ({
          contentItems: [{ type: "text", text: "x".repeat(240) }],
          success: true,
        }),
      },
    ],
  });

  assert.equal(
    (
      await registry.callTool({
        arguments: { text: "x".repeat(50) },
        callId: "call-1",
        tool: "large",
        turnId: "turn-1",
      })
    ).error.kind,
    "arguments_too_large",
  );
  assert.deepEqual(
    await registry.callTool({
      arguments: {},
      callId: "call-2",
      tool: "large",
      turnId: "turn-1",
    }),
    {
      callId: "call-2",
      contentItems: [
        { type: "text", text: "browser tool result exceeded 220 bytes" },
      ],
      error: {
        kind: "result_too_large",
        message: "browser tool result exceeded 220 bytes",
        stage: "result",
      },
      success: false,
    },
  );
});

test("normalizes json and image content items", () => {
  assert.deepEqual(
    normalizeToolResult({
      callId: "call-1",
      contentItems: [
        { type: "json", value: { ok: true } },
        {
          type: "image",
          imageUrl: "data:image/png;base64,AAAA",
          mimeType: "image/png",
          altText: "diagram",
        },
      ],
      success: true,
    }),
    {
      callId: "call-1",
      contentItems: [
        { type: "json", value: { ok: true } },
        {
          type: "image",
          imageUrl: "data:image/png;base64,AAAA",
          mimeType: "image/png",
          altText: "diagram",
        },
      ],
      success: true,
    },
  );
});

test("supports AbortSignal cancellation before and during calls", async () => {
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const registry = createBrowserToolRegistry({
    tools: [
      {
        name: "wait",
        handle: async ({ signal }) =>
          new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
            setTimeout(() => resolve({ contentItems: [], success: true }), 50);
          }),
      },
    ],
  });

  assert.deepEqual(
    await registry.callTool({
      arguments: {},
      callId: "call-1",
      signal: alreadyAborted.signal,
      tool: "wait",
      turnId: "turn-1",
    }),
    {
      callId: "call-1",
      contentItems: [{ type: "text", text: "tool call cancelled" }],
      error: {
        kind: "cancelled",
        message: "tool call cancelled",
        stage: "invocation",
      },
      cancelled: true,
      success: false,
    },
  );

  const controller = new AbortController();
  const pending = registry.callTool({
    arguments: {},
    callId: "call-2",
    signal: controller.signal,
    tool: "wait",
    turnId: "turn-1",
  });
  controller.abort();
  assert.deepEqual(await pending, {
    callId: "call-2",
    contentItems: [{ type: "text", text: "tool call cancelled" }],
    error: {
      kind: "cancelled",
      message: "tool call cancelled",
      stage: "invocation",
    },
    cancelled: true,
    success: false,
  });
});

test("normalizes timeouts into timed-out results", async () => {
  const registry = createBrowserToolRegistry({
    bounds: { timeoutMs: 1 },
    tools: [
      {
        name: "wait",
        handle: async ({ signal }) =>
          new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(new DOMException("timeout", "TimeoutError"));
            });
            setTimeout(() => resolve({ contentItems: [], success: true }), 50);
          }),
      },
    ],
  });

  assert.deepEqual(
    await registry.callTool({
      arguments: {},
      callId: "call-1",
      tool: "wait",
      turnId: "turn-1",
    }),
    {
      callId: "call-1",
      contentItems: [{ type: "text", text: "tool call timed out" }],
      error: {
        kind: "timeout",
        message: "tool call timed out",
        stage: "invocation",
      },
      success: false,
      timedOut: true,
    },
  );
});

test("validates tool call envelopes without serializing signals", async () => {
  assert.deepEqual(
    normalizeToolCall({
      arguments: {},
      callId: "call-1",
      namespace: "workspace",
      signal: new AbortController().signal,
      startedAtMs: 123,
      tool: "echo",
      turnId: "turn-1",
    }),
    {
      arguments: {},
      bounds: {},
      callId: "call-1",
      namespace: "workspace",
      startedAtMs: 123,
      tool: "echo",
      turnId: "turn-1",
    },
  );
  assert.throws(
    () =>
      normalizeToolCall({
        arguments: {},
        callId: "call-1",
        namespace: "bad/name",
        tool: "echo",
        turnId: "turn-1",
      }),
    (error) =>
      error instanceof BrowserToolProtocolError &&
      error.kind === "invalid_identifier",
  );
  await assert.rejects(
    createBrowserToolRegistry().callTool({
        arguments: {},
        callId: "call-1",
        signal: {},
        tool: "echo",
        turnId: "turn-1",
      }),
    (error) =>
      error instanceof BrowserToolProtocolError && error.kind === "invalid_signal",
  );
});
