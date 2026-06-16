import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_BROWSER_REQUEST_BUILDER_WASM,
  assertCodexBrowserRequestPayload,
  codexBrowserRequestBuilderFixture,
} from "../fixtures/codex-browser-request-builder-core.js";
import { createBrowserCommandWorkerRuntime } from "../src/command-worker.js";
import { loadCodexBrowserPackage } from "../src/codex-browser.js";

const EMPTY_WASM = base64ToBytes("AGFzbQEAAAA=");
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
