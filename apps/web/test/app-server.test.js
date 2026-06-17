import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserCodexAppServerRuntime } from "../src/app-server.js";

const FIXED_NOW_MS = 1700000000000;

test("browser app-server initializes and accepts initialized notifications", async () => {
  const runtime = createBrowserCodexAppServerRuntime();

  const messages = await runtime.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: ["thread/started"],
        },
        clientInfo: { name: "unit-test" },
      },
    }),
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 1);
  assert.equal(messages[0].result.userAgent, "wasm-host-browser-app-server/0.0.0");
  assert.equal(messages[0].result.codexHome, "/browser/.codex");
  assert.equal(messages[0].result.platformFamily, "browser");
  assert.equal(messages[0].result.platformOs, "web");
  assert.equal(messages[0].result.browserFixture.browserHosted, true);
  assert.equal(messages[0].result.browserFixture.deterministicFixture, true);
  assert(messages[0].result.browserFixture.methods.includes("turn/start"));
  assert.deepEqual(
    await runtime.handleMessage({
      jsonrpc: "2.0",
      method: "initialized",
    }),
    [],
  );
});

test("browser app-server reports account status and device login cancellation", async () => {
  const runtime = createBrowserCodexAppServerRuntime();

  const account = await runtime.handleMessage({
    jsonrpc: "2.0",
    id: "account",
    method: "account/read",
  });
  assert.deepEqual(account, [
    {
      jsonrpc: "2.0",
      id: "account",
      result: {
        account: null,
        requiresOpenaiAuth: true,
      },
    },
  ]);

  const login = await runtime.handleMessage({
    jsonrpc: "2.0",
    id: "login",
    method: "account/login/start",
    params: { type: "chatgptDeviceCode" },
  });
  assert.equal(login[0].result.type, "chatgptDeviceCode");
  assert.equal(login[0].result.loginId, "browser-login-1");
  assert.equal(login[0].result.userCode, "BROWSER-0001");
  assert.equal(login[0].result.verificationUrl, "https://auth.example.test/device");

  const cancelled = await runtime.handleMessage({
    jsonrpc: "2.0",
    id: "cancel",
    method: "account/login/cancel",
    params: { loginId: login[0].result.loginId },
  });
  assert.deepEqual(cancelled, [
    {
      jsonrpc: "2.0",
      id: "cancel",
      result: { status: "canceled" },
    },
    {
      jsonrpc: "2.0",
      method: "account/login/completed",
      params: {
        error: "Device login canceled.",
        loginId: "browser-login-1",
        success: false,
      },
    },
  ]);

  assert.deepEqual(
    await runtime.handleMessage({
      jsonrpc: "2.0",
      id: "missing-cancel",
      method: "account/login/cancel",
      params: { loginId: "missing" },
    }),
    [
      {
        jsonrpc: "2.0",
        id: "missing-cancel",
        result: { status: "notFound" },
      },
    ],
  );
});

test("browser app-server starts threads and completes mocked turns", async () => {
  const runtime = createBrowserCodexAppServerRuntime({
    modelResponseText: ({ inputText }) => `browser response: ${inputText}`,
    now: () => FIXED_NOW_MS,
  });

  const threadMessages = await runtime.handleMessage({
    jsonrpc: "2.0",
    id: "thread",
    method: "thread/start",
    params: { model: "gpt-5.1" },
  });
  assert.equal(threadMessages.length, 2);
  assert.equal(threadMessages[0].result.thread.id, "browser-thread-1");
  assert.equal(threadMessages[0].result.thread.source, "appServer");
  assert.deepEqual(threadMessages[0].result.thread.status, { type: "idle" });
  assert.equal(threadMessages[0].result.thread.createdAt, FIXED_NOW_MS / 1000);
  assert.equal(threadMessages[1].method, "thread/started");

  const turnMessages = await runtime.handleMessage({
    jsonrpc: "2.0",
    id: "turn",
    method: "turn/start",
    params: {
      clientUserMessageId: null,
      input: [{ type: "text", text: "hello app-server", textElements: [] }],
      threadId: threadMessages[0].result.thread.id,
    },
  });

  assert.equal(turnMessages[0].result.turn.id, "browser-turn-1");
  assert.equal(turnMessages[0].result.turn.status, "inProgress");
  assert.deepEqual(
    turnMessages.slice(1).map((message) => message.method),
    ["turn/started", "item/completed", "turn/completed"],
  );
  assert.deepEqual(turnMessages[2].params, {
    completedAtMs: FIXED_NOW_MS,
    item: {
      id: "browser-item-1",
      memoryCitation: null,
      phase: null,
      text: "browser response: hello app-server",
      type: "agentMessage",
    },
    threadId: "browser-thread-1",
    turnId: "browser-turn-1",
  });
  assert.equal(turnMessages[3].params.turn.status, "completed");
  assert.equal(turnMessages[3].params.turn.durationMs, 0);
  assert.deepEqual(turnMessages[3].params.turn.items, [
    {
      id: "browser-item-1",
      memoryCitation: null,
      phase: null,
      text: "browser response: hello app-server",
      type: "agentMessage",
    },
  ]);
});

