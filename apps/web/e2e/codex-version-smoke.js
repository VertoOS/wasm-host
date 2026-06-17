import {
  CODEX_BROWSER_WORKSPACE_EDIT_BEFORE,
  CODEX_BROWSER_WORKSPACE_EDIT_PATH,
  assertCodexBrowserRequestPayload,
  codexBrowserModelRequestFixture,
  codexBrowserRequestBuilderFixture,
  codexBrowserWorkspaceEditFixture,
} from "../fixtures/codex-browser-request-builder-core.js";
import {
  CODEX_VERSION_SMOKE_STDOUT_PREFIX,
  CODEX_VERSION_SMOKE_WASM,
  codexVersionSmokeManifest,
} from "../fixtures/codex-version-smoke-core.js";
import { createBrowserCodexAppServerSession } from "../src/app-server-session.js";
import { createBrowserCodexAppServerWebSocketConstructor } from "../src/app-server-websocket.js";
import { fetchCodexArtifactBytes } from "../src/artifact-manifest.js";
import {
  createBrowserTerminalSession,
  createTerminalTranscript,
} from "../src/terminal.js";
import { createDefaultBrowserWorkspaceStore } from "../src/workspace.js";

const decoder = new TextDecoder();
const NON_COOPERATIVE_LOOP_WASM = base64ToBytes(
  "AGFzbQEAAAABBAFgAAADAgEABQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAAKCQEHAANADAALCw==",
);
const HTTP_BRIDGE_SMOKE_STDOUT = "HTTP_BRIDGE_OK\n";
const BROWSER_TOOL_FIXTURE_STDERR =
  "browser-tool-fixture: inspected workspace\n";
const BROWSER_TOOL_FIXTURE_WEBC = webcBytes("browser-tool-fixture");

export async function runCodexVersionSmoke() {
  const manifest = await codexVersionSmokeManifest();
  const { artifactUrl, fixture } = await fetchCodexArtifactBytes(manifest, {
    fetchImpl: async () =>
      new Response(CODEX_VERSION_SMOKE_WASM, {
        headers: {
          "Content-Length": String(CODEX_VERSION_SMOKE_WASM.byteLength),
        },
        status: 200,
      }),
  });
  assert(
    fixture.expected.stdoutPrefix === CODEX_VERSION_SMOKE_STDOUT_PREFIX,
    "fixture stdout prefix must match the Codex version contract",
  );

  const worker = new Worker(
    new URL("../src/command-worker-entry.js", import.meta.url),
    { name: "codex-version-smoke", type: "module" },
  );
  try {
    const load = await dispatchAndCollect(worker, fixture.commandLoad);
    const transcript = createTerminalTranscript();
    const terminal = createBrowserTerminalSession({
      port: worker,
      sink: transcript.sink,
    });
    const result = await terminal.start(fixture.commandRun);
    const stdout = transcript.stdoutText();
    const stderr = transcript.stderrText();

    assert(load.loaded.packageId === "codex", "Codex package should load");
    assert(
      load.loaded.artifactKind === "wasi-module",
      "Codex package should load as a raw WASI module",
    );
    assert(
      result.exitCode === fixture.expected.exitCode,
      "Codex version smoke should exit successfully",
    );
    assert(
      stdout.startsWith(fixture.expected.stdoutPrefix),
      "Codex version smoke stdout should report the codex-cli version",
    );
    assert(stderr === fixture.expected.stderr, "Codex stderr should be empty");
    const artifactKind = load.loaded.artifactKind;
    const workerEntrypoint = new URL(
      "../src/command-worker-entry.js",
      import.meta.url,
    ).pathname;
    const hardTimeout = await runNonCooperativeTimeout(worker);
    const httpBridge = await runHttpBridgeSmoke(worker);
    const requestBuilder = await runCodexBrowserRequestBuilder(worker);
    const modelTurn = await runCodexBrowserModelTurn(worker);
    const workspaceEdit = await runCodexBrowserWorkspaceEdit(worker);
    const toolFixture = await runBrowserToolFixture(worker, workspaceEdit);
    const appServer = await runBrowserAppServerFixture();

    return {
      appServer,
      artifactKind,
      artifactUrl,
      exitCode: result.exitCode,
      hardTimeout,
      httpBridge,
      modelTurn,
      requestBuilder,
      stderr,
      stdout,
      stdoutBytes: result.stdoutBytes,
      stages: codexVersionSmokeStages({
        appServer,
        artifactKind,
        artifactUrl,
        exitCode: result.exitCode,
        hardTimeout,
        httpBridge,
        modelTurn,
        requestBuilder,
        stdoutBytes: result.stdoutBytes,
        toolFixture,
        workerEntrypoint,
        workspaceEdit,
      }),
      toolFixture,
      workspaceEdit,
      workerEntrypoint,
    };
  } finally {
    worker.terminate();
  }
}

