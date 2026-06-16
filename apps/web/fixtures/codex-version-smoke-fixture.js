import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export {
  CODEX_VERSION_SMOKE_STDOUT,
  CODEX_VERSION_SMOKE_STDOUT_PREFIX,
  CODEX_VERSION_SMOKE_WASM,
  codexVersionSmokeManifest,
} from "./codex-version-smoke-core.js";

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
