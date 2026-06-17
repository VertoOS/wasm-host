# Issue 204 WASIX Process-Control Handoff

Date: 2026-06-17

Issue: [#204](https://github.com/VertoOS/wasm-host/issues/204)

## Current State

The pinned Bash/coreutils browser smoke loads both WebC packages and reaches
Bash. The target command:

```sh
bash -lc 'pwd; ls /workspace; echo BASH_BROWSER_OK'
```

still blocks before `ls` completes. After the no-child `proc_join` slice, the
remaining unsupported diagnostics are expected to be:

- `process:proc_fork`
- `thread-event:stack_restore`

`proc_join` no longer appears in unsupported diagnostics for the Bash smoke
because the browser host can truthfully report the no-child state.

## Sub-Agent Audit

Sub-agent `019ed506-0d07-7d43-948f-0a7f09f65186` performed a read-only audit.
Summary:

- Existing `proc_exec`, `proc_exec2`, and `proc_exec3` hooks already delegate
  replacement-style execution to the browser child-command catalog.
- Native `proc_fork`, blocking `proc_join`, and `stack_restore` depend on
  stack/store rewind semantics.
- A fake fork would be observably wrong: Bash needs the same Wasm call frame to
  resume as both parent and child.
- Full Bash success needs a browser continuation/rewind foundation first.

## This Slice

Implemented a truthful single-process `proc_join` subset:

- validates `OptionPid` and `JoinStatus` pointers
- accepts `OptionTag::None` and `OptionTag::Some`
- clears both output structures
- returns `ERRNO_CHILD` for no-child `OptionTag::None`
- returns success with `JoinStatus::Nothing` for an explicit pid that has no
  known child process

This intentionally does not implement blocking joins or child lifecycle.

## Next Slice

After [#206](https://github.com/VertoOS/wasm-host/issues/206), continue with a
grouped process-control slice:

- keep `proc_fork` unsupported until parent and child can resume from the same
  call site with truthful process state
- decide how browser fork/vfork duplicates memory, globals, descriptors,
  workspace state, and child-command catalog access
- add fixtures for fork parent/child return values, child `proc_exec3`,
  blocking and nonblocking `proc_join`, cancellation, and stdout/stderr
  ordering