function codexVersionSmokeStages(result) {
  return [
    {
      name: "version",
      status: "passed",
      artifactKind: result.artifactKind,
      artifactUrl: result.artifactUrl,
      exitCode: result.exitCode,
      stdoutBytes: result.stdoutBytes,
      stdoutPrefix: CODEX_VERSION_SMOKE_STDOUT_PREFIX,
      workerEntrypoint: result.workerEntrypoint,
    },
    {
      name: "hard-timeout",
      status: "passed",
      errorKind: result.hardTimeout.errorKind,
      exitCode: result.hardTimeout.exitCode,
      timedOut: result.hardTimeout.timedOut,
    },
    {
      name: "http-bridge",
      status: "passed",
      exitCode: result.httpBridge.exitCode,
      stderrBytes: result.httpBridge.stderrBytes,
      stdoutBytes: result.httpBridge.stdoutBytes,
      urlPath: result.httpBridge.urlPath,
    },
    {
      name: "request-builder",
      status: "passed",
      exitCode: result.requestBuilder.exitCode,
      model: result.requestBuilder.model,
      prompt: result.requestBuilder.prompt,
      runtime: result.requestBuilder.metadata.runtime,
      stdoutBytes: result.requestBuilder.stdoutBytes,
      surface: result.requestBuilder.metadata.surface,
    },
    {
      name: "model-turn",
      status: "passed",
      exitCode: result.modelTurn.exitCode,
      stdoutBytes: result.modelTurn.stdoutBytes,
      urlPath: result.modelTurn.urlPath,
    },
    {
      name: "workspace-edit",
      status: "passed",
      exitCode: result.workspaceEdit.exitCode,
      path: result.workspaceEdit.path,
      replacements: result.workspaceEdit.replacements,
      stdoutBytes: result.workspaceEdit.stdoutBytes,
    },
    {
      name: "app-server",
      status: "passed",
      boundedMessages: result.appServer.boundedMessages,
      interruptStatus: result.appServer.interruptStatus,
      threadId: result.appServer.threadId,
      turnId: result.appServer.turnId,
    },
    {
      name: "tool-fixture",
      status: "passed",
      cwd: result.toolFixture.cwd,
      exitCode: result.toolFixture.exitCode,
      mode: result.toolFixture.mode,
      path: result.toolFixture.path,
      stdoutBytes: result.toolFixture.stdoutBytes,
    },
  ];
}

