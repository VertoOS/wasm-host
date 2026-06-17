# Issue 219: Browser Bash Workspace Script Smoke

## Links

- Issue: https://github.com/VertoOS/wasm-host/issues/219
- Follow-up: https://github.com/VertoOS/wasm-host/issues/220
- Branch: `bkamal/bash-workspace-script-smoke`

## Goal

Extend the browser Bash/coreutils WebC e2e smoke so it proves code written into
`/workspace` in one command run can be executed by Bash in a later command run.

## Scope

- Add a staged Bash/coreutils browser e2e workflow that writes a shell script
  under `/workspace`.
- Run that persisted script through a later `command.run` request with an argv
  argument.
- Assert deterministic stdout, empty stderr, exit code `0`, and no unexpected
  unsupported WASIX process diagnostics.
- Report the new stages in the page-level smoke result.

## Constraints

- Keep this at the low-level WebC/WASIX, packaged-command, and workspace
  boundary.
- Do not add first-class MCP, plugin, OAuth, provider, or connector modules
  under `apps/web`.
- Continue grouping related syscall/runtime changes by user-visible workflow
  rather than opening one PR per syscall.

## Current Context

The merged #215 smoke already proves:

- Bash and coreutils load from pinned WebC artifacts.
- `bash -lc 'pwd; ls /workspace; echo BASH_BROWSER_OK'` passes in Chromium.
- A single Bash command can create, redirect, read, list, and remove workspace
  files through packaged commands.

This issue should add the next browser-code-execution proof: script contents
persist in the browser workspace between commands, then Bash executes that
workspace script as code.

During validation, Bash command substitution such as `$(pwd)` expanded to an
empty string even though running `pwd` directly from the script produced
`/workspace`. That broader shell-capture behavior is tracked separately in
#220 so this PR can stay focused on persisted workspace script execution.

## Suggested Validation

- `node --check apps/web/e2e/bash-coreutils-smoke.js`
- `node --check apps/web/e2e/codex-version-smoke-runner.js`
- `npm --prefix apps/web run check`
- `npm --prefix apps/web run test:e2e`
