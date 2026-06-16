export class BrowserSecretProviderError extends Error {
  constructor(kind, message, stage = "startup", options = {}) {
    super(message);
    this.name = "BrowserSecretProviderError";
    this.kind = kind;
    this.stage = stage;
    this.exitCode = options.exitCode ?? 2;
    this.safe = options.safe === true;
  }
}

export class BrowserAuthBrokerError extends BrowserSecretProviderError {
  constructor(kind, message, options = {}) {
    super(kind, message, "startup", {
      exitCode: options.exitCode ?? authExitCode(kind),
      safe: true,
    });
    this.name = "BrowserAuthBrokerError";
  }
}

export class MemorySecretProvider {
  constructor(secrets = {}) {
    this.secrets = new Map();
    for (const [name, secret] of secretEntries(secrets)) {
      this.setSecret(name, secret);
    }
  }

  setSecret(name, secret) {
    this.secrets.set(normalizeSecretRef(name), normalizeSecretRecord(secret));
    return this;
  }

  hasSecret(name) {
    return this.secrets.has(normalizeSecretRef(name));
  }

  deleteSecret(name) {
    return this.secrets.delete(normalizeSecretRef(name));
  }

  async getBearerToken(name) {
    const record = this.secrets.get(normalizeSecretRef(name));
    if (!record || record.type !== "bearer") {
      throw secretError("browser bearer secret is unavailable");
    }
    return record.value;
  }
}

export function createMemorySecretProvider(secrets = {}) {
  return new MemorySecretProvider(secrets);
}

export class FakeBrowserDeviceFlowAuthBroker extends MemorySecretProvider {
  constructor(options = {}) {
    super(options.secrets ?? {});
    this.defaultExpiresInMs = positiveInteger(
      options.expiresInMs ?? 10 * 60 * 1000,
      "browser device login expiry is invalid",
    );
    this.defaultIntervalMs = positiveInteger(
      options.intervalMs ?? 5 * 1000,
      "browser device login interval is invalid",
    );
    this.defaultVerificationUri = nonEmptyText(
      options.verificationUri ?? "https://auth.example.test/device",
      "browser device verification URI is required",
    );
    this.loginSequence = 0;
    this.logins = new Map();
    this.now = options.now ?? (() => Date.now());
    this.sessionRefs = new Map();
    this.sessionSequence = 0;
    this.sessions = new Map();
  }

  async startDeviceLogin(options = {}) {
    const createdAt = this.currentTime();
    const loginNumber = this.loginSequence + 1;
    const loginId = nonEmptyText(
      options.loginId ?? `device-login-${loginNumber}`,
      "browser device login id is required",
    );
    if (this.logins.has(loginId)) {
      throw authError("auth_failure", "browser device login already exists");
    }
    this.loginSequence = loginNumber;

    const secretRef = normalizeSecretRef(
      options.secretRef ?? `codex-model-${loginId}`,
    );
    const userCode = nonEmptyText(
      options.userCode ?? `CODEX-${String(this.loginSequence).padStart(4, "0")}`,
      "browser device user code is required",
    );
    const expiresAt = nonNegativeInteger(
      options.expiresAt ?? createdAt + this.defaultExpiresInMs,
      "browser device login expiry is invalid",
    );
    if (expiresAt <= createdAt) {
      throw authError("auth_expired", "browser device login expired");
    }

    const login = {
      account: null,
      accountHint: normalizeOptionalAccount(options.accountHint),
      completedAt: null,
      createdAt,
      expiresAt,
      intervalMs: positiveInteger(
        options.intervalMs ?? this.defaultIntervalMs,
        "browser device login interval is invalid",
      ),
      loginId,
      scopes: normalizeScopes(options.scopes),
      secretRef,
      sessionId: null,
      status: "pending",
      userCode,
      verificationUri: nonEmptyText(
        options.verificationUri ?? this.defaultVerificationUri,
        "browser device verification URI is required",
      ),
      verificationUriComplete:
        options.verificationUriComplete == null
          ? null
          : nonEmptyText(
              options.verificationUriComplete,
              "browser device verification URI is required",
            ),
    };
    this.logins.set(loginId, login);
    return publicDeviceLogin(login);
  }

  async pollDeviceLogin(loginId, options = {}) {
    checkAuthSignal(options.signal);
    const login = this.requireLogin(loginId);
    updateExpiredLogin(login, this.currentTime());
    return publicDeviceLogin(login);
  }

  async getDeviceLoginStatus(loginId) {
    return this.pollDeviceLogin(loginId);
  }