async function runBrowserAppServerFixture() {
  const WebSocketConstructor =
    createBrowserCodexAppServerWebSocketConstructor({
      runtimeOptions: {
        modelResponseText: "mock browser app-server response",
      },
    });
  const session = createBrowserCodexAppServerSession({
    socket: new WebSocketConstructor("ws://browser-codex-app-server/loopback"),
  });
  try {
    const initialize = await session.connect({
      clientInfo: {
        name: "wasm-host-browser-e2e",
        version: "0.0.0",
      },
      optOutNotificationMethods: ["thread/started"],
    });
    const account = await session.readAccount();
    const login = await session.startDeviceLogin();
    const cancel = await session.cancelDeviceLogin();
    const notificationCount = session.transcript.length;
    const thread = await session.ensureThread({ model: "gpt-5.1" });
    const turn = await session.startPromptTurn("hello app-server");
    let unsupportedError = null;
    try {
      await session.request("native/process/spawn", {});
    } catch (error) {
      unsupportedError = error;
    }
    const interrupt = await runBrowserAppServerInterruptFixture();

    assert(
      initialize.browserFixture.browserHosted === true,
      "App-server fixture should initialize as browser-hosted",
    );
    assert(
      account.requiresOpenaiAuth === true,
      "App-server fixture should report missing account auth",
    );
    assert(
      login.type === "chatgptDeviceCode",
      "App-server fixture should start device login",
    );
    assert(
      cancel.completion.method === "account/login/completed",
      "App-server fixture should emit login cancellation",
    );
    assert(
      session.transcript.length === notificationCount + 3,
      "App-server fixture should honor thread notification opt-out",
    );
    assert(
      turn.item.text === "mock browser app-server response",
      "App-server fixture should emit mocked assistant item text",
    );
    assert(
      unsupportedError?.data?.kind === "unsupported_capability",
      "App-server fixture should classify unsupported methods",
    );

    return {
      accountRequiresAuth: account.requiresOpenaiAuth,
      boundedMessages: 1 + turn.notifications.length,
      cancelNotification: cancel.completion.method,
      errorKind: unsupportedError.data.kind,
      interruptStatus: interrupt.status,
      itemText: turn.item.text,
      loginType: login.type,
      notificationMethods: turn.notifications.map(
        (notification) => notification.method,
      ),
      userAgent: initialize.userAgent,
      threadId: thread.threadId,
      turnId: turn.turn.id,
    };
  } finally {
    session.close();
  }
}

async function runBrowserAppServerInterruptFixture() {
  const WebSocketConstructor =
    createBrowserCodexAppServerWebSocketConstructor({
      runtimeOptions: {
        autoCompleteTurns: false,
      },
    });
  const session = createBrowserCodexAppServerSession({
    socket: new WebSocketConstructor("wss://browser-codex-app-server/loopback"),
  });
  try {
    await session.connect();
    await session.startPendingTurn("wait");
    const interrupted = await session.interruptTurn();
    return {
      status: interrupted.notification.params.turn.status,
    };
  } finally {
    session.close();
  }
}

async function runBrowserToolFixture(worker, workspaceEdit) {
  const load = await dispatchAndCollect(worker, {
    type: "command.load",
    id: "load-browser-tool-fixture",
    package: {
      bytes: BROWSER_TOOL_FIXTURE_WEBC,
      commands: ["tool-inspect"],
      executorType: "browser-tool-fixture",
      id: "browser-tool-fixture",
    },
  });
  assert(
    load.loaded.artifactKind === "webc-package",
    "Browser tool fixture should load as fake WebC package bytes",
  );
  assert(
    load.loaded.packageType === "browser-tool-fixture",
    "Browser tool fixture package should use the built-in executor",
  );
  const transcript = createTerminalTranscript();
  const terminal = createBrowserTerminalSession({
    port: worker,
    sink: transcript.sink,
  });
  const completion = terminal.start({
    id: "run-browser-tool-fixture",
    packageId: "browser-tool-fixture",
    command: "tool-inspect",
    args: [workspaceEdit.path],
    cwd: "/workspace/notes",
    env: { BROWSER_TOOL_MODE: "e2e" },
    timeoutMs: 5000,
  });
  terminal.writeStdin("browser ");
  terminal.writeStdin("stdin\n");
  terminal.closeStdin();
  const result = await completion;
  const stdout = transcript.stdoutText();
  const stderr = transcript.stderrText();
  const payload = JSON.parse(stdout);

  assert(
    payload.workspace.path === workspaceEdit.path,
    "Browser tool fixture should report the workspace path",
  );
  assert(
    payload.workspace.text === workspaceEdit.edited,
    "Browser tool fixture should read the edited workspace file",
  );
  assert(
    payload.stdin === "browser stdin\n",
    "Browser tool fixture should consume stdin",
  );
  assert(
    payload.cwd === "/workspace/notes",
    "Browser tool fixture should receive cwd",
  );
  assert(
    payload.env?.BROWSER_TOOL_MODE === "e2e",
    "Browser tool fixture should receive filtered env",
  );
  assert(
    stderr === BROWSER_TOOL_FIXTURE_STDERR,
    "Browser tool fixture stderr should match",
  );
  return {
    args: payload.args,
    closeStreams: transcript.events
      .filter((event) => event.type === "close")
      .map((event) => event.stream),
    cwd: payload.cwd,
    eventTypes: transcript.events.map((event) => event.type),
    exitCode: result.exitCode,
    mode: payload.env.BROWSER_TOOL_MODE,
    path: payload.workspace.path,
    stderr,
    stderrBytes: result.stderrBytes,
    stdin: payload.stdin,
    stdoutBytes: result.stdoutBytes,
    writeStreams: transcript.events
      .filter((event) => event.type === "write")
      .map((event) => event.stream),
    workspaceText: payload.workspace.text,
  };
}

