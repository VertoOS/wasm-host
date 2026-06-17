import { createBrowserCodexAppServerJsonRpcClient } from "./app-server-transport.js";

const DEFAULT_CLIENT_INFO = Object.freeze({
  name: "wasm-host-browser-session",
  version: "0.0.0",
});

export class BrowserCodexAppServerSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BrowserCodexAppServerSessionError";
    this.code = code;
  }
}

export class BrowserCodexAppServerSession {
  constructor(options = {}) {
    this.client =
      options.client ?? createBrowserCodexAppServerJsonRpcClient(options);
    this.account = null;
    this.accountStatus = null;
    this.activeLoginId = null;
    this.activeTurnId = null;
    this.closed = false;
    this.connected = false;
    this.completedTurnIds = new Set();
    this.initializeResult = null;
    this.notifications = [];
    this.thread = null;
    this.threadId = null;
    this.transcript = [];

    this.client.addEventListener("notification", (event) => {
      this.recordNotification(event.message);
    });
    this.client.addEventListener("error", (event) => {
      this.transcript.push({
        error: event.error,
        type: "error",
      });
    });
    this.client.addEventListener("close", (event) => {
      this.closed = true;
      this.connected = false;
      this.transcript.push({
        code: event.code,
        reason: event.reason,
        type: "close",
        wasClean: event.wasClean,
      });
    });
  }

  async connect(options = {}) {
    this.assertOpen();
    if (this.connected) {
      return this.initializeResult;
    }
    await this.client.ready;
    const capabilities = { ...(options.capabilities ?? {}) };
    if (options.optOutNotificationMethods !== undefined) {
      capabilities.optOutNotificationMethods = options.optOutNotificationMethods;
    }
    this.initializeResult = await this.client.request("initialize", {
      capabilities,
      clientInfo: options.clientInfo ?? DEFAULT_CLIENT_INFO,
    });
    this.client.notify("initialized");
    await this.client.drain?.();
    this.connected = true;
    return this.initializeResult;
  }

  async initialize(options = {}) {
    return this.connect(options);
  }

  async readAccount() {
    this.assertConnected();
    const result = await this.client.request("account/read");
    this.account = result.account ?? null;
    this.accountStatus = result;
    return result;
  }

  async startDeviceLogin(options = {}) {
    this.assertConnected();
    const login = await this.client.request("account/login/start", {
      type: options.type ?? "chatgptDeviceCode",
    });
    this.activeLoginId = login.loginId;
    return login;
  }

  async cancelDeviceLogin(loginId = this.activeLoginId) {
    this.assertConnected();
    if (!loginId) {
      throw new BrowserCodexAppServerSessionError(
        "missing_login",
        "browser app-server session has no active login",
      );
    }
    const result = await this.client.request("account/login/cancel", {
      loginId,
    });
    if (result.status === "canceled") {
      this.activeLoginId = null;
    }
    const completion = this.findNotification(
      "account/login/completed",
      (notification) => notification.params?.loginId === loginId,
    );
    return {
      completion,
      result,
    };
  }

  async ensureThread(options = {}) {
    this.assertConnected();
    if (this.threadId) {
      return {
        reused: true,
        threadId: this.threadId,
      };
    }
    const result = await this.client.request("thread/start", {
      model: options.model,
    });
    this.thread = result.thread;
    this.threadId = result.thread.id;
    return {
      reused: false,
      thread: result.thread,
      threadId: this.threadId,
    };
  }

  async startPromptTurn(text, options = {}) {
    this.assertConnected();
    const thread = await this.ensureThread({ model: options.model });
    const turnStarted = this.waitForThreadNotification(
      "turn/started",
      thread.threadId,
    );
    const itemCompleted = this.waitForThreadNotification(
      "item/completed",
      thread.threadId,
    );
    const turnCompleted = this.waitForThreadNotification(
      "turn/completed",
      thread.threadId,
    );
    const result = await this.client.request("turn/start", {
      clientUserMessageId: options.clientUserMessageId ?? null,
      input: promptInput(text, options),
      threadId: thread.threadId,
    });
    const notifications = await Promise.all([
      turnStarted,
      itemCompleted,
      turnCompleted,
    ]);
    return {
      item: notifications[1].params.item,
      notifications,
      threadId: thread.threadId,
      turn: result.turn,
    };
  }

