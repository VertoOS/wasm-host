import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const CODEX_VERSION_SMOKE_STDOUT = "codex-cli 0.0.0\n";
export const CODEX_VERSION_SMOKE_STDOUT_PREFIX = "codex-cli ";

export const CODEX_VERSION_SMOKE_WASM = base64ToBytes(
  "AGFzbQEAAAABDAJgBH9/f38Bf2AAAAIjARZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCGZkX3dyaXRlAAADAgEBBQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAEKEAEOAEEBQcAAQQFBEBAAGgsLJQIAQYACCxBjb2RleC1jbGkgMC4wLjAKAEHAAAsIAAEAABAAAAA=",
);

export const DEFAULT_CODEX_ARTIFACT_MANIFEST_PATH =
  "/home/codex/github/codex/codex-wasix/dist/artifact-manifest.json";
export const FALLBACK_CODEX_ARTIFACT_MANIFEST_PATH =
  "/home/codex/.codex/worktrees/a29d/codex/codex-wasix/dist/artifact-manifest.json";

export function localCodexArtifactPaths(env = process.env) {
  const manifestPath = resolveCodexArtifactManifestPath(env);
  return {
    manifestPath,
    wasmPath:
      env.WASM_HOST_CODEX_SMOKE_WASM ??
      resolve(dirname(manifestPath), "codex-version-smoke.wasm"),
  };
}

function resolveCodexArtifactManifestPath(env) {
  if (env.WASM_HOST_CODEX_ARTIFACT_MANIFEST) {
    return env.WASM_HOST_CODEX_ARTIFACT_MANIFEST;
  }
  if (existsSync(DEFAULT_CODEX_ARTIFACT_MANIFEST_PATH)) {
    return DEFAULT_CODEX_ARTIFACT_MANIFEST_PATH;
  }
  return FALLBACK_CODEX_ARTIFACT_MANIFEST_PATH;
}

export function hasLocalCodexVersionSmokeArtifact(env = process.env) {
  const paths = localCodexArtifactPaths(env);
  return existsSync(paths.manifestPath) && existsSync(paths.wasmPath);
}

export async function readLocalCodexVersionSmokeArtifact(env = process.env) {
  const paths = localCodexArtifactPaths(env);
  return {
    bytes: new Uint8Array(await readFile(paths.wasmPath)),
    manifestText: await readFile(paths.manifestPath, "utf8"),
    paths,
  };
}

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
  return new Uint8Array(Buffer.from(value, "base64"));
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
