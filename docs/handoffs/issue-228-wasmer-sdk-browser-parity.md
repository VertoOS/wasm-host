# Issue 228: Wasmer SDK Browser Parity Proof

## Links

- Issue: https://github.com/VertoOS/wasm-host/issues/228
- Parent evaluation: https://github.com/VertoOS/wasm-host/issues/226
- Follow-up SDK blocker: https://github.com/VertoOS/wasm-host/issues/230
- Branch: `bkamal/wasmer-sdk-browser-parity`
- Prior adapter package: `packages/wasmer-sdk-adapter`
- Existing Bash/coreutils browser smoke:
  `apps/web/e2e/bash-coreutils-smoke.js`

## Goal

Use the isolated `packages/wasmer-sdk-adapter` boundary with the real
`@wasmer/sdk` in browser automation to determine whether the SDK can satisfy
the Bash/coreutils browser contract.

## Scope

- Add a browser smoke that imports the adapter and real SDK outside first-class
  `apps/web/src` runtime wiring.
- Serve that smoke with COOP/COEP headers and assert `crossOriginIsolated` and
  `SharedArrayBuffer` availability before attempting SDK execution.
- Attempt SDK-backed Bash/coreutils workflows for exact stdout, stderr, exit
  status, PATH lookup, and workspace mount/writeback behavior.
- Attempt or explicitly classify pinned WebC byte loading through
  `Wasmer.fromFile()` versus registry-backed package loading.
- Document the result precisely, including SDK blockers if execution cannot
  complete in the browser.

## Constraints

- Do not import `@wasmer/sdk` from `apps/web/src`.
- Do not replace `apps/web/src/webc-wasix.js`, the command worker contract, or
  existing Bash/coreutils WebC e2e coverage.
- Do not add first-class Wasmer SDK, MCP, provider, plugin, OAuth, or connector
  concepts under `apps/web`.
- Keep the proof isolated enough that wasm-host can choose whether to wire the
  SDK later.

## Validation Targets

- `npm --prefix packages/wasmer-sdk-adapter run check`
- `npm --prefix packages/wasmer-sdk-adapter test`
- `npm --prefix apps/web run check`
- Browser smoke for the SDK proof, or a deterministic skipped/blocker result
  with exact failure classification when the environment cannot run it.
- `git diff --check`

## Implementation Notes

- Prefer adding test/demo code under the adapter package or e2e-only surfaces,
  not app runtime code.
- If a dev server is needed, use explicit COOP/COEP headers:
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`.
- Keep registry package names and versions explicit in the smoke so results are
  repeatable.
- If real SDK execution fails, preserve enough structured diagnostics to tell
  whether the blocker is package resolution, COI/SAB setup, SDK initialization,
  command lookup, `wait()` completion, byte loading, or behavior mismatch.

## Result

- Added `packages/wasmer-sdk-adapter/e2e/browser-parity.html`,
  `browser-parity.js`, and `browser-parity-runner.js`.
- The adapter now forwards SDK `uses` so Bash can request auxiliary packages
  such as `wasmer/coreutils@1.0.25`.
- The browser runner serves from the repository root with
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`.
- Chromium proof confirmed:
  - `crossOriginIsolated: true`
  - `isSecureContext: true`
  - `SharedArrayBuffer` available
  - SDK module import succeeds
  - SDK default initialization proceeds far enough to run package commands
  - optional CDN inline-Wasm import fails with `ReferenceError: buf is not
    defined`
  - pinned `wasmer/bash@1.0.25` WebC bytes fetch and SHA-256 verification
    succeed
- The current blocker is SDK package execution behavior:
  - registry `wasmer/coreutils@1.0.25` command `echo SDK_COREUTILS_OK` exits
    `45` with empty stdout/stderr
  - pinned `wasmer/bash@1.0.25` WebC bytes passed through `Wasmer.fromFile()`
    load far enough for `bash --version` to run, but that command exits `45`
    with empty stdout/stderr
- Because coreutils cannot run a minimal `echo`, exact Bash/coreutils parity for
  stdout, stderr, process exit status, PATH lookup, and workspace writeback is
  not supported by the SDK path yet. Track the exit-45 investigation in #230.

## Open Questions

- Which Wasmer registry package/version gives the closest Bash/coreutils parity
  target for the existing browser contract?
- Does `Wasmer.fromFile()` accept the pinned Bash/coreutils WebC bytes used by
  `apps/web/e2e/bash-coreutils-smoke.js`?
- Can SDK-backed runs mutate a mounted `Directory` and allow reliable
  post-run workspace snapshot readback in Chromium?
