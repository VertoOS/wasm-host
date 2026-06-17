# Bash And Coreutils WebC Import Audit

Date: 2026-06-17

Tracking issue: [#193](https://github.com/VertoOS/wasm-host/issues/193)

## Target

The first real browser shell smoke remains:

```sh
bash -lc 'pwd; ls /workspace; echo BASH_BROWSER_OK'
```

The audit used direct Wasmer registry/CDN artifacts. It did not use npm
`@wasmer/bash`.

## Primary Artifacts

| Package | Version | Source | WebC SHA-256 | Size | Commands | Atom | Atom SHA-256 |
| --- | --- | --- | --- | ---: | ---: | --- | --- |
| `wasmer/bash` | `1.0.25` | `https://cdn.wasmer.io/webcimages/059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1.webc` | `059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1` | 1,870,786 | 2 (`bash`, `sh`) | `bash`, span `{ offset: 1204, length: 1869444 }` | `5b37a9f95fca50f55024b7fc37b786fa80024e55320266cb19936729d24c70ce` |
| `wasmer/coreutils` | `1.0.25` | `https://cdn.wasmer.io/webcimages/36ea48f185ca15fe8454b1defb6a11754659dbed6330549662b62874d509f95f.webc` | `36ea48f185ca15fe8454b1defb6a11754659dbed6330549662b62874d509f95f` | 5,069,975 | 100, including `ls`, `pwd`, `echo`, `cat`, `mkdir`, `rm` | `coreutils`, span `{ offset: 10866, length: 5058971 }` | `41273f94662ce30f12daed7e23e6b10b100444c48f7a1778ed819789f7876771` |

Both registry records were resolved through the Wasmer GraphQL
`getPackageVersion` endpoint at `https://registry.wasmer.io/graphql`.

## Browser Smoke Status

The browser e2e at `apps/web/e2e/bash-coreutils-smoke.js` loads both pinned
WebC URLs above, verifies their SHA-256 values, and runs:

```sh
bash -lc 'pwd; ls /workspace; echo BASH_BROWSER_OK'
```

Current result:

- `bash` starts and prints `/workspace`.
- `stack_checkpoint` is now handled as a browser-safe checkpoint probe by
  zeroing the 24-byte `StackSnapshot` and 8-byte return slot.
- The target remains blocked before `ls` completes because external Bash
  commands still need browser-safe fork plus stack rewind behavior:
  `proc_fork` and `stack_restore`.
- The browser smoke is therefore marked blocked on
  [#204](https://github.com/VertoOS/wasm-host/issues/204), with diagnostics
  proving the remaining blocker set.

## Secondary Artifact Checked

The handoff also named `syrusakbary/coreutils@0.0.1` as a known-good
coreutils source. Its registry tarball is:

```text
https://cdn.wasmer.io/packages/_/coreutils/coreutils-0.0.1.tar.gz
sha256 01e0c6e30138b6eff782ed74623d8ba376c1984c6f76f498e5ebb8169b2191a2
```

The extracted `target/wasm32-wasi/release/uutils.wasm` is:

```text
sha256 1c8288c10a47e3c0ac09956572e2850b21e8a3125420dc49cb6fa644cf268d8d
```

That older artifact imports 21 legacy `wasi_unstable` functions instead of
WebC `wasi_snapshot_preview1`/`wasix_32v1` imports. It is useful as a future
legacy-namespace compatibility fixture, but the first Bash/coreutils browser
smoke should use the primary WebC pair above.

## Reproduction Notes

The audit extracted atoms with the existing browser parser in
`apps/web/src/webc-metadata.js`, then inspected the resulting Wasm modules with
`WebAssembly.Module.imports()` and `wasm-objdump -x`.

The imported memories were confirmed with `wasm-objdump`:

```text
wasmer/bash atom:
memory[0] pages: initial=133 max=65536 shared <- env.memory

wasmer/coreutils atom:
memory[0] pages: initial=37 max=65536 shared <- env.memory
```

## Import Status Summary

| Artifact | Total imports | Preview1 imports present in current runner | WASIX imports implemented by name | Import-object requirements resolved by #194 | Imported but unsupported capability names |
| --- | ---: | ---: | ---: | --- | ---: |
| `wasmer/bash@1.0.25` | 56 | 24 | 11 | `env.memory` | 20 |
| `wasmer/coreutils@1.0.25` | 135 | 46 | 13 | `env.memory`, `wasi.thread-spawn` | 74 |

The audit found two import-object requirements that were absent before
[#194](https://github.com/VertoOS/wasm-host/issues/194):

- `env.memory`: both atoms import shared memory. The raw browser runner now
  parses the Wasm import section, constructs the requested memory before
  instantiation, and attaches it to the WASI/WASIX handlers.
- `wasi.thread-spawn`: imported by `wasmer/coreutils@1.0.25` through a separate
  `wasi` module namespace, not `wasix_32v1.thread_spawn_v2`. The import now
  exists and returns deterministic negative `NOTSUP` until a browser
  worker-thread runtime is designed.

Everything else needed for instantiation is present by name. The remaining work
is implementation depth inside grouped browser capability buckets.

## Grouped Gaps

| Bucket | Bash imports | Coreutils imports | Follow-up |
| --- | --- | --- | --- |
| Import object and memory shape | `env.memory` | `env.memory`, `wasi.thread-spawn` | [#194](https://github.com/VertoOS/wasm-host/issues/194) |
| TTY defaults | `tty_get`, `tty_set` | `tty_get`, `tty_set` | [#195](https://github.com/VertoOS/wasm-host/issues/195) |
| Process/catalog | `proc_exec3`, `proc_exit2`, `proc_fork`, `proc_parent`, `proc_raise_interval`, `proc_signal` | `proc_exec2`, `proc_exec3`, `proc_exit2`, `proc_fork`, `proc_parent`, `proc_raise_interval`, `proc_signal`, `proc_snapshot`, `proc_spawn`, `proc_spawn2` | [#196](https://github.com/VertoOS/wasm-host/issues/196), [#204](https://github.com/VertoOS/wasm-host/issues/204) |
| Thread/event/async | `futex_wait`, `futex_wake`, `futex_wake_all`, `stack_restore`, `thread_exit`, `thread_id`, `thread_signal` | `epoll_create`, `epoll_ctl`, `epoll_wait`, `fd_event`, `futex_wait`, `futex_wake`, `futex_wake_all`, `stack_restore`, `thread_exit`, `thread_id`, `thread_join`, `thread_parallelism`, `thread_signal`, `thread_sleep`, `thread_spawn_v2` | [#197](https://github.com/VertoOS/wasm-host/issues/197), [#204](https://github.com/VertoOS/wasm-host/issues/204) |
| Networking/ports | `sock_connect`, `sock_open`, `sock_send_to` | `port_*`, `resolve`, `sock_*` WASIX networking set | [#197](https://github.com/VertoOS/wasm-host/issues/197) |
| Dynamic/closures/linking | `callback_signal` | `call_dynamic`, `callback_signal`, `closure_*`, `dl_invalid_handle`, `dlopen`, `dlsym`, `reflect_signature` | [#197](https://github.com/VertoOS/wasm-host/issues/197) |
| Clock mutation | none | `clock_time_set` | [#197](https://github.com/VertoOS/wasm-host/issues/197) |
| Browser smoke | target command reaches Bash, then blocks at external command process control | target command reaches Bash, then blocks at external command process control | [#198](https://github.com/VertoOS/wasm-host/issues/198), [#204](https://github.com/VertoOS/wasm-host/issues/204) |

## Current Interpretation

The syscall work should stay grouped by runtime behavior rather than one import
per PR. After [#194](https://github.com/VertoOS/wasm-host/issues/194) and
[#195](https://github.com/VertoOS/wasm-host/issues/195), the
[#196](https://github.com/VertoOS/wasm-host/issues/196) process/catalog slice
maps replacement-style exec variants onto the browser packaged-command catalog,
propagates `proc_exit2`, handles no-child `proc_join`, and keeps
spawn/fork/signal controls deterministically unsupported. The
[#197](https://github.com/VertoOS/wasm-host/issues/197) classification slice
adds opt-in grouped unsupported-call diagnostics for the first Bash/coreutils
smoke, exposes deterministic single-thread `thread_id`/`thread_parallelism`
and zero-duration `thread_sleep`, treats `callback_signal` as a diagnostic
no-op, includes inherited socket stubs in the network bucket, merges child
`proc_exec` diagnostics back into the parent result, and keeps futex/event,
dynamic linking, raw networking, clock mutation, nonzero sleep, and raw
fork/rewind behavior unsupported. The first Bash smoke can now use those
diagnostics to decide whether any remaining broad bucket needs implementation
instead of assuming every imported name is required.

The [#198](https://github.com/VertoOS/wasm-host/issues/198) smoke adds a
minimal `stack_checkpoint` implementation for the Bash entry path. This is not
full stack rewind support: `stack_restore` remains blocked on
[#204](https://github.com/VertoOS/wasm-host/issues/204) until the browser host
has truthful process-control semantics for Bash external commands.

The audit did not find any reason to add first-class MCP, plugin, provider,
connector, or OAuth modules under `apps/web`. Those remain adapter-package
concerns over lower-level browser host protocols.

The browser runtime now implements the audited `tty_get`/`tty_set` ABI for the
non-interactive profile. `tty_get` writes the 24-byte WASIX TTY state with
80x25 character dimensions, 800x600 pixel dimensions, stdio TTY flags cleared,
echo disabled, and line buffering disabled. `tty_set` accepts valid state
pointers as a no-op so Bash save/restore probes can proceed without claiming
readline-grade interactive terminal support.
