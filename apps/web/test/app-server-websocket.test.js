import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserCodexAppServerLoopbackSocket,
  BrowserCodexAppServerTransportError,
  createBrowserCodexAppServerJsonRpcClient,
} from "../src/app-server-transport.js";
import {
  BROWSER_CODEX_APP_SERVER_WEBSOCKET_PROTOCOL,
  BrowserCodexAppServerWebSocket,
  DEFAULT_BROWSER_CODEX_APP_SERVER_LOOPBACK_URL,
  DEFAULT_BROWSER_CODEX_APP_SERVER_WEBSOCKET_URL,
  createBrowserCodexAppServerWebSocketConstructor,
  createBrowserCodexAppServerWebSocketFactory,
} from "../src/app-server-websocket.js";

const FIXED_NOW_MS = 1700000000000;

test("WebSocket constructor drives initialize, account, thread, and turn JSON-RPC", async () => {
  const WebSocketConstructor =
    createBrowserCodexAppServerWebSocketConstructor({
      runtimeOptions: {
        modelResponseText: ({ inputText }) =>
          `websocket response: ${inputText}`,
        now: () => FIXED_NOW_MS,
      },
    });
  const socket = new WebSocketConstructor(
    DEFAULT_BROWSER_CODEX_APP_SERVER_WEBSOCKET_URL,
    BROWSER_CODEX_APP_SERVER_WEBSOCKET_PROTOCOL,
  );
  const client = createBrowserCodexAppServerJsonRpcClient({ socket });
  const notifications = collectNotifications(client);

  await client.ready;
  const initialize = await client.request("initialize", {
    clientInfo: { name: "websocket-test" },
  });
  client.notify("initialized");
  await client.drain();
  const account = await client.request("account/read");
  const thread = await client.request("thread/start", {});
  const turnCompleted = client.waitForNotification("turn/completed", {
    replay: false,
  });
  const turn = await client.request("turn/start", {
    clientUserMessageId: null,
    input: [{ type: "text", text: "hello websocket", textElements: [] }],
    threadId: thread.thread.id,
  });

  assert(socket instanceof BrowserCodexAppServerLoopbackSocket);
  assert.equal(
    DEFAULT_BROWSER_CODEX_APP_SERVER_WEBSOCKET_URL,
    DEFAULT_BROWSER_CODEX_APP_SERVER_LOOPBACK_URL,
  );
  assert.equal(socket.url, DEFAULT_BROWSER_CODEX_APP_SERVER_WEBSOCKET_URL);
  assert.equal(socket.protocol, BROWSER_CODEX_APP_SERVER_WEBSOCKET_PROTOCOL);
  assert.equal(initialize.browserFixture.browserHosted, true);
  assert.deepEqual(account, {
    account: null,
    requiresOpenaiAuth: true,
  });
  assert.equal(thread.thread.id, "browser-thread-1");
  assert.equal(turn.turn.id, "browser-turn-1");
  assert.equal(
    notifications.find(
      (notification) => notification.method === "item/completed",
    ).params.item.text,
    "websocket response: hello websocket",
  );
  assert.equal((await turnCompleted).params.turn.status, "completed");
});

test("constructed WebSocket sockets own isolated runtime counters by default", async () => {
  const WebSocketConstructor =
    createBrowserCodexAppServerWebSocketConstructor();
  const first = createBrowserCodexAppServerJsonRpcClient({
    socket: new WebSocketConstructor(),
  });
  const second = createBrowserCodexAppServerJsonRpcClient({
    socket: new WebSocketConstructor(),
  });
  await Promise.all([first.ready, second.ready]);

  const firstLogin = await first.request("account/login/start", {
    type: "chatgptDeviceCode",
  });
  const secondLogin = await second.request("account/login/start", {
    type: "chatgptDeviceCode",
  });
  const firstThread = await first.request("thread/start", {});
  const secondThread = await second.request("thread/start", {});
  const firstTurn = await first.request("turn/start", {
    input: [{ type: "text", text: "first", textElements: [] }],
    threadId: firstThread.thread.id,
  });
  const secondTurn = await second.request("turn/start", {
    input: [{ type: "text", text: "second", textElements: [] }],
    threadId: secondThread.thread.id,
  });

  assert.equal(firstLogin.loginId, "browser-login-1");
  assert.equal(secondLogin.loginId, "browser-login-1");
  assert.equal(firstThread.thread.id, "browser-thread-1");
  assert.equal(secondThread.thread.id, "browser-thread-1");
  assert.equal(firstTurn.turn.id, "browser-turn-1");
  assert.equal(secondTurn.turn.id, "browser-turn-1");
});

