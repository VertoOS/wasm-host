const JSONRPC_VERSION = "2.0";
const DEFAULT_MAX_NOTIFICATIONS_PER_TURN = 16;
const DEFAULT_MODEL_RESPONSE_TEXT = "mock browser app-server response";
const AUTO_COMPLETE_TURN_NOTIFICATION_COUNT = 3;

const SUPPORTED_METHODS = Object.freeze([
  "initialize",
  "account/read",
  "account/login/start",
  "account/login/cancel",
  "thread/start",
  "turn/start",
  "turn/interrupt",
]);

export class BrowserCodexAppServerError extends Error {
  constructor(code, kind, message, data = {}) {
    super(message);
    this.name = "BrowserCodexAppServerError";
    this.code = code;
    this.kind = kind;
    this.stage = data.stage ?? "app_server";
    this.data = {
      ...data,
      browserHosted: true,
      kind,
      stage: this.stage,
    };
  }
}

export class BrowserCodexAppServerRuntime {
  constructor(options = {}) {
    this.account = options.account ?? null;
    this.autoCompleteTurns = options.autoCompleteTurns !== false;
    this.clientInfo = null;
    this.initialized = false;
    this.loginSequence = 0;
    this.logins = new Map();
    this.maxNotificationsPerTurn = positiveInteger(
      options.maxNotificationsPerTurn ?? DEFAULT_MAX_NOTIFICATIONS_PER_TURN,
      "maxNotificationsPerTurn must be a positive integer",
    );
    this.modelResponseText =
      options.modelResponseText ?? DEFAULT_MODEL_RESPONSE_TEXT;
    this.now = options.now ?? (() => Date.now());
    this.notificationOptOut = new Set();
    this.threadSequence = 0;
    this.threads = new Map();
    this.turnSequence = 0;
    this.turns = new Map();
    this.verificationUrl =
      options.verificationUrl ?? "https://auth.example.test/device";
  }

  async handleMessage(rawMessage) {
    const parsed = parseJsonRpcMessage(rawMessage);
    if (parsed.error) {
      return [jsonRpcError(null, parsed.error)];
    }

    const message = parsed.message;
    const id = Object.hasOwn(message, "id") ? message.id : undefined;
    try {
      validateJsonRpcEnvelope(message);
      if (id === undefined) {
        return this.handleNotification(message.method, message.params);
      }

      const { notifications = [], result } = await this.handleRequest(
        message.method,
        message.params,
      );
      return [
        jsonRpcResult(id, result),
        ...this.filterNotifications(notifications),
      ];
    } catch (error) {
      const normalized = normalizeAppServerError(error);
      if (id === undefined) {
        return [
          jsonRpcNotification("error", {
            error: publicError(normalized),
          }),
        ];
      }
      return [jsonRpcError(id, normalized)];
    }
  }

  handleNotification(method) {
    if (method === "initialized") {
      this.initialized = true;
      return [];
    }
    throw unsupportedMethod(method);
  }

  async handleRequest(method, params) {
    switch (method) {
      case "initialize":
        return { result: this.initialize(params) };
      case "account/read":
        return { result: this.readAccount() };
      case "account/login/start":
        return { result: this.startLogin(params) };
      case "account/login/cancel":
        return this.cancelLogin(params);
      case "thread/start":
        return this.startThread(params);
      case "turn/start":
        return this.startTurn(params);
      case "turn/interrupt":
        return this.interruptTurn(params);
      default:
        throw unsupportedMethod(method);
    }
  }

  initialize(params = {}) {
    const value = objectParam(params, "initialize params must be an object");
    this.clientInfo = value.clientInfo ?? null;
    const optOut =
      value.optOutNotificationMethods ??
      value.capabilities?.optOutNotificationMethods ??
      [];
    this.notificationOptOut = new Set(
      Array.isArray(optOut)
        ? optOut.filter((method) => typeof method === "string")
        : [],
    );
    return {
      browserFixture: {
        browserHosted: true,
        deterministicFixture: true,
        maxNotificationsPerTurn: this.maxNotificationsPerTurn,
        methods: SUPPORTED_METHODS,
        mockedModelTurns: true,
      },
      codexHome: "/browser/.codex",
      platformFamily: "browser",
      platformOs: "web",
      userAgent: "wasm-host-browser-app-server/0.0.0",
    };
  }

  readAccount() {
    return {
      account: this.account,
      requiresOpenaiAuth: this.account == null,
    };
  }

