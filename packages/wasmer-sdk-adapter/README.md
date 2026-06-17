# Wasmer SDK Adapter

Private evaluation package for `@wasmer/sdk` as a browser WASIX backend.

This package owns the Wasmer-specific boundary. `apps/web` should keep depending
on wasm-host command/runtime contracts; it should not import `@wasmer/sdk`
directly.

## Adapter Shape

`createWasmerSdkCommandExecutor()` accepts an injected SDK loader and returns a
small executor with `run(request, output)`. The request shape mirrors the browser
command runtime fields that matter for the spike:

- package name/version or package bytes
- command, args, cwd, env, and stdin
- stdout/stderr output writers
- `/workspace` snapshot mount and writeback

The adapter normalizes SDK `wait()` output into `{ exitCode, stdoutBytes,
stderrBytes, workspaceSnapshot }`, leaving command catalog ownership,
workspace persistence, package pinning, hashing, cache policy, and integration
with the browser command worker outside this package.

## Current Finding

`@wasmer/sdk@0.10.0` exposes the primitives this project needs for an adapter:
`Wasmer.fromRegistry()`, `Wasmer.fromFile()`, `Wasmer.fromWasm()`,
`Command.run()`, `Directory`, `cwd`, `env`, `stdin`, mounted directories, and
`wait()` results with `code`, `stdout`, and `stderr`.

The SDK still has runtime requirements and open validation gaps before it should
replace or compete with `apps/web/src/webc-wasix.js`:

- Browser pages must be cross-origin isolated for `SharedArrayBuffer`:
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`.
- Registry-backed packages are the natural SDK path. `fromFile()` and
  `fromWasm()` provide byte-loading APIs, but pinned WebC artifact/cache
  integration still needs an end-to-end proof.
- A local Node probe against `@wasmer/sdk/node` could enumerate
  `wasmer/coreutils@1.0.25` commands, but `Command.run().wait()` did not settle
  for `true`, `false`, or `echo` within 5 seconds in this environment. Treat
  Node as API discovery only until that is understood.
- The real browser Bash/coreutils parity smoke remains a follow-up before any
  production wiring: https://github.com/VertoOS/wasm-host/issues/228

## Validation

```sh
npm --prefix packages/wasmer-sdk-adapter run check
npm --prefix packages/wasmer-sdk-adapter test
```
