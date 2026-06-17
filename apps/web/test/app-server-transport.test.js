import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserCodexAppServerJsonRpcError,
  BrowserCodexAppServerLoopbackSocket,
  BrowserCodexAppServerTransportError,
  createBrowserCodexAppServerJsonRpcClient,
  createBrowserCodexAppServerLoopbackSocket,
} from "../src/app-server-transport.js";

const FIXED_NOW_MS = 1700000000000;

test("loopback socket emits ordered response and notification frames", async () => {
  const first = deferred();
  const second = deferred();
  const gates = new Map([
    [1, first],
    [2, second],
  ]);
  const calls = [];
  const socket = createBrowserCodexAppServerLoopbackSocket({
    runtime: {
      async handleMessage(rawMessage) {
        const message = JSON.parse(rawMessage);
        calls.push(message.id);
        await gates.get(message.id).promise;
        return [
          {
            jsonrpc: "2.0",
            id: message.id,
            result: { id: message.id },
          },
          {
            jsonrpc: "2.0",
            method: "transport/test",
            params: { id: message.id },
          },
        ];
      },
    },
  });
  const frames = [];
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(event.data));
  });

  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "first",
    }),
  );
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "second",
    }),
  );

  await Promise.resolve();
  assert.deepEqual(calls, [1]);
  second.resolve();
  await Promise.resolve();
  assert.deepEqual(frames, []);

  first.resolve();
  await socket.drain();

  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(
    frames.map((frame) => frame.method ?? `response:${frame.id}`),
    ["response:1", "transport/test", "response:2", "transport/test"],
  );
  assert.deepEqual(
    frames.map((frame) => frame.params?.id ?? frame.result?.id),
    [1, 1, 2, 2],
  );
});

test("JSON-RPC client initializes and sends initialized notification", async () => {
  const runtime = {
    initialized: false,
    async handleMessage(rawMessage) {
      const message = JSON.parse(rawMessage);
      if (message.method === "initialize") {
        return [
          {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              browserFixture: { browserHosted: true },
              clientInfo: message.params.clientInfo,
            },
          },
        ];
      }
      if (message.method === "initialized") {
        this.initialized = true;
        return [];
      }
      throw new Error(`unexpected method: ${message.method}`);
    },
  };
  const client = createBrowserCodexAppServerJsonRpcClient({ runtime });
  await client.ready;

  const initialize = await client.request("initialize", {
    clientInfo: { name: "transport-test" },
  });
  client.notify("initialized");
  await client.drain();

  assert.equal(initialize.browserFixture.browserHosted, true);
  assert.deepEqual(initialize.clientInfo, { name: "transport-test" });
  assert.equal(runtime.initialized, true);
});

test("JSON-RPC client reads account and receives login cancellation notification", async () => {
  const client = createBrowserCodexAppServerJsonRpcClient();
  const notifications = collectNotifications(client);

  const account = await client.request("account/read");
  const login = await client.request("account/login/start", {
    type: "chatgptDeviceCode",
  });
  const loginCompleted = client.waitForNotification(
    "account/login/completed",
    { replay: false },
  );
  const cancel = await client.request("account/login/cancel", {
    loginId: login.loginId,
  });
  const cancelNotification = await loginCompleted;

  assert.deepEqual(account, {
    account: null,
    requiresOpenaiAuth: true,
  });
  assert.equal(login.loginId, "browser-login-1");
  assert.equal(login.type, "chatgptDeviceCode");
  assert.equal(login.userCode, "BROWSER-0001");
  assert.deepEqual(cancel, { status: "canceled" });
  assert.deepEqual(
    notifications.map((message) => message.method),
    ["account/login/completed"],
  );
  assert.deepEqual(notifications[0].params, {
    error: "Device login canceled.",
    loginId: "browser-login-1",
    success: false,
  });
  assert.strictEqual(cancelNotification, notifications[0]);
  assert.deepEqual(client.notifications, notifications);
});

test("JSON-RPC client honors thread notification opt-out", async () => {
  const client = createBrowserCodexAppServerJsonRpcClient();
  const notifications = collectNotifications(client);

  await client.request("initialize", {
    capabilities: {
      optOutNotificationMethods: ["thread/started"],
    },
  });
  const thread = await client.request("thread/start", {});

  assert.equal(thread.thread.id, "browser-thread-1");
  assert.deepEqual(notifications, []);
});

test("JSON-RPC client receives mocked turn completion notifications", async () => {
  const client = createBrowserCodexAppServerJsonRpcClient({
    runtimeOptions: {
      modelResponseText: ({ inputText }) => `transport response: ${inputText}`,
      now: () => FIXED_NOW_MS,
    },
  });
  const notifications = collectNotifications(client);
  const thread = await client.request("thread/start", {});
  notifications.length = 0;
  const turnCompleted = client.waitForNotification("turn/completed", {
    replay: false,
  });

  const turn = await client.request("turn/start", {
    clientUserMessageId: null,
    input: [{ type: "text", text: "hello transport", textElements: [] }],
    threadId: thread.thread.id,
  });

  assert.equal(turn.turn.id, "browser-turn-1");
  assert.equal(turn.turn.status, "inProgress");
  assert.deepEqual(
    notifications.map((message) => message.method),
    ["turn/started", "item/completed", "turn/completed"],
  );
  assert.equal(
    notifications[1].params.item.text,
    "transport response: hello transport",
  );
  assert.equal(notifications[1].params.completedAtMs, FIXED_NOW_MS);
  assert.equal(notifications[2].params.turn.status, "completed");
  assert.strictEqual(await turnCompleted, notifications[2]);
  assert.deepEqual(notifications[2].params.turn.items, [
    {
      id: "browser-item-1",
      memoryCitation: null,
      phase: null,
      text: "transport response: hello transport",
      type: "agentMessage",
    },
  ]);
});