async function runCodexBrowserWorkspaceEdit(worker) {
  const fixture = await codexBrowserWorkspaceEditFixture();
  const workspace = createDefaultBrowserWorkspaceStore();
  await workspace.createDirectory("/workspace/notes", { recursive: true });
  await workspace.writeFile(
    CODEX_BROWSER_WORKSPACE_EDIT_PATH,
    CODEX_BROWSER_WORKSPACE_EDIT_BEFORE,
  );

  const load = await dispatchAndCollect(worker, fixture.commandLoad);
  assert(
    load.loaded.artifactKind === "codex-browser",
    "Codex browser workspace edit package should load",
  );
  const run = await dispatchAndCollect(worker, fixture.commandRun);
  const stdout = chunksText(run.stdout);
  const stderr = chunksText(run.stderr);
  const payload = JSON.parse(stdout);
  const verifier = createDefaultBrowserWorkspaceStore();
  const edited = chunksText([
    await verifier.readFile(CODEX_BROWSER_WORKSPACE_EDIT_PATH),
  ]);

  assert(
    payload.path === CODEX_BROWSER_WORKSPACE_EDIT_PATH,
    "Codex workspace edit should report the edited path",
  );
  assert(
    edited === "Browser Codex can edit this file.\n",
    "Codex workspace edit should persist the edited file",
  );
  assert(stderr === "", "Codex workspace edit stderr should be empty");
  return {
    edited,
    exitCode: run.complete.result.exitCode,
    path: payload.path,
    replacements: payload.replacements,
    stderr,
    stdoutBytes: run.complete.result.stdoutBytes,
  };
}

async function runCodexBrowserModelTurn(worker) {
  const url = new URL("./codex-model-response.sse", import.meta.url).href;
  assert(
    new URL(url).origin === location.origin,
    "Codex model fixture should be same-origin",
  );
  const fixture = await codexBrowserModelRequestFixture(url);
  const load = await dispatchAndCollect(worker, fixture.commandLoad);
  assert(
    load.loaded.artifactKind === "codex-browser",
    "Codex browser model package should load",
  );
  const run = await dispatchAndCollect(worker, fixture.commandRun);
  const stdout = chunksText(run.stdout);
  const stderr = chunksText(run.stderr);
  assert(stdout === "mock model response\n", "Codex model stdout should match");
  assert(stderr === "", "Codex model stderr should be empty");
  return {
    exitCode: run.complete.result.exitCode,
    stderr,
    stdout,
    stdoutBytes: run.complete.result.stdoutBytes,
    urlPath: new URL(url).pathname,
  };
}

async function runCodexBrowserRequestBuilder(worker) {
  const fixture = await codexBrowserRequestBuilderFixture();
  const load = await dispatchAndCollect(worker, fixture.commandLoad);
  assert(
    load.loaded.artifactKind === "codex-browser",
    "Codex browser request-builder package should load",
  );
  assert(
    load.loaded.packageType === "codex-browser",
    "Codex browser request-builder package should use the custom executor",
  );
  const run = await dispatchAndCollect(worker, fixture.commandRun);
  const stdout = chunksText(run.stdout);
  const stderr = chunksText(run.stderr);
  const payload = JSON.parse(stdout);
  assertCodexBrowserRequestPayload(payload, fixture.expected);
  assert(stderr === "", "Codex browser request-builder stderr should be empty");
  return {
    exitCode: run.complete.result.exitCode,
    metadata: payload.metadata,
    model: payload.model,
    prompt: payload.input?.[0]?.content?.[0]?.text,
    stderr,
    stdoutBytes: run.complete.result.stdoutBytes,
  };
}

