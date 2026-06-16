import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_BROWSER_REQUEST_BUILDER_WASM,
  assertCodexBrowserRequestPayload,
  codexBrowserModelRequestFixture,
  codexBrowserRequestBuilderFixture,
} from "../fixtures/codex-browser-request-builder-core.js";
import { createBrowserCommandWorkerRuntime } from "../src/command-worker.js";
import { loadCodexBrowserPackage } from "../src/codex-browser.js";
import {
  DirectFetchHttpTransport,
  GatewayFetchHttpTransport,
} from "../src/http.js";
import {
  createFakeBrowserDeviceFlowAuthBroker,
  createMemorySecretProvider,
} from "../src/secrets.js";

const EMPTY_WASM = base64ToBytes("AGFzbQEAAAA=");
const MODEL_SECRET_REF_ENV = "CODEX_MODEL_BEARER_SECRET_REF";
const MODEL_SECRET_REF = "codex-model-bearer";
const MODEL_SECRET_TOKEN = "test-codex-model-token";
const MODEL_SECRET_THROW_TOKEN = "provider-threw-token";
const decoder = new TextDecoder();

test("codex-browser executor builds Responses request JSON", async () => {
  const fixture = await codexBrowserRequestBuilderFixture();
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage(fixture.commandLoad);
  await runtime.handleMessage(fixture.commandRun);

  assert.equal(port.messages[0].type, "command.loaded");
  assert.equal(port.messages[0].artifactKind, "codex-browser");
  assert.equal(port.messages[0].packageType, "codex-browser");
  assert.equal(port.messages[0].entrypoint, "codex_build_request");
  assert.match(port.messages[0].contentSha256, /^[a-f0-9]{64}$/);

  const stdout = stdoutText(port.messages);
  assertCodexBrowserRequestPayload(JSON.parse(stdout), fixture.expected);
  assert.equal(port.messages.at(-1).type, "command.complete");
  assert.deepEqual(port.messages.at(-1).result, {
    cancelled: false,
    exitCode: 0,
    failureStage: null,
    stderrBytes: 0,
    stdoutBytes: stdout.length,
    timedOut: false,
  });
});

test("codex-browser loader rejects modules without the custom ABI", async () => {
  await assert.rejects(
    loadCodexBrowserPackage({
      artifactKind: "codex-browser",
      codexBrowser: { bytes: EMPTY_WASM },
      commands: ["build-request"],
      id: "bad-codex-browser",
      type: "codex-browser",
    }),
    (error) => {
      assert.equal(error.kind, "invalid_package");
      assert.match(error.message, /memory/);
      return true;
    },
  );
});

test("codex-browser executor reports missing prompt as command error", async () => {
  const fixture = await codexBrowserRequestBuilderFixture(
    CODEX_BROWSER_REQUEST_BUILDER_WASM,
    { packageId: "codex-browser-empty-prompt" },
  );
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage(fixture.commandLoad);
  await runtime.handleMessage({
    ...fixture.commandRun,
    args: [],
    id: "run-codex-browser-empty-prompt",
  });

  const error = port.messages.at(-1);
  assert.equal(error.type, "command.error");
  assert.equal(error.error.kind, "invalid_request");
  assert.equal(error.error.stage, "startup");
  assert.equal(error.result.exitCode, 2);
});

test("codex-browser model-request streams direct Fetch responses to stdout", async () => {
  const seen = {};
  const fixture = await codexBrowserModelRequestFixture(
    "https://model.example.test/v1/responses",
  );
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: {
      direct: new DirectFetchHttpTransport({
        fetchImpl: async (url, init) => {
          seen.url = url;
          seen.method = init.method;
          seen.headers = Array.from(init.headers.entries());
          seen.body = JSON.parse(await readableBodyText(init.body));
          return new Response(readableStream(["hello ", "model"]), {
            headers: { "Content-Type": "text/plain" },
            status: 200,
          });
        },
      }),
    },
    port,
  });

  await runtime.handleMessage(fixture.commandLoad);
  await runtime.handleMessage(fixture.commandRun);

  assert.equal(seen.url, "https://model.example.test/v1/responses");
  assert.equal(seen.method, "POST");
  assert.deepEqual(seen.headers, [
    ["accept", "text/event-stream, application/json"],
    ["content-type", "application/json"],
  ]);
  assertCodexBrowserRequestPayload(seen.body, fixture.expected);
  assert.equal(stdoutText(port.messages), "hello model");
  assert.equal(port.messages.at(-1).type, "command.complete");
  assert.equal(port.messages.at(-1).result.exitCode, 0);
});

