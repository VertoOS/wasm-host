# Issue 209 Handoff: Browser WASIX Fork Lifecycle

## Status

Implemented the first browser raw-WASI process lifecycle subset for
[issue #209](https://github.com/VertoOS/wasm-host/issues/209).

This is intentionally narrow:

- supports asyncify-capable `proc_fork(copy_memory=false)` as a vfork-style
  double-return syscall
- gives the child pid `0` and the parent the allocated child pid
- tracks a minimal in-memory process table for root pid `1` and vfork children
- lets vfork children complete through `proc_exit2`
- lets vfork children complete through the existing `proc_exec`,
  `proc_exec2`, or `proc_exec3` child-command bridge
- resumes the parent after child completion
- lets `proc_join` reap completed children with `JoinStatus::ExitNormal`
- keeps copied-memory fork, process spawn, signal controls, and general
  blocking join unsupported with deterministic capability errors

## Implementation Notes

- `apps/web/src/wasi-module.js` now extends the existing asyncify continuation
  loop instead of adding a separate process runner.
- `WasiPreview1Runtime` owns the minimal process state:
  current pid, next pid, process records, active vfork record, and pending fork
  rewinds.
- `WasixRuntime.proc_fork` validates the pid pointer, handles pending fork
  rewind returns, supports only `copy_memory=false` with asyncify stack bounds,
  and returns `NOTSUP` for copied-memory fork or modules without the required
  continuation exports.
- `proc_exit2` remains normal WASI exit outside vfork. Inside vfork it records
  child exit status, unwinds the child branch, and rewinds the parent to the
  original fork site.
- `proc_exec*` remains replacement-style outside vfork. Inside vfork, the raw
  WASI runner catches the child exec request, runs the existing child-command
  bridge, records the child exit code, and re-enters the parent continuation.
- `proc_join` still returns `CHILD` for no-child `None`, returns `Nothing` for
  unknown explicit pids, reaps completed known children, and does not claim
  general blocking wait support for running children.

## Tests Added

`apps/web/test/wasi-module.test.js` now covers:

- asyncify vfork child `proc_exit2` and parent `proc_join`
- asyncify vfork child `proc_exec3` and parent resume in the direct executor
- the same `proc_exec3` parent resume through the command-worker raw WASI
  worker bridge
- explicit unsupported diagnostics for no-asyncify fork and copied-memory fork

## Validation

Ran:

```sh
node --test apps/web/test/wasi-module.test.js
WASM_HOST_BROWSER_E2E_REQUIRED=1 node apps/web/e2e/bash-coreutils-smoke.js
```

The Bash/coreutils smoke still remains blocked before `ls` completes. The raw
fixture vfork lifecycle works, but the real Bash package still reaches an
unsupported fork/restore path that needs process-level store/global rewind and
the fork mode Bash actually uses.

## Architecture Boundary

No high-level MCP, plugin, OAuth, provider, or connector runtime was added under
`apps/web`. Those concepts must continue to live in separate adapter packages
over protocol-neutral browser tool boundaries. Keep
`apps/web/scripts/check-architecture.js` in `npm run check` so new first-class
web modules or bare imports in those families are blocked.

## Recommended Next Slice

Keep process work grouped by runtime behavior, not one syscall per PR. The next
slice should inspect the current Bash blocker diagnostics after #209 and choose
between:

- copied-memory fork/store snapshot support if Bash uses `copy_memory=true`
- broader asyncify stack/store rewind if Bash reaches a missing snapshot path
- a focused join/wait subset only if Bash reaches a running-child wait after
  successful child completion

Do not introduce MCP/plugin/provider/OAuth/connector concepts as first-class
browser app modules while doing this lower-level WASIX work.
