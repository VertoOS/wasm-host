import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

export const DEFAULT_CODEX_BROWSER_WASM_PATH =
  "/home/codex/github/wasm/codex_browser.wasm";
export const FALLBACK_CODEX_BROWSER_WASM_PATH =
  "/home/codex/github/codex/codex-rs/target/wasm32-unknown-unknown/release/codex_browser.wasm";

export function localCodexBrowserWasmPath(env = process.env) {
  if (env.WASM_HOST_CODEX_BROWSER_WASM) {
    return env.WASM_HOST_CODEX_BROWSER_WASM;
  }
  if (existsSync(DEFAULT_CODEX_BROWSER_WASM_PATH)) {
    return DEFAULT_CODEX_BROWSER_WASM_PATH;
  }
  return FALLBACK_CODEX_BROWSER_WASM_PATH;
}

export function hasLocalCodexBrowserWasm(env = process.env) {
  return existsSync(localCodexBrowserWasmPath(env));
}

export async function readLocalCodexBrowserWasm(env = process.env) {
  return new Uint8Array(await readFile(localCodexBrowserWasmPath(env)));
}
