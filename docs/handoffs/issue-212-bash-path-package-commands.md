# Issue 212 Handoff: Bash PATH Package Commands

## Status

Implemented the package-command visibility slice for
[issue #212](https://github.com/VertoOS/wasm-host/issues/212).

The first real browser Bash/coreutils smoke now passes in Chromium:

```sh
bash -lc 'pwd; ls /workspace; echo BASH_BROWSER_OK'
```

The expected stdout is exactly:

```text
/workspace
BASH_BROWSER_OK
```

stderr is empty and the command exits `0`.

## Implementation Notes

- `apps/web/src/command-worker.js` now passes the loaded command catalog to
  executor requests.
- `apps/web/src/webc-wasix.js` overlays generated command shims for absolute
  catalog paths such as `/bin/ls` and `/usr/bin/env` into WebC package-root
  files, without overriding files owned by the package.
- `apps/web/src/webc-wasix.js` strips the duplicated WASIX exec argv0 when
  `proc_exec*` child-command replacement reaches a WebC WASIX command. This
  keeps coreutils from treating `ls` itself as an operand.
- `apps/web/src/wasi-module.js` lets the package-root `/` preopen resolve
  absolute guest paths like `/bin/ls`.
- `apps/web/src/wasi-module.js` exposes virtual `/workspace` and `/tmp`
  directories under the package-root `/` preopen, so package tools reached
  through Bash PATH can inspect the normal browser mounts.
- `apps/web/src/wasi-module.js` permits read-only workspace directory opens
  where the guest asks for directory rights, which is needed for
  `ls /workspace`.
- `random_get` now fills a temporary ordinary `Uint8Array` before copying into
  guest memory. Chromium rejects `crypto.getRandomValues()` directly on
  shared-memory-backed views from these WebC atoms.

## Tests Added Or Updated

- `apps/web/test/command-worker.test.js` covers command-catalog delivery to
  executors, WebC command-shim root files, duplicate WASIX exec argv0 stripping,
  and child-command propagation of `wasixExecArgv0`.
- `apps/web/test/wasi-module.test.js` pins `wasixExecArgv0` on WASIX
  `proc_exec*` child-command requests and verifies `random_get` uses ordinary
  `ArrayBuffer` chunks.
- `apps/web/e2e/bash-coreutils-smoke.js` now treats the Bash/coreutils WebC
  smoke as passing instead of blocked.
- `apps/web/e2e/codex-version-smoke-runner.js` now expects the Bash/coreutils
  stage to pass with empty stderr.

## Validation

Ran:

```sh
node --check apps/web/src/wasi-module.js
node --check apps/web/src/command-worker.js
node --check apps/web/src/webc-wasix.js
node --test apps/web/test/command-worker.test.js
node --test apps/web/test/wasi-module.test.js
WASM_HOST_BROWSER_E2E_REQUIRED=1 npm --prefix apps/web run test:e2e
npm --prefix apps/web run check
npm --prefix apps/web test
git diff --check
cargo fmt --all --check
```

## Architecture Boundary

No high-level MCP, plugin, OAuth, provider, or connector runtime was added under
`apps/web`. The existing `apps/web/scripts/check-architecture.js` guard remains
in `npm run check`, and the new implementation stays at the lower-level package
catalog, WebC/WASIX, WASI path, and browser filesystem boundaries.

## Recommended Next Slice

Keep grouping work by runtime behavior rather than one syscall per PR. Good
follow-ups after this slice are:

- broaden shell/package behavior with another concrete browser smoke, such as a
  small script that uses multiple coreutils commands and workspace files
- start the real git package investigation once a pinned browser-runnable git
  artifact is identified
- add deeper conformance around package-root `/workspace` and `/tmp` directory
  behavior if future packages rely on more than stat/open/readdir
- keep process spawn, signals, general blocking join, full fork/store cloning,
  interactive TTY, raw sockets, and worker threads as explicit later capability
  groups

Continue to avoid first-class MCP/plugin/provider/OAuth/connector concepts in
`apps/web`; build those as separate adapter packages over neutral browser host
protocols when the lower-level contracts are ready.
