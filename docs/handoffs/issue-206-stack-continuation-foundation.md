# Issue 206 Stack Continuation Handoff

Date: 2026-06-17

Issue: [#206](https://github.com/VertoOS/wasm-host/issues/206)

## Current State

The browser raw WASI runner now has a bounded single-instance WASIX stack
continuation loop. Modules that export the asyncify control functions plus
`__stack_low` and `__stack_high` can:

- call `stack_checkpoint`
- unwind to the browser host
- receive an in-memory `StackSnapshot`
- call `stack_restore(snapshot, value)`
- rewind so the checkpoint returns with `value`

Non-asyncify modules keep the earlier safe `stack_checkpoint` zero probe.
Unsupported or invalid `stack_restore` calls fail with stable runtime errors
and opt-in `thread-event:stack_restore` diagnostics.

## Sub-Agent Audit

Sub-agent `019ed512-e61b-7300-9eff-91c825c886b3` performed a read-only audit.
Summary:

- The previous browser `stack_checkpoint` only validated pointers, zeroed the
  24-byte snapshot and 8-byte return slot, and returned success.
- Native Wasmer implements checkpoint/restore with asyncify unwind/rewind,
  stack bytes, store/global snapshots, and a snapshot table keyed by hash.
- A truthful browser foundation should support only single-instance asyncify
  continuation first and must not imply fork, vfork, process, or thread support.
- Tests should cover success, missing snapshots, unsupported modules, and keep
  the Bash/coreutils blocker on real process-control work.

## This Slice

Implemented the first browser continuation substrate:

- detects asyncify exports and browser-readable stack bounds after instantiation
- wraps `_start` in a bounded continuation-aware run loop
- stores in-memory snapshots for one running raw WASI instance
- keeps `stack_checkpoint` as a zero probe for non-asyncify modules
- makes `stack_restore` non-returning: it rewinds when supported, otherwise
  throws a stable runtime error with diagnostics
- adds raw WASI fixtures for checkpoint/restore success, unsupported restore,
  and missing snapshot restore

This intentionally does not restore arbitrary Wasm store/global state and does
not implement process-level fork semantics.

## Next Slice

Continue [#204](https://github.com/VertoOS/wasm-host/issues/204) with a grouped
process-control PR:

- decide how browser fork/vfork will duplicate or isolate process state
- preserve parent and child return values for `proc_fork`
- connect child process exits to blocking and nonblocking `proc_join`
- decide whether additional store/global snapshot support is required before
  enabling Bash's real external-command path
- keep high-level MCP, plugin, provider, connector, and OAuth integrations out
  of `apps/web`