test("WebSocket factory accepts loopback WebSocket URLs and supported protocols", async () => {
  const createSocket = createBrowserCodexAppServerWebSocketFactory();
  const socket = createSocket("ws://browser-codex-app-server/loopback", [
    "ignored",
    BROWSER_CODEX_APP_SERVER_WEBSOCKET_PROTOCOL,
  ]);
  const client = createBrowserCodexAppServerJsonRpcClient({ socket });

  await client.ready;
  const thread = await client.request("thread/start", {});

  assert.equal(socket.url, "ws://browser-codex-app-server/loopback");
  assert.equal(socket.protocol, BROWSER_CODEX_APP_SERVER_WEBSOCKET_PROTOCOL);
  assert.equal(thread.thread.id, "browser-thread-1");
});

test("WebSocket constructor rejects unsupported URLs and protocols", () => {
  const WebSocketConstructor =
    createBrowserCodexAppServerWebSocketConstructor();

  assert.throws(
    () => new WebSocketConstructor("ws://example.test/app-server"),
    (error) => {
      assert(error instanceof BrowserCodexAppServerTransportError);
      assert.equal(error.code, "unsupported_url");
      return true;
    },
  );
  assert.throws(
    () =>
      new WebSocketConstructor(
        DEFAULT_BROWSER_CODEX_APP_SERVER_WEBSOCKET_URL,
        "native-app-server",
      ),
    (error) => {
      assert(error instanceof BrowserCodexAppServerTransportError);
      assert.equal(error.code, "unsupported_protocol");
      return true;
    },
  );
  assert.throws(
    () =>
      new BrowserCodexAppServerWebSocket(
        DEFAULT_BROWSER_CODEX_APP_SERVER_WEBSOCKET_URL,
        ["native-app-server"],
      ),
    (error) => {
      assert(error instanceof BrowserCodexAppServerTransportError);
      assert.equal(error.code, "unsupported_protocol");
      return true;
    },
  );
});

test("WebSocket sockets emit open and close events", async () => {
  const WebSocketConstructor =
    createBrowserCodexAppServerWebSocketConstructor();
  const socket = new WebSocketConstructor();
  const opened = once(socket, "open");

  assert.equal(socket.readyState, WebSocketConstructor.OPEN);
  assert.equal(
    socket.CONNECTING,
    BrowserCodexAppServerLoopbackSocket.CONNECTING,
  );
  assert.equal(socket.OPEN, BrowserCodexAppServerLoopbackSocket.OPEN);

  const openEvent = await opened;
  assert.strictEqual(openEvent.target, socket);

  const closed = once(socket, "close");
  socket.close(4000, "websocket test");
  const closeEvent = await closed;

  assert.equal(closeEvent.code, 4000);
  assert.equal(closeEvent.reason, "websocket test");
  assert.equal(closeEvent.wasClean, true);
  assert.equal(socket.readyState, WebSocketConstructor.CLOSED);
  assert.throws(
    () => socket.send(JSON.stringify({ jsonrpc: "2.0", method: "noop" })),
    (error) =>
      error instanceof BrowserCodexAppServerTransportError &&
      error.code === "closed",
  );
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
