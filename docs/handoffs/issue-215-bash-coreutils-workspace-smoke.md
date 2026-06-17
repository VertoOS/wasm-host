# Issue 215 Bash/Coreutils Workspace Smoke

Date: 2026-06-17

Issue: https://github.com/VertoOS/wasm-host/issues/215

## Summary

The browser Bash/coreutils smoke now has two real-browser stages:

1. Path/package visibility:
   `bash -lc 'pwd; ls /workspace; echo BASH_BROWSER_OK'`
2. Workspace file workflow:
   `bash -lc 'set -eu; export LC_ALL=C; cd /workspace; rm -rf issue-215-smoke; mkdir issue-215-smoke; printf "alpha\nbeta\n" > issue-215-smoke/input.txt; cat issue-215-smoke/input.txt; ls issue-215-smoke; rm issue-215-smoke/input.txt; ls issue-215-smoke; rm -r issue-215-smoke; printf "ISSUE_215_WORKSPACE_OK\n"'`

The second stage proves that packaged Bash can drive packaged coreutils through
the browser host while mutating `/workspace` through shell redirects, `cat`,
`mkdir`, `ls`, `rm`, and `rm -r`.

## Runtime Shape

- WebC/WASIX command runs export the host-owned browser workspace as a
  deterministic snapshot before raw WASI execution.
- `proc_exec` child command requests include writable workspace snapshots, and
  child command results import mutated snapshots back into the parent runtime
  and command-worker store.
- Raw WASI worker execution receives cloneable workspace snapshots, not live
  IndexedDB-backed workspace store instances.
- Writable mounted-path resolution accepts `/workspace`, `/workspace/...`, and
  WASIX `%` spellings such as `/workspace%/...`.
- Package-root cwd fallback maps relative writes after `cd /workspace` into the
  workspace while preserving read fallback to WebC volume files.
- Workspace files can replace stdio descriptors for Bash redirection, while the
  previous scratch/native stdio fixture expectations stay bounded.
- Workspace snapshot import preserves fallback package files and marks imported
  workspace entries dirty.

## Verification

- `node --check apps/web/src/command-worker.js`
- `node --check apps/web/src/wasi-module.js`
- `node --check apps/web/e2e/bash-coreutils-smoke.js`
- `node --check apps/web/e2e/codex-version-smoke-runner.js`
- `node --check apps/web/test/wasi-module.test.js`
- `node --test apps/web/test/wasi-module.test.js`
- `node --test apps/web/test/command-worker.test.js`
- `npm --prefix apps/web run test:e2e`
- `npm --prefix apps/web run check`

## Architecture Boundary

No first-class MCP, plugin, OAuth, provider, or connector modules were added
under `apps/web`. Those integrations should remain adapter packages over the
protocol-neutral browser tool boundary. The web package check runs
`apps/web/scripts/check-architecture.js`, which blocks first-class high-level
file names and bare imports under `apps/web/src`, `apps/web/test`,
`apps/web/e2e`, and `apps/web/fixtures`.

## Follow-Ups

- Real git and broader shell semantics still need later packaged-command
  coverage.
- General spawn, signals, broad sockets, interactive TTY, full FD inheritance,
  full copied store/global semantics, and worker-thread behavior remain
  unsupported browser capabilities.
- Future MCP/plugin/provider support should live in separate adapter packages
  over lower-level host protocols, not as first-class `apps/web` runtime
  modules.
