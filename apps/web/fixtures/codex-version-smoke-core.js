export const CODEX_VERSION_SMOKE_STDOUT = "codex-cli 0.0.0\n";
export const CODEX_VERSION_SMOKE_STDOUT_PREFIX = "codex-cli ";

export const CODEX_VERSION_SMOKE_WASM = base64ToBytes(
  "AGFzbQEAAAABDAJgBH9/f38Bf2AAAAIjARZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCGZkX3dyaXRlAAADAgEBBQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAEKEAEOAEEBQcAAQQFBEBAAGgsLJQIAQYACCxBjb2RleC1jbGkgMC4wLjAKAEHAAAsIAAEAABAAAAA=",
);

export async function codexVersionSmokeManifest(
  bytes = CODEX_VERSION_SMOKE_WASM,
  options = {},
) {
  return {
    schemaVersion: 1,
    packageName: "codex",
    artifactKind: "wasi-module",
    artifactPath:
      options.artifactPath ?? "codex-wasix/dist/codex-version-smoke.wasm",
    artifactSizeBytes: bytes.byteLength,
    artifactSha256: await sha256Hex(bytes),
    command: "codex",
    entrypoint: "_start",
    args: ["--version"],
    expectedExitCode: 0,
    stdoutPrefix: CODEX_VERSION_SMOKE_STDOUT_PREFIX,
    expectedStderr: "",
    wasi: "preview1",
    requiresNetwork: false,
    requiresWorkspace: false,
    requiresHostCommand: false,
    requiresTerminal: false,
  };
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
