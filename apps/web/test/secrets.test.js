import assert from "node:assert/strict";
import test from "node:test";

import {
  createFakeBrowserDeviceFlowAuthBroker,
  resolveBrowserBearerSecret,
} from "../src/secrets.js";

const SECRET_REF = "codex-model-auth";
const SECRET_TOKEN = "fake-device-flow-token";
const INVALID_TOKEN = "invalid-token\nwith-newline";

test("fake device auth broker completes externally and stores bearer secrets", async () => {
  let now = 1_000;
  const auth = createFakeBrowserDeviceFlowAuthBroker({
    expiresInMs: 60_000,
    now: () => now,
    verificationUri: "https://auth.example.test/device",
  });

  const started = await auth.startDeviceLogin({
    scopes: ["model:responses"],
    secretRef: SECRET_REF,
    userCode: "CODEX-1234",
  });

  assert.deepEqual(started, {
    account: null,
    accountHint: null,
    completedAt: null,
    createdAt: 1_000,
    expiresAt: 61_000,
    intervalMs: 5_000,
    loginId: "device-login-1",
    scopes: ["model:responses"],
    secretRef: SECRET_REF,
    sessionId: null,
    status: "pending",
    userCode: "CODEX-1234",
    verificationUri: "https://auth.example.test/device",
    verificationUriComplete: null,
  });
  assertNoLeak(started, [SECRET_TOKEN]);

  now = 2_000;
  const completed = await auth.completeDeviceLogin(started.loginId, {
    account: {
      access_token: SECRET_TOKEN,
      email: "user@example.test",
      id: "acct_test",
      nested: { ignored: true },
      refresh_secret: SECRET_TOKEN,
    },
    bearerToken: SECRET_TOKEN,
  });

  assert.deepEqual(completed.account, {
    email: "user@example.test",
    id: "acct_test",
  });
  assert.equal(completed.completedAt, 2_000);
  assert.equal(completed.sessionId, "device-session-1");
  assert.equal(completed.status, "authorized");
  assert.equal(auth.hasSecret(SECRET_REF), true);
  assert.equal(await auth.getBearerToken(SECRET_REF), SECRET_TOKEN);
  assert.equal(
    await resolveBrowserBearerSecret(auth, SECRET_REF),
    SECRET_TOKEN,
  );
  assert.deepEqual(await auth.getSessionStatus(completed.sessionId), {
    account: {
      email: "user@example.test",
      id: "acct_test",
    },
    completedAt: 2_000,
    loggedOutAt: null,
    scopes: ["model:responses"],
    secretRef: SECRET_REF,
    sessionId: "device-session-1",
    status: "authorized",
  });
  assertNoLeak(completed, [SECRET_TOKEN]);
});

test("fake device auth broker classifies terminal login states", async () => {
  let now = 10;
  const auth = createFakeBrowserDeviceFlowAuthBroker({
    expiresInMs: 5,
    now: () => now,
  });

  const denied = await auth.startDeviceLogin({ loginId: "denied" });
  assert.equal((await auth.denyDeviceLogin(denied.loginId)).status, "denied");
  await assertRejectsKind(
    () => auth.completeDeviceLogin(denied.loginId, { bearerToken: SECRET_TOKEN }),
    "auth_denied",
  );

  const expired = await auth.startDeviceLogin({ loginId: "expired" });
  now = 20;
  assert.equal((await auth.pollDeviceLogin(expired.loginId)).status, "expired");
  await assertRejectsKind(
    () => auth.completeDeviceLogin(expired.loginId, { bearerToken: SECRET_TOKEN }),
    "auth_expired",
  );

  now = 30;
  const cancelled = await auth.startDeviceLogin({ loginId: "cancelled" });
  assert.equal(
    (await auth.cancelDeviceLogin(cancelled.loginId)).status,
    "cancelled",
  );
  await assertRejectsKind(
    () => auth.completeDeviceLogin(cancelled.loginId, { bearerToken: SECRET_TOKEN }),
    "cancelled",
    130,
  );

  await assertRejectsKind(
    () => auth.pollDeviceLogin("missing-login"),
    "auth_missing_login",
  );

  const cancelledSignal = AbortSignal.abort();
  await assertRejectsKind(
    () => auth.pollDeviceLogin(cancelled.loginId, { signal: cancelledSignal }),
    "cancelled",
    130,
  );

  const timeoutSignal = AbortSignal.abort({ kind: "timeout" });
  await assertRejectsKind(
    () => auth.pollDeviceLogin(cancelled.loginId, { signal: timeoutSignal }),
    "timeout",
    124,
  );
});

test("fake device auth broker logout removes authorized bearer secrets", async () => {
  let now = 1_000;
  const auth = createFakeBrowserDeviceFlowAuthBroker({ now: () => now });
  const login = await auth.startDeviceLogin({ secretRef: SECRET_REF });
  now = 2_000;
  const completed = await auth.completeDeviceLogin(login.loginId, {
    bearerToken: SECRET_TOKEN,
  });
  assert.equal(await auth.getBearerToken(SECRET_REF), SECRET_TOKEN);

  now = 3_000;
  assert.deepEqual(await auth.logout(completed.sessionId), {
    account: {},
    completedAt: 2_000,
    loggedOutAt: 3_000,
    scopes: [],
    secretRef: SECRET_REF,
    sessionId: "device-session-1",
    status: "logged_out",
  });
  await assertRejectsKind(
    () => auth.getBearerToken(SECRET_REF),
    "auth_missing_token",
  );
  assert.equal((await auth.getSessionStatus(SECRET_REF)).status, "logged_out");
  assert.equal((await auth.pollDeviceLogin(login.loginId)).status, "logged_out");
});

test("fake device auth broker rejects invalid host tokens without leaking values", async () => {
  const auth = createFakeBrowserDeviceFlowAuthBroker();
  const login = await auth.startDeviceLogin({ secretRef: SECRET_REF });

  await assert.rejects(
    auth.completeDeviceLogin(login.loginId, { bearerToken: INVALID_TOKEN }),
    (error) => {
      assert.equal(error.kind, "auth_missing_token");
      assert.equal(error.message, "browser auth token is unavailable");
      assertNoLeak(error, [INVALID_TOKEN]);
      return true;
    },
  );
});

async function assertRejectsKind(action, kind, exitCode = 2) {
  await assert.rejects(action, (error) => {
    assert.equal(error.kind, kind);
    assert.equal(error.exitCode, exitCode);
    return true;
  });
}

function assertNoLeak(value, secrets) {
  const text = JSON.stringify(value);
  for (const secret of secrets) {
    assert(!text.includes(secret), "auth output leaked a sensitive value");
  }
}