test("codex-browser model-request streams gateway responses to stdout", async () => {
  const seen = {};
  const fixture = await codexBrowserModelRequestFixture(
    "https://model.example.test/v1/responses",
  );
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    codexBrowser: {
      secretProvider: createMemorySecretProvider({
        [MODEL_SECRET_REF]: MODEL_SECRET_TOKEN,
      }),
    },
    httpTransports: {
      gateway: new GatewayFetchHttpTransport({
        endpoint: "https://gateway.example.test/bridge",
        fetchImpl: async (url, init) => {
          seen.url = url;
          seen.method = init.method;
          seen.headers = Array.from(init.headers.entries());
          seen.body = JSON.parse(await readableBodyText(init.body));
          return new Response(
            readableStream([
              gatewayFrame({ type: "response", status: 200, headers: [] }),
              gatewayFrame({
                type: "body_chunk",
                body_base64: base64("gateway "),
              }),
              gatewayFrame({
                type: "body_chunk",
                body_base64: base64("model"),
              }),
              gatewayFrame({ type: "body_end" }),
            ]),
            {
              headers: { "Content-Type": "application/x-ndjson" },
              status: 200,
            },
          );
        },
      }),
    },
    port,
  });

  await runtime.handleMessage(fixture.commandLoad);
  await runtime.handleMessage({
    ...fixture.commandRun,
    env: {
      ...fixture.commandRun.env,
      [MODEL_SECRET_REF_ENV]: MODEL_SECRET_REF,
    },
    httpTransport: "gateway",
    id: "run-codex-browser-model-gateway",
  });

  assert.equal(seen.url, "https://gateway.example.test/bridge");
  assert.equal(seen.method, "POST");
  assert.deepEqual(seen.headers, [
    ["accept", "application/json, application/x-ndjson"],
    ["content-type", "application/json"],
  ]);
  assert.equal(seen.body.method, "POST");
  assert.equal(seen.body.url, "https://model.example.test/v1/responses");
  assert.deepEqual(seen.body.headers, [
    { name: "content-type", value: "application/json" },
    { name: "accept", value: "text/event-stream, application/json" },
    { name: "authorization", value: `Bearer ${MODEL_SECRET_TOKEN}` },
  ]);
  assertCodexBrowserRequestPayload(
    JSON.parse(decoder.decode(Buffer.from(seen.body.body_chunks_base64[0], "base64"))),
    fixture.expected,
  );
  assert.equal(stdoutText(port.messages), "gateway model");
  assert.equal(port.messages.at(-1).type, "command.complete");
  assertNoMessageLeak(port.messages, [MODEL_SECRET_TOKEN]);
});

test("codex-browser model-request injects host bearer secrets into direct Fetch", async () => {
  const seen = {};
  const fixture = await codexBrowserModelRequestFixture(
    "https://model.example.test/v1/responses",
  );
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    codexBrowser: {
      secretProvider: createMemorySecretProvider({
        [MODEL_SECRET_REF]: MODEL_SECRET_TOKEN,
      }),
    },
    httpTransports: {
      direct: new DirectFetchHttpTransport({
        fetchImpl: async (url, init) => {
          seen.url = url;
          seen.headers = Array.from(init.headers.entries());
          seen.body = JSON.parse(await readableBodyText(init.body));
          return new Response(readableStream(["authorized model"]), {
            status: 200,
          });
        },
      }),
    },
    port,
  });

  await runtime.handleMessage(fixture.commandLoad);
  await runtime.handleMessage({
    ...fixture.commandRun,
    env: {
      ...fixture.commandRun.env,
      [MODEL_SECRET_REF_ENV]: MODEL_SECRET_REF,
    },
    id: "run-codex-browser-model-auth",
  });

  assert.equal(seen.url, "https://model.example.test/v1/responses");
  assert.deepEqual(seen.headers, [
    ["accept", "text/event-stream, application/json"],
    ["authorization", `Bearer ${MODEL_SECRET_TOKEN}`],
    ["content-type", "application/json"],
  ]);
  assertCodexBrowserRequestPayload(seen.body, fixture.expected);
  assert.equal(stdoutText(port.messages), "authorized model");
  assert.equal(port.messages.at(-1).type, "command.complete");
  assertNoMessageLeak(port.messages, [MODEL_SECRET_TOKEN]);
});