test("browser app-server interrupts pending turns", async () => {
  const runtime = createBrowserCodexAppServerRuntime({
    autoCompleteTurns: false,
    now: () => FIXED_NOW_MS,
  });
  const [thread] = await runtime.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "thread/start",
    params: {},
  });
  const turnMessages = await runtime.handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "turn/start",
    params: {
      input: [{ type: "text", text: "wait", textElements: [] }],
      threadId: thread.result.thread.id,
    },
  });
  assert.deepEqual(
    turnMessages.map((message) => message.method ?? "response"),
    ["response", "turn/started"],
  );

  const interrupted = await runtime.handleMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "turn/interrupt",
    params: {
      threadId: thread.result.thread.id,
      turnId: turnMessages[0].result.turn.id,
    },
  });
  assert.deepEqual(interrupted, [
    {
      jsonrpc: "2.0",
      id: 3,
      result: {},
    },
    {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "browser-thread-1",
        turn: {
          completedAt: FIXED_NOW_MS / 1000,
          durationMs: 0,
          error: null,
          id: "browser-turn-1",
          items: [],
          itemsView: "full",
          startedAt: FIXED_NOW_MS / 1000,
          status: "interrupted",
        },
      },
    },
  ]);
});

test("browser app-server returns structured errors for unsupported methods", async () => {
  const runtime = createBrowserCodexAppServerRuntime();

  const [message] = await runtime.handleMessage({
    jsonrpc: "2.0",
    id: "spawn",
    method: "native/process/spawn",
    params: {},
  });

  assert.equal(message.id, "spawn");
  assert.equal(message.error.code, -32601);
  assert.equal(message.error.data.kind, "unsupported_capability");
  assert.equal(message.error.data.stage, "app_server");
  assert.equal(message.error.data.method, "native/process/spawn");
  assert.equal(message.error.data.browserHosted, true);
});

test("browser app-server returns JSON-RPC parse and envelope errors", async () => {
  const runtime = createBrowserCodexAppServerRuntime();

  const [parseError] = await runtime.handleMessage("{");
  assert.equal(parseError.id, null);
  assert.equal(parseError.error.code, -32700);
  assert.equal(parseError.error.data.kind, "parse_error");

  const [envelopeError] = await runtime.handleMessage({
    jsonrpc: "1.0",
    id: 1,
    method: "initialize",
  });
  assert.equal(envelopeError.id, 1);
  assert.equal(envelopeError.error.code, -32600);
  assert.equal(envelopeError.error.data.kind, "invalid_request");
});

test("browser app-server rejects turns that exceed the notification bound", async () => {
  const runtime = createBrowserCodexAppServerRuntime({
    maxNotificationsPerTurn: 2,
  });
  const [thread] = await runtime.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "thread/start",
    params: {},
  });

  const [message] = await runtime.handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "turn/start",
    params: {
      input: [{ type: "text", text: "too many", textElements: [] }],
      threadId: thread.result.thread.id,
    },
  });

  assert.equal(message.id, 2);
  assert.equal(message.error.code, -32001);
  assert.equal(message.error.data.kind, "resource_limit");
  assert.equal(message.error.data.limit, 2);
});
