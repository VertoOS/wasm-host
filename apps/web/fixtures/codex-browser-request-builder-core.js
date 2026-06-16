export const CODEX_BROWSER_REQUEST_BUILDER_ARTIFACT_KIND = "codex-browser";
export const CODEX_BROWSER_REQUEST_BUILDER_COMMAND = "build-request";
export const CODEX_BROWSER_REQUEST_BUILDER_ID = "codex-browser";
export const CODEX_BROWSER_REQUEST_BUILDER_MODEL = "gpt-5.1";
export const CODEX_BROWSER_REQUEST_BUILDER_PROMPT = "Explain wasm-host";
export const CODEX_BROWSER_REQUEST_BUILDER_RUNTIME = "wasm32-unknown-unknown";

export const CODEX_BROWSER_REQUEST_BUILDER_WASM = base64ToBytes(
  "AGFzbQEAAAABIQZgA39/fwF/YAF/AX9gAn9/AGAEf39/fwF/YAABf2AAAAMJCAABAgMEBAQFBQMBAAEGEgN/AUGAwAALfwFBAAt/AUEACweGAQgGbWVtb3J5AgALY29kZXhfYWxsb2MAAQpjb2RleF9mcmVlAAITY29kZXhfYnVpbGRfcmVxdWVzdAADDWNvZGV4X3ZlcnNpb24ABBBjb2RleF9vdXRwdXRfcHRyAAUQY29kZXhfb3V0cHV0X2xlbgAGEmNvZGV4X2NsZWFyX291dHB1dAAHCtABCC8BAX8CQANAIAMgAk8NASAAIANqIAEgA2otAAA6AAAgA0EBaiEDDAALCyAAIAJqCxEBAX8jACEBIwAgAGokACABCwIAC08BAX9BgBAkAUGAECEEIARBwABBDhAAIQQgBCACIAMQACEEIARB3gBBrgEQACEEIAQgACABEAAhBCAEQZwCQYkBEAAhBCAEQYAQayQCQQALJAEBf0GAECQBQYAQIQAgAEG1A0GHARAAIQAgAEGAEGskAkEACwQAIwELBAAjAgsKAEEAJAFBACQCCwvoAwQAQcAACw57CiAgIm1vZGVsIjogIgBB3gALrgEiLAogICJpbnN0cnVjdGlvbnMiOiAiYnJvd3NlciBmaXh0dXJlIGluc3RydWN0aW9ucyIsCiAgImlucHV0IjogWwogICAgewogICAgICAicm9sZSI6ICJ1c2VyIiwKICAgICAgImNvbnRlbnQiOiBbCiAgICAgICAgewogICAgICAgICAgInR5cGUiOiAiaW5wdXRfdGV4dCIsCiAgICAgICAgICAidGV4dCI6ICIAQZwCC4kBIgogICAgICAgIH0KICAgICAgXQogICAgfQogIF0sCiAgInN0cmVhbSI6IGZhbHNlLAogICJtZXRhZGF0YSI6IHsKICAgICJzdXJmYWNlIjogImJyb3dzZXIiLAogICAgInJ1bnRpbWUiOiAid2FzbTMyLXVua25vd24tdW5rbm93biIKICB9Cn0AQbUDC4cBewogICJjcmF0ZV9uYW1lIjogImNvZGV4LWJyb3dzZXIiLAogICJ2ZXJzaW9uIjogIjAuMC4wIiwKICAiZGVmYXVsdF9tb2RlbCI6ICJncHQtNSIsCiAgImluc3RydWN0aW9ucyI6ICJicm93c2VyIGZpeHR1cmUgaW5zdHJ1Y3Rpb25zIgp9",
);

export async function codexBrowserRequestBuilderFixture(
  bytes = CODEX_BROWSER_REQUEST_BUILDER_WASM,
  options = {},
) {
  const artifactSha256 = await sha256Hex(bytes);
  const packageId = options.packageId ?? CODEX_BROWSER_REQUEST_BUILDER_ID;
  const command = options.command ?? CODEX_BROWSER_REQUEST_BUILDER_COMMAND;
  const prompt = options.prompt ?? CODEX_BROWSER_REQUEST_BUILDER_PROMPT;
  const model = options.model ?? CODEX_BROWSER_REQUEST_BUILDER_MODEL;
  return {
    commandLoad: {
      type: "command.load",
      id: `load-${packageId}`,
      package: {
        artifactKind: CODEX_BROWSER_REQUEST_BUILDER_ARTIFACT_KIND,
        codexBrowser: {
          bytes,
          expectedSha256: artifactSha256,
        },
        commands: [command],
        defaultCommand: command,
        entrypoint: "codex_build_request",
        id: packageId,
        metadata: {
          artifactKind: CODEX_BROWSER_REQUEST_BUILDER_ARTIFACT_KIND,
          artifactSha256,
          runtime: CODEX_BROWSER_REQUEST_BUILDER_RUNTIME,
        },
        type: CODEX_BROWSER_REQUEST_BUILDER_ARTIFACT_KIND,
      },
    },
    commandRun: {
      type: "command.run",
      id: `run-${packageId}-${command}`,
      packageId,
      command,
      args: [prompt, model],
      env: {},
      cwd: "/workspace",
      stdinOpen: false,
    },
    expected: {
      model,
      prompt,
      runtime: CODEX_BROWSER_REQUEST_BUILDER_RUNTIME,
    },
  };
}

export function assertCodexBrowserRequestPayload(payload, expected = {}) {
  if (payload.model !== expected.model) {
    throw new Error(`expected model ${expected.model}, got ${payload.model}`);
  }
  const text = payload.input?.[0]?.content?.[0]?.text;
  if (text !== expected.prompt) {
    throw new Error(`expected prompt ${expected.prompt}, got ${text}`);
  }
  if (payload.stream !== false) {
    throw new Error("expected stream false");
  }
  if (payload.metadata?.surface !== "browser") {
    throw new Error("expected browser surface metadata");
  }
  if (payload.metadata?.runtime !== expected.runtime) {
    throw new Error(
      `expected runtime ${expected.runtime}, got ${payload.metadata?.runtime}`,
    );
  }
}

function base64ToBytes(value) {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  const decoded = globalThis.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