test("codex-browser model-request uses externally completed device auth secrets", async () => {
  const seen = {};
  const auth = createFakeBrowserDeviceFlowAuthBroker();
  const login = await auth.startDeviceLogin({ secretRef: MODEL_SECRET_REF });
  const completed = await auth.completeDeviceLogin(login.loginId, {
    account: { id: "acct_device" },
    bearerToken: MODEL_SECRET_TOKEN,
  });
  const fixture = await codexBrowserModelRequestFixture(
    "https://model.example.test/v1/responses",
  );
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    codexBrowser: { secretProvider: auth },
    httpTransports: {
      direct: new DirectFetchHttpTransport({
        fetchImpl: async (url, init) => {
          seen.url = url;
          seen.headers = Array.from(init.headers.entries());
          seen.body = JSON.parse(await readableBodyText(init.body));
          return new Response(readableStream(["device auth model"]), {
            status: 200,
          });
        },
      }),
    },
    port,
  });

  await runtime.handleMessage(fixture.commandLoad);
  await runtime.handleMessage({
    ...fixture.commandRun,
    env: {
      ...fixture.commandRun.env,
      [MODEL_SECRET_REF_ENV]: completed.secretRef,
    },
    id: "run-codex-browser-model-device-auth",
  });

  assert.equal(seen.url, "https://model.example.test/v1/responses");
  assert.deepEqual(seen.headers, [
    ["accept", "text/event-stream, application/json"],
    ["authorization", `Bearer ${MODEL_SECRET_TOKEN}`],
    ["content-type", "application/json"],
  ]);
  assertCodexBrowserRequestPayload(seen.body, fixture.expected);
  assert.equal(stdoutText(port.messages), "device auth model");
  assert.equal(port.messages.at(-1).type, "command.complete");
  assertNoMessageLeak(port.messages, [MODEL_SECRET_TOKEN]);
  assertNoMessageLeak([completed], [MODEL_SECRET_TOKEN]);
});

test("codex-browser model-request rejects missing bearer secrets without leaking refs", async () => {
  let called = false;
  const fixture = await codexBrowserModelRequestFixture(
    "https://model.example.test/v1/responses",
  );
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    codexBrowser: {
      secretProvider: createMemorySecretProvider(),
    },
    httpTransports: {
      direct: new DirectFetchHttpTransport({
        fetchImpl: async () => {
          called = true;
          return new Response("unexpected", { status: 200 });
        },
      }),
    },
    port,
  });

  await runtime.handleMessage(fixture.commandLoad);
  await runtime.handleMessage({
    ...fixture.commandRun,
    env: {
      ...fixture.commandRun.env,
      [MODEL_SECRET_REF_ENV]: MODEL_SECRET_REF,
    },
    id: "run-codex-browser-model-missing-auth",
  });

  const error = port.messages.at(-1);
  assert.equal(called, false);
  assert.equal(error.type, "command.error");
  assert.equal(error.error.kind, "auth_failure");
  assert.equal(error.error.stage, "startup");
  assert.equal(error.result.exitCode, 2);
  assert.equal(stdoutText(port.messages), "");
  assertNoMessageLeak(port.messages, [MODEL_SECRET_REF, MODEL_SECRET_TOKEN]);
});

test("codex-browser model-request redacts provider failure details", async () => {
  const fixture = await codexBrowserModelRequestFixture(
    "https://model.example.test/v1/responses",
  );
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    codexBrowser: {
      secretProvider: {
        async getBearerToken(_name, context) {
          assert.equal(context.purpose, "codex-model-request");
          assert(context.signal instanceof AbortSignal);
          throw new Error(`provider failed with ${MODEL_SECRET_THROW_TOKEN}`);
        },
      },
    },
    httpTransports: {
      direct: {
        async dispatch() {
          throw new Error("provider failure test should not dispatch");
        },
      },
    },
    port,
  });

  await runtime.handleMessage(fixture.commandLoad);
  await runtime.handleMessage({
    ...fixture.commandRun,
    env: {
      ...fixture.commandRun.env,
      [MODEL_SECRET_REF_ENV]: MODEL_SECRET_REF,
    },
    id: "run-codex-browser-model-provider-redaction",
  });

  const error = port.messages.at(-1);
  assert.equal(error.type, "command.error");
  assert.equal(error.error.kind, "auth_failure");
  assert.equal(error.error.message, "browser secret provider failed");
  assert.equal(error.result.exitCode, 2);
  assertNoMessageLeak(port.messages, [
    MODEL_SECRET_REF,
    MODEL_SECRET_THROW_TOKEN,
  ]);
});

