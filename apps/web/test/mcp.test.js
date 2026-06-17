import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_MCP_ECHO_TOOL_NAME,
  BrowserMcpTransportError,
  createBrowserMcpLoopbackClient,
  createBrowserMcpLoopbackRuntime,
  validateBrowserMcpServerConfig,
} from "../src/mcp.js";

test("browser MCP loopback client lists and calls the built-in tool", async () => {
  const client = createBrowserMcpLoopbackClient();

  const listed = await client.listTools();
  const result = await client.callTool(BROWSER_MCP_ECHO_TOOL_NAME, {
    count: 2,
    text: "hello browser",
  });

  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    [BROWSER_MCP_ECHO_TOOL_NAME],
  );
  assert.deepEqual(listed.tools[0].inputSchema, {
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
  });
  assert.deepEqual(result, {
    content: [
      {
        type: "text",
        text:
          "browser.echo\n" +
          'input={"count":2,"text":"hello browser"}\n' +
          "summary=keys=count,text\n" +
          "text=hello browser",
      },
    ],
  });
});

test("browser MCP runtime handles MCP-like tools/list and tools/call frames", async () => {
  const runtime = createBrowserMcpLoopbackRuntime();

  const [listed] = await runtime.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "list",
      method: "tools/list",
      params: {},
    }),
  );
  const [called] = await runtime.handleMessage({
    jsonrpc: "2.0",
    id: "call",
    method: "tools/call",
    params: {
      arguments: {
        message: "runtime",
      },
      name: BROWSER_MCP_ECHO_TOOL_NAME,
    },
  });

  assert.equal(listed.jsonrpc, "2.0");
  assert.equal(listed.id, "list");
  assert.equal(listed.result.tools[0].name, BROWSER_MCP_ECHO_TOOL_NAME);
  assert.equal(called.id, "call");
  assert.deepEqual(called.result.content, [
    {
      type: "text",
      text:
        "browser.echo\n" +
        'input={"message":"runtime"}\n' +
        "summary=keys=message\n" +
        "text=runtime",
    },
  ]);
});

test("browser MCP client reports unknown tools with structured errors", async () => {
  const client = createBrowserMcpLoopbackClient();

  await assert.rejects(
    client.callTool("browser.missing", {}),
    (error) => {
      assert(error instanceof BrowserMcpTransportError);
      assert.equal(error.kind, "tool_not_found");
      assert.equal(error.code, "tool_not_found");
      assert.equal(error.rpcCode, -32602);
      assert.equal(error.data.name, "browser.missing");
      assert.equal(error.data.browserHosted, true);
      return true;
    },
  );
});

test("browser MCP runtime rejects oversized tool results", async () => {
  const client = createBrowserMcpLoopbackClient({
    maxResultBytes: 96,
  });

  await assert.rejects(
    client.callTool(BROWSER_MCP_ECHO_TOOL_NAME, {
      text: "x".repeat(120),
    }),
    (error) => {
      assert(error instanceof BrowserMcpTransportError);
      assert.equal(error.kind, "result_too_large");
      assert.equal(error.code, "result_too_large");
      assert.equal(error.rpcCode, -32001);
      assert.equal(error.data.maxResultBytes, 96);
      assert(error.data.resultBytes > 96);
      return true;
    },
  );
});

test("browser MCP server config validation rejects native-only capabilities", () => {
  const unsupportedConfigs = [
    {
      transport: "stdio",
    },
    {
      command: "node",
      args: ["server.js"],
    },
    {
      mcpServers: {
        local: {
          command: "npx",
        },
      },
    },
    {
      transport: {
        type: "local-process",
      },
    },
    {
      localProcess: {
        command: "node",
      },
    },
  ];

  for (const config of unsupportedConfigs) {
    assert.throws(
      () => validateBrowserMcpServerConfig(config),
      (error) => {
        assert(error instanceof BrowserMcpTransportError);
        assert.equal(error.kind, "unsupported_capability");
        assert.equal(error.code, "unsupported_capability");
        assert.equal(error.rpcCode, -32601);
        assert.match(error.data.capability, /^(stdio|local_process)$/);
        assert.equal(error.data.browserHosted, true);
        return true;
      },
    );
  }
  assert.strictEqual(
    validateBrowserMcpServerConfig({
      name: "browser-loopback",
      transport: "browser-loopback",
    }).transport,
    "browser-loopback",
  );
});

test("browser MCP client supports abort cancellation", async () => {
  const gate = deferred();
  const client = createBrowserMcpLoopbackClient({
    includeDefaultTools: false,
    tools: [
      {
        name: "browser.wait",
        description: "waits until cancelled or released",
        inputSchema: {
          type: "object",
        },
        async call(_input, context) {
          await waitForGate(gate, context.signal);
          return "done";
        },
      },
    ],
  });
  const controller = new AbortController();

  const pending = client.callTool("browser.wait", {}, {
    signal: controller.signal,
  });
  await tick();
  controller.abort();

  await assert.rejects(pending, (error) => {
    assert(error instanceof BrowserMcpTransportError);
    assert.equal(error.kind, "cancelled");
    assert.equal(error.code, "cancelled");
    return true;
  });
  gate.resolve();
});

test("browser MCP client close rejects pending and future calls", async () => {
  const gate = deferred();
  const client = createBrowserMcpLoopbackClient({
    includeDefaultTools: false,
    tools: [
      {
        name: "browser.wait",
        description: "waits until closed or released",
        inputSchema: {
          type: "object",
        },
        async call(_input, context) {
          await waitForGate(gate, context.signal);
          return "done";
        },
      },
    ],
  });

  const pending = client.callTool("browser.wait", {});
  await tick();
  client.close();

  await assert.rejects(pending, (error) => {
    assert(error instanceof BrowserMcpTransportError);
    assert.equal(error.kind, "closed");
    assert.equal(error.code, "closed");
    return true;
  });
  assert.throws(
    () => client.listTools(),
    (error) => {
      assert(error instanceof BrowserMcpTransportError);
      assert.equal(error.kind, "closed");
      return true;
    },
  );
  gate.resolve();
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return {
    promise,
    reject,
    resolve,
  };
}

function waitForGate(gate, signal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    gate.promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function tick() {
  return Promise.resolve();
}