  async startPendingTurn(text, options = {}) {
    this.assertConnected();
    const thread = await this.ensureThread({ model: options.model });
    const started = this.waitForThreadNotification(
      "turn/started",
      thread.threadId,
    );
    const result = await this.client.request("turn/start", {
      clientUserMessageId: options.clientUserMessageId ?? null,
      input: promptInput(text, options),
      threadId: thread.threadId,
    });
    if (!this.completedTurnIds.has(result.turn.id)) {
      this.activeTurnId = result.turn.id;
    }
    return {
      notification: await started,
      threadId: thread.threadId,
      turn: result.turn,
    };
  }

  async interruptTurn(turnId = this.activeTurnId) {
    this.assertConnected();
    if (!this.threadId || !turnId) {
      throw new BrowserCodexAppServerSessionError(
        "missing_turn",
        "browser app-server session has no active turn",
      );
    }
    const completed = this.client.waitForNotification("turn/completed", {
      replay: false,
      predicate: (notification) => notification.params?.turn?.id === turnId,
    });
    const result = await this.client.request("turn/interrupt", {
      threadId: this.threadId,
      turnId,
    });
    const notification = await completed;
    if (this.activeTurnId === turnId) {
      this.activeTurnId = null;
    }
    return {
      notification,
      result,
    };
  }

  async request(method, params) {
    this.assertConnected();
    return this.client.request(method, params);
  }

  close(code, reason) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.connected = false;
    this.activeLoginId = null;
    this.activeTurnId = null;
    this.client.close(code, reason);
  }

  recordNotification(notification) {
    this.notifications.push(notification);
    this.applyNotificationState(notification);
    this.transcript.push({
      method: notification.method,
      notification,
      params: notification.params,
      type: "notification",
    });
  }

  applyNotificationState(notification) {
    const params = notification.params ?? {};
    switch (notification.method) {
      case "account/login/completed":
        if (params.loginId === this.activeLoginId) {
          this.activeLoginId = null;
        }
        break;
      case "thread/started":
        if (params.thread?.id) {
          this.thread = params.thread;
          this.threadId = params.thread.id;
        }
        break;
      case "turn/started":
        if (params.turn?.id) {
          this.activeTurnId = params.turn.id;
          this.completedTurnIds.delete(params.turn.id);
        }
        break;
      case "turn/completed":
        if (params.turn?.id) {
          this.completedTurnIds.add(params.turn.id);
          if (this.activeTurnId === params.turn.id) {
            this.activeTurnId = null;
          }
        }
        break;
    }
  }

  findNotification(method, predicate = () => true) {
    for (let index = this.notifications.length - 1; index >= 0; index -= 1) {
      const notification = this.notifications[index];
      if (notification.method === method && predicate(notification)) {
        return notification;
      }
    }
    return null;
  }

  waitForThreadNotification(method, threadId) {
    return this.client.waitForNotification(method, {
      replay: false,
      predicate: (notification) => notification.params?.threadId === threadId,
    });
  }

  assertOpen() {
    if (this.closed) {
      throw new BrowserCodexAppServerSessionError(
        "closed",
        "browser app-server session is closed",
      );
    }
  }

  assertConnected() {
    this.assertOpen();
    if (!this.connected) {
      throw new BrowserCodexAppServerSessionError(
        "not_connected",
        "browser app-server session is not connected",
      );
    }
  }
}

export function createBrowserCodexAppServerSession(options = {}) {
  return new BrowserCodexAppServerSession(options);
}

function promptInput(text, options = {}) {
  if (Array.isArray(options.input)) {
    return options.input;
  }
  if (Array.isArray(text)) {
    return text;
  }
  return [
    {
      text: String(text ?? ""),
      textElements: options.textElements ?? [],
      type: "text",
    },
  ];
}