test("codex-browser model-request redacts token-bearing transport errors", async () => {
  const fixture = await codexBrowserModelRequestFixture(
    "https://model.example.test/v1/responses",
  );
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    codexBrowser: {
      secretProvider: createMemorySecretProvider({
        [MODEL_SECRET_REF]: MODEL_SECRET_TOKEN,
      }),
    },
    httpTransports: {
      direct: {
        async dispatch() {
          const error = new Error(`transport leaked ${MODEL_SECRET_TOKEN}`);
          error.kind = "transport";
          error.stage = "runtime";
          error.exitCode = 1;
          throw error;
        },
      },
    },
    port,
  });

  await runtime.handleMessage(fixture.commandLoad);
  await runtime.handleMessage({
    ...fixture.commandRun,
    env: {
      ...fixture.commandRun.env,
      [MODEL_SECRET_REF_ENV]: MODEL_SECRET_REF,
    },
    id: "run-codex-browser-model-transport-redaction",
  });

  const error = port.messages.at(-1);
  assert.equal(error.type, "command.error");
  assert.equal(error.error.kind, "transport");
  assert.equal(error.error.message, "transport leaked [redacted]");
  assert.equal(error.result.exitCode, 1);
  assertNoMessageLeak(port.messages, [MODEL_SECRET_REF, MODEL_SECRET_TOKEN]);
});

test("codex-browser model-request rejects missing endpoints", async () => {
  const fixture = await codexBrowserModelRequestFixture(undefined);
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: { direct: {} },
    port,
  });

  await runtime.handleMessage(fixture.commandLoad);
  await runtime.handleMessage({
    ...fixture.commandRun,
    id: "run-codex-browser-model-missing-endpoint",
  });

  const error = port.messages.at(-1);
  assert.equal(error.type, "command.error");
  assert.equal(error.error.kind, "invalid_request");
  assert.equal(error.error.stage, "startup");
  assert.equal(error.result.exitCode, 2);
  assert.equal(stdoutText(port.messages), "");
});

test("codex-browser model-request reports non-2xx responses as command errors", async () => {
  const fixture = await codexBrowserModelRequestFixture(
    "https://model.example.test/v1/responses",
  );
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: {
      direct: new DirectFetchHttpTransport({
        fetchImpl: async () =>
          new Response(readableStream(["model failed"]), { status: 503 }),
      }),
    },
    port,
  });

  await runtime.handleMessage(fixture.commandLoad);
  await runtime.handleMessage({
    ...fixture.commandRun,
    id: "run-codex-browser-model-non-2xx",
  });

  const error = port.messages.at(-1);
  assert.equal(error.type, "command.error");
  assert.equal(error.error.kind, "transport");
  assert.match(error.error.message, /status 503/);
  assert.equal(error.result.exitCode, 1);
  assert.equal(stdoutText(port.messages), "");
});

test("codex-browser model-request times out in-flight HTTP requests", async () => {
  const fixture = await codexBrowserModelRequestFixture(
    "https://model.example.test/v1/responses",
  );
  const port = recordingPort();
  const runtime = createBrowserCommandWorkerRuntime({
    httpTransports: {
      direct: new DirectFetchHttpTransport({
        fetchImpl: fetchThatWaitsForAbort,
      }),
    },
    port,
  });

  await runtime.handleMessage(fixture.commandLoad);
  await runtime.handleMessage({
    ...fixture.commandRun,
    id: "run-codex-browser-model-timeout",
    timeoutMs: 5,
  });

  const error = port.messages.at(-1);
  assert.equal(error.type, "command.error");
  assert.equal(error.error.kind, "timeout");
  assert.equal(error.result.exitCode, 124);
  assert.equal(error.result.timedOut, true);
});

function recordingPort() {
  const messages = [];
  return {
    messages,
    postMessage(message) {
      messages.push(message);
    },
  };
}

function stdoutText(messages) {
  return decoder.decode(
    concatChunks(
      messages
        .filter((message) => message.type === "command.stdout")
        .map((message) => message.chunk),
    ),
  );
}

function assertNoMessageLeak(messages, values) {
  const text = JSON.stringify(messages);
  for (const value of values) {
    assert(!text.includes(value), "command messages leaked a sensitive value");
  }
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

function base64ToBytes(value) {
  return new Uint8Array(Buffer.from(value, "base64"));
}

async function readableBodyText(body) {
  if (!body) {
    return "";
  }
  const response = new Response(body);
  return response.text();
}

function readableStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
}

function gatewayFrame(frame) {
  return `${JSON.stringify(frame)}\n`;
}

function base64(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function fetchThatWaitsForAbort(_url, init) {
  return new Promise((_resolve, reject) => {
    init.signal.addEventListener(
      "abort",
      () => reject(new DOMException("Fetch aborted", "AbortError")),
      { once: true },
    );
  });
}
