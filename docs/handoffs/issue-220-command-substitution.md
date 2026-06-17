# Issue 220: Browser Bash Command Substitution

## Links

- Issue: https://github.com/VertoOS/wasm-host/issues/220
- Branch: `bkamal/wasix-command-substitution`

## Goal

Support Bash command substitution for browser-packaged child commands and
script builtins that write through captured stdout pipes.

## Scope

- Preserve WASIX pipe redirection when fd `1` or fd `2` is replaced before
  `proc_exec*`.
- Capture child command stdout/stderr when the parent fd targets a pipe or
  workspace file, then replay those bytes through the parent WASI fd.
- Add a browser Bash/coreutils e2e assertion for command substitution from a
  persisted workspace script.
- Keep the work inside the low-level WebC/WASIX, fd, pipe, and packaged-command
  runtime boundary.

## Constraints

- Do not add first-class MCP, plugin, OAuth, provider, or connector modules
  under `apps/web`.
- Keep native process spawn unsupported in the browser profile.
- Keep this PR focused on captured child stdout/stderr. Broader shell job
  control, process groups, and interactive PTY behavior remain later work.

## Validation

- `node --check apps/web/src/wasi-module.js`
- `node --check apps/web/e2e/bash-coreutils-smoke.js`
- `node --check apps/web/e2e/codex-version-smoke-runner.js`
- `node --test apps/web/test/wasi-module.test.js`
- `npm --prefix apps/web run check`
- `npm --prefix apps/web run test:e2e`