  async completeDeviceLogin(loginId, options = {}) {
    const login = this.requirePendingLogin(loginId);
    const token = normalizeAuthBearerToken(
      options.bearerToken ?? options.token ?? options.value,
    );
    const completedAt = this.currentTime();
    const sessionNumber = this.sessionSequence + 1;
    const sessionId = nonEmptyText(
      options.sessionId ?? `device-session-${sessionNumber}`,
      "browser auth session id is required",
    );
    if (this.sessions.has(sessionId)) {
      throw authError("auth_failure", "browser auth session already exists");
    }
    this.sessionSequence = sessionNumber;

    const account = normalizeAccount(options.account);
    this.setSecret(login.secretRef, { type: "bearer", value: token });

    const session = {
      account,
      completedAt,
      loggedOutAt: null,
      scopes: [...login.scopes],
      secretRef: login.secretRef,
      sessionId,
      status: "authorized",
    };
    this.sessions.set(sessionId, session);
    this.sessionRefs.set(login.secretRef, sessionId);

    login.account = account;
    login.completedAt = completedAt;
    login.sessionId = sessionId;
    login.status = "authorized";
    return publicDeviceLogin(login);
  }

  async denyDeviceLogin(loginId) {
    const login = this.requirePendingLogin(loginId);
    login.status = "denied";
    return publicDeviceLogin(login);
  }

  async cancelDeviceLogin(loginId) {
    const login = this.requireLogin(loginId);
    if (login.status === "authorized") {
      await this.logout(login.sessionId ?? login.secretRef);
      return publicDeviceLogin(login);
    }
    if (login.status === "pending") {
      login.status = "cancelled";
    }
    return publicDeviceLogin(login);
  }

  async logout(sessionIdOrSecretRef) {
    const session = this.requireSession(sessionIdOrSecretRef);
    this.deleteSecret(session.secretRef);
    session.loggedOutAt = this.currentTime();
    session.status = "logged_out";

    for (const login of this.logins.values()) {
      if (login.sessionId === session.sessionId) {
        login.status = "logged_out";
      }
    }
    return publicSession(session);
  }

  async getSessionStatus(sessionIdOrSecretRef) {
    return publicSession(this.requireSession(sessionIdOrSecretRef));
  }

  async getBearerToken(secretRef, context = {}) {
    const normalizedRef = normalizeSecretRef(secretRef);
    const session = this.sessionBySecretRef(normalizedRef);
    if (
      !session ||
      session.status !== "authorized" ||
      !this.hasSecret(normalizedRef)
    ) {
      throw authError("auth_missing_token", "browser bearer secret is unavailable");
    }
    return super.getBearerToken(normalizedRef, context);
  }

  currentTime() {
    return nonNegativeInteger(this.now(), "browser auth clock is invalid");
  }

  requireLogin(loginId) {
    const login = this.logins.get(
      nonEmptyText(loginId, "browser device login id is required"),
    );
    if (!login) {
      throw authError("auth_missing_login", "browser device login is unavailable");
    }
    return login;
  }

  requirePendingLogin(loginId) {
    const login = this.requireLogin(loginId);
    updateExpiredLogin(login, this.currentTime());
    switch (login.status) {
      case "pending":
        return login;
      case "denied":
        throw authError("auth_denied", "browser device login was denied");
      case "expired":
        throw authError("auth_expired", "browser device login expired");
      case "cancelled":
        throw authError("cancelled", "browser device login was cancelled");
      case "authorized":
        throw authError(
          "auth_failure",
          "browser device login is already authorized",
        );
      case "logged_out":
        throw authError("auth_failure", "browser device login is logged out");
      default:
        throw authError("auth_failure", "browser device login is unavailable");
    }
  }

  requireSession(sessionIdOrSecretRef) {
    const key = nonEmptyText(
      sessionIdOrSecretRef,
      "browser auth session id is required",
    );
    const session = this.sessions.get(key) ?? this.sessionBySecretRef(key);
    if (!session) {
      throw authError("auth_missing_token", "browser auth session is unavailable");
    }
    return session;
  }

  sessionBySecretRef(secretRef) {
    const sessionId = this.sessionRefs.get(normalizeSecretRef(secretRef));
    return sessionId ? this.sessions.get(sessionId) : null;
  }
}

export function createFakeBrowserDeviceFlowAuthBroker(options = {}) {
  return new FakeBrowserDeviceFlowAuthBroker(options);
}

export async function resolveBrowserBearerSecret(provider, ref, context = {}) {
  if (ref == null || ref === "") {
    return null;
  }
  const normalizedRef = normalizeSecretRef(ref);
  if (!provider) {
    throw secretError("browser secret provider is unavailable");
  }

  try {
    if (typeof provider.getBearerToken === "function") {
      return normalizeBearerSecretValue(
        await provider.getBearerToken(normalizedRef, context),
      );
    }
    if (typeof provider.getSecret === "function") {
      return normalizeBearerSecretValue(
        await provider.getSecret(normalizedRef, context),
      );
    }
  } catch (error) {
    if (error instanceof BrowserSecretProviderError && error.safe) {
      throw error;
    }
    throw secretError("browser secret provider failed");
  }

  throw secretError("browser secret provider does not support bearer lookup");
}

