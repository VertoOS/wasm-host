# Issue 225: Browser Bash Status And Stderr Smoke

## Links

- Issue: https://github.com/VertoOS/wasm-host/issues/225
- Branch: `bkamal/bash-status-stderr-smoke`

## Goal

Add focused browser Bash/coreutils coverage for packaged command non-zero status
and stderr redirection in the WebC/WASIX runtime.

## Scope

- Add a named Bash/coreutils smoke stage that observes a non-zero packaged
  command status from Bash.
- Redirect packaged command stderr into a workspace file and assert it does not
  leak to terminal stderr.
- Assert exact stdout, terminal stderr, exit code, and absence of unexpected
  fork/join/stack diagnostics.
- Document the stage in the browser runtime contract and Bash/coreutils audit.

## Constraints

- Do not add first-class MCP, plugin, OAuth, provider, or connector modules
  under `apps/web`.
- Use the existing pinned Bash/coreutils WebC artifacts; do not add npm
  `@wasmer/bash`.
- Keep native process spawn unsupported in the browser profile.
- Keep this PR focused on status/stderr behavior unless the stage exposes a
  concrete low-level runtime bug.

## Validation

- `node --check apps/web/src/wasi-module.js`
- `node --check apps/web/test/wasi-module.test.js`
- `node --check apps/web/e2e/bash-coreutils-smoke.js`
- `node --check apps/web/e2e/codex-version-smoke-runner.js`
- `node --test apps/web/test/wasi-module.test.js`
- `npm --prefix apps/web run check`
- `npm --prefix apps/web run test:e2e`

## Implementation Notes

- Use a failing packaged `cat` invocation as the status probe:
  `cat issue-225-status/missing.txt 2> issue-225-status/stderr.txt`.
- The probe exposed a runtime bug: completed child status was encoded at the
  wrong offset for Wasmer's WASIX `JoinStatus::ExitNormal` layout. The normal
  exit code is the `u16` union value at `status + 2`; Bash reads packaged child
  failures correctly only after that encoding is fixed.
