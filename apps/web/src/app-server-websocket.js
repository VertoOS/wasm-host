import {
  BrowserCodexAppServerLoopbackSocket,
  BrowserCodexAppServerTransportError,
} from "./app-server-transport.js";

export const DEFAULT_BROWSER_CODEX_APP_SERVER_LOOPBACK_URL =
  "browser-codex-app-server://loopback";
export const DEFAULT_BROWSER_CODEX_APP_SERVER_WEBSOCKET_URL =
  DEFAULT_BROWSER_CODEX_APP_SERVER_LOOPBACK_URL;
export const BROWSER_CODEX_APP_SERVER_WEBSOCKET_PROTOCOL = "jsonrpc";

const LOOPBACK_WS_HOST = "browser-codex-app-server";

export class BrowserCodexAppServerWebSocket extends BrowserCodexAppServerLoopbackSocket {
  constructor(
    url = DEFAULT_BROWSER_CODEX_APP_SERVER_WEBSOCKET_URL,
    protocols,
  ) {
    const selectedUrl = validateBrowserCodexAppServerWebSocketUrl(url);
    const selectedProtocol =
      validateBrowserCodexAppServerWebSocketProtocols(protocols);
    super({ url: selectedUrl });
    this.protocol = selectedProtocol;
  }
}

export function createBrowserCodexAppServerWebSocketConstructor(options = {}) {
  const {
    defaultUrl = DEFAULT_BROWSER_CODEX_APP_SERVER_WEBSOCKET_URL,
    runtimeFactory = null,
    ...socketOptions
  } = options;

  return class BrowserCodexAppServerWebSocketConstructor extends BrowserCodexAppServerLoopbackSocket {
    constructor(url = defaultUrl, protocols) {
      const selectedUrl = validateBrowserCodexAppServerWebSocketUrl(url);
      const selectedProtocol =
        validateBrowserCodexAppServerWebSocketProtocols(protocols);
      const runtime =
        typeof runtimeFactory === "function"
          ? runtimeFactory({ protocols, url: selectedUrl })
          : socketOptions.runtime;
      const runtimeOptions =
        runtime === undefined ? socketOptions.runtimeOptions : undefined;

      super({
        ...socketOptions,
        runtime,
        runtimeOptions,
        url: selectedUrl,
      });
      this.protocol = selectedProtocol;
    }
  };
}

export function createBrowserCodexAppServerWebSocketFactory(options = {}) {
  const WebSocketConstructor =
    createBrowserCodexAppServerWebSocketConstructor(options);
  return (url, protocols) => new WebSocketConstructor(url, protocols);
}

export function createBrowserCodexAppServerWebSocket(
  url = DEFAULT_BROWSER_CODEX_APP_SERVER_WEBSOCKET_URL,
  protocols,
) {
  return new BrowserCodexAppServerWebSocket(url, protocols);
}

function validateBrowserCodexAppServerWebSocketUrl(url) {
  let rawUrl;
  let parsed;
  try {
    rawUrl =
      url === undefined
        ? DEFAULT_BROWSER_CODEX_APP_SERVER_WEBSOCKET_URL
        : String(url);
    parsed = new URL(rawUrl);
  } catch (cause) {
    throw new BrowserCodexAppServerTransportError(
      `unsupported browser app-server WebSocket URL: ${rawUrl}`,
      { cause, code: "unsupported_url" },
    );
  }

  if (
    parsed.protocol === "browser-codex-app-server:" &&
    parsed.hostname === "loopback" &&
    emptyUrlSuffix(parsed)
  ) {
    return DEFAULT_BROWSER_CODEX_APP_SERVER_WEBSOCKET_URL;
  }

  if (
    (parsed.protocol === "ws:" || parsed.protocol === "wss:") &&
    parsed.hostname === LOOPBACK_WS_HOST &&
    supportedWebSocketPath(parsed.pathname) &&
    parsed.search === "" &&
    parsed.hash === ""
  ) {
    return parsed.href;
  }

  throw new BrowserCodexAppServerTransportError(
    `unsupported browser app-server WebSocket URL: ${rawUrl}`,
    { code: "unsupported_url" },
  );
}

function validateBrowserCodexAppServerWebSocketProtocols(protocols) {
  if (protocols === undefined) {
    return BROWSER_CODEX_APP_SERVER_WEBSOCKET_PROTOCOL;
  }

  const requestedProtocols = Array.isArray(protocols) ? protocols : [protocols];
  if (requestedProtocols.length === 0) {
    return BROWSER_CODEX_APP_SERVER_WEBSOCKET_PROTOCOL;
  }

  for (const protocol of requestedProtocols) {
    if (protocol === BROWSER_CODEX_APP_SERVER_WEBSOCKET_PROTOCOL) {
      return BROWSER_CODEX_APP_SERVER_WEBSOCKET_PROTOCOL;
    }
  }

  throw new BrowserCodexAppServerTransportError(
    `unsupported browser app-server WebSocket protocol: ${formatProtocols(
      requestedProtocols,
    )}`,
    { code: "unsupported_protocol" },
  );
}

function supportedWebSocketPath(pathname) {
  return pathname === "" || pathname === "/" || pathname === "/loopback";
}

function emptyUrlSuffix(url) {
  return url.pathname === "" && url.search === "" && url.hash === "";
}

function formatProtocols(protocols) {
  return protocols
    .map((protocol) => {
      try {
        return String(protocol);
      } catch {
        return "<unprintable>";
      }
    })
    .join(", ");
}