async function runHttpBridgeSmoke(worker) {
  const url = new URL("./http-bridge-smoke.txt", import.meta.url).href;
  assert(
    new URL(url).origin === location.origin,
    "HTTP bridge smoke fixture should be same-origin",
  );
  const load = await dispatchAndCollect(worker, {
    type: "command.load",
    id: "load-http-smoke",
    package: {
      commands: ["http-smoke"],
      id: "http-smoke",
      type: "http-smoke",
    },
  });
  assert(load.loaded.packageId === "http-smoke", "HTTP smoke package should load");
  assert(
    load.loaded.packageType === "http-smoke",
    "HTTP smoke package should use the built-in executor",
  );
  const run = await dispatchAndCollect(worker, {
    type: "command.run",
    id: "run-http-smoke",
    packageId: "http-smoke",
    command: "http-smoke",
    args: [url],
    timeoutMs: 5000,
  });
  const stdout = chunksText(run.stdout);
  const stderr = chunksText(run.stderr);
  const result = run.complete.result;
  assert(
    result?.exitCode === 0,
    "HTTP bridge smoke should exit successfully",
  );
  assert(
    stdout === HTTP_BRIDGE_SMOKE_STDOUT,
    "HTTP bridge smoke stdout should match the fixture",
  );
  assert(stderr === "", "HTTP bridge smoke stderr should be empty");
  return {
    exitCode: result.exitCode,
    stderr,
    stderrBytes: result.stderrBytes,
    stdout,
    stdoutBytes: result.stdoutBytes,
    urlPath: new URL(url).pathname,
  };
}

async function runNonCooperativeTimeout(worker) {
  const load = await dispatchAndCollect(worker, {
    type: "command.load",
    id: "load-loop",
    package: {
      artifactKind: "wasi-module",
      command: "loop",
      id: "loop",
      wasiModule: {
        bytes: NON_COOPERATIVE_LOOP_WASM,
      },
    },
  });
  assert(load.loaded.packageId === "loop", "loop package should load");
  const run = await dispatchAndCollect(
    worker,
    {
      type: "command.run",
      id: "run-loop-timeout",
      packageId: "loop",
      command: "loop",
      timeoutMs: 50,
    },
    { resolveError: true },
  );
  assert(
    run.error?.error?.kind === "timeout",
    "non-cooperative raw WASI module should time out",
  );
  assert(
    run.error?.result?.exitCode === 124,
    "non-cooperative timeout should use exit code 124",
  );
  return {
    errorKind: run.error.error.kind,
    exitCode: run.error.result.exitCode,
    timedOut: run.error.result.timedOut,
  };
}

function dispatchAndCollect(worker, message, options = {}) {
  const stdout = [];
  const stderr = [];
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const data = event.data;
      if (data.id !== message.id) {
        return;
      }
      if (data.type === "command.stdout") {
        stdout.push(data.chunk);
        return;
      }
      if (data.type === "command.stderr") {
        stderr.push(data.chunk);
        return;
      }
      if (data.type === "command.started") {
        return;
      }
      if (
        data.type === "command.stdout.close" ||
        data.type === "command.stderr.close"
      ) {
        return;
      }
      cleanup();
      if (data.type === "command.loaded") {
        resolve({ loaded: data });
        return;
      }
      if (data.type === "command.complete") {
        resolve({ complete: data, stderr, stdout });
        return;
      }
      if (data.type === "command.error") {
        if (options.resolveError) {
          resolve({ error: data, stderr, stdout });
          return;
        }
        reject(Object.assign(new Error(data.error.message), data.error));
        return;
      }
      reject(new Error(`unexpected worker event: ${data.type}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage(message);
  });
}

function chunksText(chunks) {
  return decoder.decode(concatChunks(chunks));
}

function concatChunks(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function webcBytes(suffix) {
  const payload = new TextEncoder().encode(suffix);
  const bytes = new Uint8Array(5 + payload.byteLength);
  bytes.set([0x00, 0x77, 0x65, 0x62, 0x63]);
  bytes.set(payload, 5);
  return bytes;
}