function secretEntries(secrets) {
  if (secrets == null) {
    return [];
  }
  if (secrets instanceof Map) {
    return secrets.entries();
  }
  if (Array.isArray(secrets)) {
    return secrets;
  }
  return Object.entries(secrets);
}

function publicDeviceLogin(login) {
  return {
    account: cloneAccount(login.account),
    accountHint: cloneAccount(login.accountHint),
    completedAt: login.completedAt,
    createdAt: login.createdAt,
    expiresAt: login.expiresAt,
    intervalMs: login.intervalMs,
    loginId: login.loginId,
    scopes: [...login.scopes],
    secretRef: login.secretRef,
    sessionId: login.sessionId,
    status: login.status,
    userCode: login.userCode,
    verificationUri: login.verificationUri,
    verificationUriComplete: login.verificationUriComplete,
  };
}

function publicSession(session) {
  return {
    account: cloneAccount(session.account),
    completedAt: session.completedAt,
    loggedOutAt: session.loggedOutAt,
    scopes: [...session.scopes],
    secretRef: session.secretRef,
    sessionId: session.sessionId,
    status: session.status,
  };
}

function cloneAccount(account) {
  return account ? { ...account } : null;
}

function updateExpiredLogin(login, now) {
  if (login.status === "pending" && now >= login.expiresAt) {
    login.status = "expired";
  }
}

function normalizeScopes(scopes = []) {
  if (!Array.isArray(scopes)) {
    throw authError("auth_failure", "browser device login scopes are invalid");
  }
  return scopes.map((scope) =>
    nonEmptyText(scope, "browser device login scopes are invalid"),
  );
}

function normalizeOptionalAccount(account) {
  if (account == null) {
    return null;
  }
  return normalizeAccount(account);
}

function normalizeAccount(account = {}) {
  const result = {};
  for (const [key, value] of Object.entries(account ?? {})) {
    const name = String(key).trim();
    if (!name || isSensitiveAccountField(name)) {
      continue;
    }
    if (value == null) {
      result[name] = null;
      continue;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      result[name] = value;
    }
  }
  return result;
}

function isSensitiveAccountField(name) {
  return /authorization|cookie|refresh|secret|token/i.test(name);
}

function nonEmptyText(value, message) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw authError("auth_failure", message);
  }
  return text;
}

function nonNegativeInteger(value, message) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw authError("auth_failure", message);
  }
  return number;
}

function positiveInteger(value, message) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw authError("auth_failure", message);
  }
  return number;
}

function normalizeSecretRecord(secret) {
  if (typeof secret === "string") {
    return { type: "bearer", value: normalizeBearerSecretValue(secret) };
  }
  const type = String(secret?.type ?? "bearer").trim();
  return {
    type,
    value: normalizeBearerSecretValue(secret?.token ?? secret?.value),
  };
}

function normalizeSecretRef(ref) {
  const text = String(ref ?? "").trim();
  if (!text) {
    throw secretError("browser secret reference is required");
  }
  return text;
}

function normalizeBearerSecretValue(value) {
  if (value && typeof value === "object") {
    return normalizeBearerSecretValue(value.token ?? value.value);
  }
  const text = String(value ?? "");
  if (!text || /[\r\n]/.test(text)) {
    throw secretError("browser bearer secret is unavailable");
  }
  return text;
}

function normalizeAuthBearerToken(value) {
  if (value && typeof value === "object") {
    return normalizeAuthBearerToken(value.token ?? value.value);
  }
  const text = String(value ?? "");
  if (!text || /[\r\n]/.test(text)) {
    throw authError("auth_missing_token", "browser auth token is unavailable");
  }
  return text;
}

function checkAuthSignal(signal) {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  if (reason?.kind === "timeout" || reason?.timedOut === true) {
    throw authError("timeout", "browser device login timed out");
  }
  throw authError("cancelled", "browser device login was cancelled");
}

function secretError(message) {
  return new BrowserSecretProviderError("auth_failure", message, "startup", {
    exitCode: 2,
    safe: true,
  });
}

function authError(kind, message) {
  return new BrowserAuthBrokerError(kind, message);
}

function authExitCode(kind) {
  switch (kind) {
    case "cancelled":
      return 130;
    case "timeout":
      return 124;
    default:
      return 2;
  }
}