  startLogin(params = {}) {
    const value = objectParam(
      params,
      "account/login/start params must be an object",
    );
    if (value.type !== "chatgptDeviceCode") {
      throw invalidParams(
        "account/login/start only supports chatgptDeviceCode in the browser fixture",
      );
    }

    this.loginSequence += 1;
    const loginId = `browser-login-${this.loginSequence}`;
    const login = {
      loginId,
      status: "pending",
      type: "chatgptDeviceCode",
      userCode: `BROWSER-${String(this.loginSequence).padStart(4, "0")}`,
      verificationUrl: this.verificationUrl,
    };
    this.logins.set(loginId, login);
    return {
      loginId,
      type: login.type,
      userCode: login.userCode,
      verificationUrl: login.verificationUrl,
    };
  }

  cancelLogin(params = {}) {
    const value = objectParam(
      params,
      "account/login/cancel params must be an object",
    );
    const loginId = nonEmptyString(value.loginId, "loginId is required");
    const login = this.logins.get(loginId);
    if (!login) {
      return { result: { status: "notFound" } };
    }
    login.status = "canceled";
    return {
      notifications: [
        jsonRpcNotification("account/login/completed", {
          error: "Device login canceled.",
          loginId,
          success: false,
        }),
      ],
      result: { status: "canceled" },
    };
  }

  startThread(params = {}) {
    objectParam(params, "thread/start params must be an object");
    this.threadSequence += 1;
    const nowSeconds = this.currentTimeMs() / 1000;
    const thread = {
      agentNickname: null,
      agentRole: null,
      cliVersion: "0.0.0",
      createdAt: nowSeconds,
      cwd: "/workspace",
      ephemeral: false,
      forkedFromId: null,
      gitInfo: null,
      id: `browser-thread-${this.threadSequence}`,
      modelProvider: "openai",
      name: null,
      parentThreadId: null,
      path: null,
      preview: "",
      sessionId: `browser-session-${this.threadSequence}`,
      source: "appServer",
      status: { type: "idle" },
      threadSource: "browser-fixture",
      turns: [],
      updatedAt: nowSeconds,
    };
    this.threads.set(thread.id, thread);
    return {
      notifications: [
        jsonRpcNotification("thread/started", {
          thread,
        }),
      ],
      result: { thread },
    };
  }

  startTurn(params = {}) {
    const value = objectParam(params, "turn/start params must be an object");
    const threadId = nonEmptyString(value.threadId, "threadId is required");
    if (!this.threads.has(threadId)) {
      throw invalidParams(`unknown threadId: ${threadId}`);
    }
    if (!Array.isArray(value.input)) {
      throw invalidParams("turn/start input must be an array");
    }

    this.turnSequence += 1;
    const startedAtMs = this.currentTimeMs();
    const turn = {
      id: `browser-turn-${this.turnSequence}`,
      completedAt: null,
      durationMs: null,
      error: null,
      items: [],
      itemsView: "full",
      startedAt: startedAtMs / 1000,
      startedAtMs,
      status: "inProgress",
      threadId,
    };
    this.turns.set(turn.id, turn);
    const startedTurn = publicTurn(turn);

    const started = jsonRpcNotification("turn/started", {
      threadId,
      turn: startedTurn,
    });
    if (!this.autoCompleteTurns) {
      return {
        notifications: [started],
        result: { turn: startedTurn },
      };
    }

    const completionNotifications = this.completedTurnNotifications(turn, value);
    return {
      notifications: [started, ...completionNotifications],
      result: { turn: startedTurn },
    };
  }

  interruptTurn(params = {}) {
    const value = objectParam(params, "turn/interrupt params must be an object");
    const threadId = nonEmptyString(value.threadId, "threadId is required");
    const turnId = nonEmptyString(value.turnId, "turnId is required");
    const turn = this.turns.get(turnId);
    if (!turn || turn.threadId !== threadId) {
      throw invalidParams(`unknown turnId: ${turnId}`);
    }
    if (turn.status !== "inProgress") {
      throw invalidParams(`turn is not running: ${turnId}`);
    }

    turn.status = "interrupted";
    turn.completedAt = this.currentTimeMs() / 1000;
    turn.durationMs = Math.max(
      0,
      Math.round(turn.completedAt * 1000) - turn.startedAtMs,
    );
    return {
      notifications: [
        jsonRpcNotification("turn/completed", {
          threadId,
          turn: publicTurn(turn),
        }),
      ],
      result: {},
    };
  }

