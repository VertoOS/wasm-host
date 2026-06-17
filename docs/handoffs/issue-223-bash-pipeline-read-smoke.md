# Issue 223: Browser Bash Pipeline And Read Smoke

## Links

- Issue: https://github.com/VertoOS/wasm-host/issues/223
- Branch: `bkamal/bash-pipeline-read-smoke`

## Goal

Add focused browser Bash/coreutils coverage for non-interactive shell pipelines
and `read` behavior in the packaged WebC/WASIX runtime.

## Scope

- Add a named Bash/coreutils smoke stage that exercises a builtin-to-packaged
  command pipeline.
- Exercise shell `read` with redirected input in a non-interactive Bash run.
- Capture pipe/file-backed fd `0` bytes for `proc_exec*` child packaged
  commands so Bash pipeline right-hand commands receive redirected stdin.
- Assert exact stdout, stderr, exit code, and absence of unexpected
  fork/join/stack diagnostics.
- Document the stage in the browser runtime contract and Bash/coreutils audit.

## Constraints

- Do not add first-class MCP, plugin, OAuth, provider, or connector modules
  under `apps/web`.
- Use the existing pinned Bash/coreutils WebC artifacts; do not add npm
  `@wasmer/bash`.
- Keep native process spawn unsupported in the browser profile.
- Keep this PR focused on the smoke coverage and the concrete low-level
  `proc_exec` stdin fix exposed by that stage.

## Validation

- `node --check apps/web/e2e/bash-coreutils-smoke.js`
- `node --check apps/web/e2e/codex-version-smoke-runner.js`
- `npm --prefix apps/web run check`
- `npm --prefix apps/web run test:e2e`
