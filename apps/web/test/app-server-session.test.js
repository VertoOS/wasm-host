import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserCodexAppServerJsonRpcError,
  BrowserCodexAppServerTransportError,
} from "../src/app-server-transport.js";
import {
  BrowserCodexAppServerSession,
  BrowserCodexAppServerSessionError,
  createBrowserCodexAppServerSession,
} from "../src/app-server-session.js";

const FIXED_NOW_MS = 1700000000000;

test("browser app-server session happy path initializes, reads account, and starts a prompt turn", async () => {
  const session = createBrowserCodexAppServerSession({
    runtimeOptions: {
      modelResponseText: ({ inputText }) => `session response: ${inputText}`,
      now: () => FIXED_NOW_MS,
    },
  });

  assert(session instanceof BrowserCodexAppServerSession);
  assert.equal(session.connected, false);

  const initialize = await session.connect({
    clientInfo: { name: "session-test" },
  });
  const sameInitialize = await session.initialize();
  const account = await session.readAccount();
  const thread = await session.ensureThread();
  const turn = await session.startPromptTurn("hello session");

  assert.equal(initialize.browserFixture.browserHosted, true);
  assert.strictEqual(sameInitialize, initialize);
  assert.equal(session.connected, true);
  assert.deepEqual(account, {
    account: null,
    requiresOpenaiAuth: true,
  });
  assert.equal(session.account, null);
  assert.strictEqual(session.accountStatus, account);
  assert.equal(thread.reused, false);
  assert.equal(thread.threadId, "browser-thread-1");
  assert.equal(session.threadId, "browser-thread-1");
  assert.equal(turn.threadId, "browser-thread-1");
  assert.equal(turn.turn.id, "browser-turn-1");
  assert.equal(turn.item.text, "session response: hello session");
  assert.equal(session.activeTurnId, null);
  assert.deepEqual(
    session.notifications.map((notification) => notification.method),
    ["thread/started", "turn/started", "item/completed", "turn/completed"],
  );
  assert.equal(
    session.transcript.find((entry) => entry.method === "item/completed")
      .params.item.text,
    "session response: hello session",
  );
});

test("browser app-server session tracks and clears canceled device logins", async () => {
  const session = createBrowserCodexAppServerSession();
  await session.connect();

  const login = await session.startDeviceLogin();
  const cancel = await session.cancelDeviceLogin();

  assert.equal(login.loginId, "browser-login-1");
  assert.equal(login.type, "chatgptDeviceCode");
  assert.equal(session.activeLoginId, null);
  assert.deepEqual(cancel.result, { status: "canceled" });
  assert.equal(cancel.completion.method, "account/login/completed");
  assert.deepEqual(cancel.completion.params, {
    error: "Device login canceled.",
    loginId: "browser-login-1",
    success: false,
  });
  assert.equal(
    session.findNotification("account/login/completed").params.loginId,
    "browser-login-1",
  );
});

test("browser app-server session reuses an existing thread", async () => {
  const session = createBrowserCodexAppServerSession();
  await session.connect();

  const first = await session.ensureThread();
  const second = await session.ensureThread();

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.threadId, first.threadId);
  assert.equal(session.threadId, "browser-thread-1");
  assert.equal(
    session.notifications.filter(
      (notification) => notification.method === "thread/started",
    ).length,
    1,
  );
});

test("browser app-server session collects mocked turn text without replaying old turn notifications", async () => {
  const session = createBrowserCodexAppServerSession({
    runtimeOptions: {
      modelResponseText: ({ inputText }) => `mocked text: ${inputText}`,
      now: () => FIXED_NOW_MS,
    },
  });
  await session.connect();

  const first = await session.startPromptTurn("first");
  const second = await session.startPromptTurn("second");

  assert.equal(first.item.text, "mocked text: first");
  assert.equal(second.item.text, "mocked text: second");
  assert.equal(second.turn.id, "browser-turn-2");
  assert.deepEqual(
    session.notifications
      .filter((notification) => notification.method === "item/completed")
      .map((notification) => notification.params.item.text),
    ["mocked text: first", "mocked text: second"],
  );
});

test("browser app-server session starts a pending turn and interrupts it", async () => {
  const session = createBrowserCodexAppServerSession({
    runtimeOptions: {
      autoCompleteTurns: false,
      now: () => FIXED_NOW_MS,
    },
  });
  await session.connect();

  const pending = await session.startPendingTurn("wait");

  assert.equal(pending.turn.id, "browser-turn-1");
  assert.equal(pending.notification.method, "turn/started");
  assert.equal(session.activeTurnId, "browser-turn-1");

  const interrupt = await session.interruptTurn();

  assert.deepEqual(interrupt.result, {});
  assert.equal(interrupt.notification.method, "turn/completed");
  assert.equal(interrupt.notification.params.turn.status, "interrupted");
  assert.equal(interrupt.notification.params.turn.completedAt, FIXED_NOW_MS / 1000);
  assert.equal(session.activeTurnId, null);
});

test("browser app-server session surfaces unsupported method errors", async () => {
  const session = createBrowserCodexAppServerSession();
  await session.connect();

  await assert.rejects(
    session.request("native/process/spawn", {}),
    (error) => {
      assert(error instanceof BrowserCodexAppServerJsonRpcError);
      assert.equal(error.code, -32601);
      assert.equal(error.data.kind, "unsupported_capability");
      assert.equal(error.data.method, "native/process/spawn");
      return true;
    },
  );
  assert.equal(session.connected, true);
});

test("browser app-server session reports close and local misuse", async () => {
  const session = createBrowserCodexAppServerSession();

  await assert.rejects(
    session.readAccount(),
    (error) =>
      error instanceof BrowserCodexAppServerSessionError &&
      error.code === "not_connected",
  );

  await session.connect();
  await assert.rejects(
    session.interruptTurn(),
    (error) =>
      error instanceof BrowserCodexAppServerSessionError &&
      error.code === "missing_turn",
  );

  session.close(4000, "unit test");
  session.close(4000, "unit test");
  await Promise.resolve();

  assert.equal(session.closed, true);
  assert.equal(session.connected, false);
  assert.equal(
    session.transcript.find((entry) => entry.type === "close").reason,
    "unit test",
  );
  await assert.rejects(
    session.startDeviceLogin(),
    (error) =>
      error instanceof BrowserCodexAppServerSessionError &&
      error.code === "closed",
  );
  assert.throws(
    () => session.client.request("after-close", {}),
    (error) =>
      error instanceof BrowserCodexAppServerTransportError &&
      error.code === "closed",
  );
});