test("JSON-RPC client interrupts pending turns", async () => {
  const client = createBrowserCodexAppServerJsonRpcClient({
    runtimeOptions: {
      autoCompleteTurns: false,
      now: () => FIXED_NOW_MS,
    },
  });
  const notifications = collectNotifications(client);
  const thread = await client.request("thread/start", {});
  notifications.length = 0;
  const turn = await client.request("turn/start", {
    input: [{ type: "text", text: "wait", textElements: [] }],
    threadId: thread.thread.id,
  });

  assert.deepEqual(
    notifications.map((message) => message.method),
    ["turn/started"],
  );

  const interrupt = await client.request("turn/interrupt", {
    threadId: thread.thread.id,
    turnId: turn.turn.id,
  });

  assert.deepEqual(interrupt, {});
  assert.deepEqual(
    notifications.map((message) => message.method),
    ["turn/started", "turn/completed"],
  );
  assert.equal(notifications[1].params.turn.status, "interrupted");
  assert.equal(notifications[1].params.turn.completedAt, FIXED_NOW_MS / 1000);
});

test("JSON-RPC client rejects unsupported methods with structured errors", async () => {
  const client = createBrowserCodexAppServerJsonRpcClient();

  await assert.rejects(
    client.request("native/process/spawn", {}),
    (error) => {
      assert(error instanceof BrowserCodexAppServerJsonRpcError);
      assert.equal(error.code, -32601);
      assert.equal(error.data.kind, "unsupported_capability");
      assert.equal(error.data.stage, "app_server");
      assert.equal(error.data.method, "native/process/spawn");
      assert.equal(error.data.browserHosted, true);
      return true;
    },
  );
});

test("loopback socket returns JSON-RPC errors for malformed frames", async () => {
  const socket = createBrowserCodexAppServerLoopbackSocket();
  const frames = [];
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(event.data));
  });

  socket.send("{");
  socket.send("[]");
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "account",
      method: "account/read",
    }),
  );
  await socket.drain();

  assert.equal(frames[0].id, null);
  assert.equal(frames[0].error.code, -32700);
  assert.equal(frames[0].error.data.kind, "parse_error");
  assert.equal(frames[1].id, null);
  assert.equal(frames[1].error.code, -32600);
  assert.equal(frames[1].error.data.kind, "invalid_request");
  assert.deepEqual(frames[2], {
    jsonrpc: "2.0",
    id: "account",
    result: {
      account: null,
      requiresOpenaiAuth: true,
    },
  });
  assert.equal(socket.readyState, BrowserCodexAppServerLoopbackSocket.OPEN);
});

test("close rejects pending requests and prevents later sends", async () => {
  const gate = deferred();
  const socket = createBrowserCodexAppServerLoopbackSocket({
    runtime: {
      async handleMessage(rawMessage) {
        const message = JSON.parse(rawMessage);
        await gate.promise;
        return [
          {
            jsonrpc: "2.0",
            id: message.id,
            result: { ok: true },
          },
        ];
      },
    },
  });
  const client = createBrowserCodexAppServerJsonRpcClient({ socket });
  const closeEvent = once(client, "close");
  const waitingNotification = client.waitForNotification("never", {
    timeoutMs: 0,
  });
  const pending = client.request("slow", {});
  const rejection = assert.rejects(
    pending,
    (error) =>
      error instanceof BrowserCodexAppServerTransportError &&
      error.code === "closed",
  );
  const notificationRejection = assert.rejects(
    waitingNotification,
    (error) =>
      error instanceof BrowserCodexAppServerTransportError &&
      error.code === "closed",
  );

  client.close(4000, "unit test");

  await rejection;
  await notificationRejection;
  const event = await closeEvent;
  assert.equal(event.code, 4000);
  assert.equal(event.reason, "unit test");
  assert.equal(socket.readyState, BrowserCodexAppServerLoopbackSocket.CLOSED);
  assert.throws(
    () => client.request("after-close", {}),
    /JSON-RPC client is closed/,
  );
  assert.throws(
    () => socket.send(JSON.stringify({ jsonrpc: "2.0", method: "noop" })),
    /loopback socket is not open/,
  );

  gate.resolve();
  await socket.drain();
});

function collectNotifications(client) {
  const notifications = [];
  client.addEventListener("notification", (event) => {
    notifications.push(event.message);
  });
  return notifications;
}

function once(target, type) {
  return new Promise((resolve) => {
    target.addEventListener(type, resolve, { once: true });
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
