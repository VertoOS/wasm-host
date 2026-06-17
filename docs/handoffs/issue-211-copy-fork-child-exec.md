# Issue 211 Handoff: Browser WASIX Copied Fork Child Exec

## Status

Implemented the first copied-memory fork subset for
[issue #211](https://github.com/VertoOS/wasm-host/issues/211).

This slice is intentionally narrow:

- supports asyncify-capable `proc_fork(copy_memory=true)` when the browser host
  can run a copied child instance
- snapshots linear memory and exported mutable globals at the fork boundary
- instantiates a fresh child module with the copied memory snapshot
- rewinds the child branch first so `proc_fork` returns pid `0`
- lets the child finish through `proc_exit2` or the existing `proc_exec`,
  `proc_exec2`, or `proc_exec3` child-command bridge
- records the copied child exit code in the parent process table
- rewinds the parent with the allocated child pid
- lets `proc_join` reap the completed child with `JoinStatus::ExitNormal`
- adds a host-owned high-memory asyncify buffer fallback for modules that expose
  asyncify controls but not `__stack_low` / `__stack_high`

This is not full POSIX fork support. The browser runtime still does not clone
unexported Wasm store globals, live file descriptor state, pipes, scratch state,
threads, signals, process groups, or concurrent child execution.

## Implementation Notes

- `runRawWasiModule` now passes a copied-fork child runner into
  `WasiPreview1Runtime`.
- The copied child path reuses the existing raw WASI instantiation boundary, but
  accepts an optional memory snapshot before start.
- Imported-memory modules receive the copied snapshot before instantiation;
  exported-memory modules receive it after instantiation.
- Exported mutable globals are restored by probing `WebAssembly.Global`
  writability. Immutable or missing globals are skipped.
- The parent continuation loop serializes child execution before rewinding the
  parent. That keeps the first browser implementation deterministic and avoids
  claiming worker-backed process scheduling.
- The asyncify fallback buffer uses the high end of sufficiently large linear
  memories. Explicit `__stack_low` / `__stack_high` exports remain preferred.

## Tests Added

`apps/web/test/wasi-module.test.js` now covers:

- direct copied-memory fork child `proc_exec3` with parent memory isolation
- copied-memory fork through the command-worker raw WASI worker bridge
- asyncify fallback buffer support for modules without explicit stack bounds

The browser Bash/coreutils e2e was updated to reflect the new blocker:

- Bash starts in the real browser worker
- the script prints `/workspace`
- Bash cannot resolve `ls` and writes `bash: line 1: ls: command not found`
- Bash continues and prints `BASH_BROWSER_OK`
- the smoke is marked blocked on
  [#212](https://github.com/VertoOS/wasm-host/issues/212)

## Validation

Ran:

```sh
npm --prefix apps/web run check
npm --prefix apps/web test
WASM_HOST_BROWSER_E2E_REQUIRED=1 npm --prefix apps/web run test:e2e
git diff --check
cargo fmt --all --check
```

## Recommended Next Slice

Continue with
[#212](https://github.com/VertoOS/wasm-host/issues/212): expose loaded package
commands to Bash PATH lookup without adding high-level MCP, plugin, provider,
OAuth, or connector concepts as first-class `apps/web` modules.

The likely shape is still protocol-neutral package command visibility:

- make Bash see cataloged commands like `ls` through its filesystem or PATH
  probes
- preserve the existing command-worker catalog as the source of truth
- keep command execution routed through packaged-command child execution
- avoid native host process spawn and avoid embedding high-level tool adapter
  concepts in the raw WASI layer

## Architecture Boundary

No high-level MCP, plugin, OAuth, provider, or connector runtime was added under
`apps/web`. Those concepts remain separate adapter packages over lower-level
browser host protocols. Keep `apps/web/scripts/check-architecture.js` in
`npm run check` so new first-class web modules or bare imports in those
families are blocked.