  completedTurnNotifications(turn, params) {
    const threadId = turn.threadId;
    const responseText = modelResponseText(this.modelResponseText, {
      inputText: inputText(params.input),
      thread: this.threads.get(threadId),
      turn,
    });
    const item = {
      id: `browser-item-${turn.id.slice("browser-turn-".length)}`,
      memoryCitation: null,
      phase: null,
      text: responseText,
      type: "agentMessage",
    };
    const completedAtMs = this.currentTimeMs();
    if (AUTO_COMPLETE_TURN_NOTIFICATION_COUNT > this.maxNotificationsPerTurn) {
      throw new BrowserCodexAppServerError(
        -32001,
        "resource_limit",
        "browser app-server turn notification limit exceeded",
        {
          limit: this.maxNotificationsPerTurn,
          method: "turn/start",
        },
      );
    }

    turn.completedAt = completedAtMs / 1000;
    turn.durationMs = Math.max(0, completedAtMs - turn.startedAtMs);
    turn.items = [item];
    turn.status = "completed";
    const notifications = [
      jsonRpcNotification("item/completed", {
        completedAtMs,
        item,
        threadId,
        turnId: turn.id,
      }),
      jsonRpcNotification("turn/completed", {
        threadId,
        turn: { ...publicTurn(turn), status: "completed" },
      }),
    ];
    return notifications;
  }

  currentTimeMs() {
    return this.now();
  }

  filterNotifications(notifications) {
    return notifications.filter(
      (notification) => !this.notificationOptOut.has(notification.method),
    );
  }
}

export function createBrowserCodexAppServerRuntime(options = {}) {
  return new BrowserCodexAppServerRuntime(options);
}

function parseJsonRpcMessage(rawMessage) {
  let message = rawMessage;
  if (typeof rawMessage === "string") {
    try {
      message = JSON.parse(rawMessage);
    } catch {
      return {
        error: new BrowserCodexAppServerError(
          -32700,
          "parse_error",
          "invalid JSON-RPC message",
        ),
      };
    }
  }

  if (!isPlainObject(message) || Array.isArray(message)) {
    return {
      error: new BrowserCodexAppServerError(
        -32600,
        "invalid_request",
        "JSON-RPC message must be an object",
      ),
    };
  }
  return { message };
}

function validateJsonRpcEnvelope(message) {
  if (message.jsonrpc !== JSONRPC_VERSION) {
    throw new BrowserCodexAppServerError(
      -32600,
      "invalid_request",
      "JSON-RPC version must be 2.0",
    );
  }
  if (typeof message.method !== "string" || message.method.length === 0) {
    throw new BrowserCodexAppServerError(
      -32600,
      "invalid_request",
      "JSON-RPC method is required",
    );
  }
  if (Object.hasOwn(message, "id") && !validJsonRpcId(message.id)) {
    throw new BrowserCodexAppServerError(
      -32600,
      "invalid_request",
      "JSON-RPC id must be a string, number, or null",
    );
  }
}

function jsonRpcResult(id, result) {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    result,
  };
}

function jsonRpcError(id, error) {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: publicError(error),
  };
}

function jsonRpcNotification(method, params = {}) {
  return {
    jsonrpc: JSONRPC_VERSION,
    method,
    params,
  };
}

function publicError(error) {
  const normalized = normalizeAppServerError(error);
  return {
    code: normalized.code,
    data: normalized.data,
    message: normalized.message,
  };
}

function normalizeAppServerError(error) {
  if (error instanceof BrowserCodexAppServerError) {
    return error;
  }
  return new BrowserCodexAppServerError(
    -32603,
    "internal_error",
    error?.message ?? "browser app-server internal error",
  );
}

function unsupportedMethod(method) {
  return new BrowserCodexAppServerError(
    -32601,
    "unsupported_capability",
    `unsupported browser app-server method: ${method}`,
    {
      method,
      supportedMethods: SUPPORTED_METHODS,
    },
  );
}

function invalidParams(message) {
  return new BrowserCodexAppServerError(-32602, "invalid_request", message);
}

function objectParam(value, message) {
  if (!isPlainObject(value) || Array.isArray(value)) {
    throw invalidParams(message);
  }
  return value;
}

function nonEmptyString(value, message) {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidParams(message);
  }
  return value;
}

function positiveInteger(value, message) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new BrowserCodexAppServerError(-32602, "invalid_request", message);
  }
  return value;
}

function validJsonRpcId(value) {
  return (
    value == null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null;
}

function publicTurn(turn) {
  return {
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    error: turn.error,
    id: turn.id,
    items: turn.items,
    itemsView: turn.itemsView,
    startedAt: turn.startedAt,
    status: turn.status,
  };
}

function inputText(input) {
  return input
    .flatMap((item) => {
      if (!isPlainObject(item)) {
        return [];
      }
      if (item.type === "text" && typeof item.text === "string") {
        return [item.text];
      }
      return [];
    })
    .join("\n\n");
}

function modelResponseText(value, context) {
  if (typeof value === "function") {
    return String(value(context));
  }
  return String(value);
}
