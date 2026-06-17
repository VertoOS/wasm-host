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
- command, args, cwd, env, stdin, and SDK `uses`
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

The SDK still has runtime blockers before it should replace or compete with
`apps/web/src/webc-wasix.js`:

- Browser pages must be cross-origin isolated for `SharedArrayBuffer`:
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`.
- The real-browser proof confirms COOP/COEP and `SharedArrayBuffer` setup works,
  and the SDK module can load and initialize in Chromium. The optional CDN
  inline-Wasm module import currently fails with `ReferenceError: buf is not
  defined`, so the proof falls back to the SDK default initialization path.
- Registry-backed `wasmer/coreutils@1.0.25` command execution currently exits
  `45` with empty stdout/stderr for `echo SDK_COREUTILS_OK`.
- Pinned `wasmer/bash@1.0.25` WebC bytes can be fetched, verified by SHA-256,
  and passed to `Wasmer.fromFile()`, but `bash --version` also exits `45` with
  empty stdout/stderr, so the pinned WebC byte path is not runnable yet.
- A local Node probe against `@wasmer/sdk/node` could enumerate
  `wasmer/coreutils@1.0.25` commands, but `Command.run().wait()` did not settle
  for `true`, `false`, or `echo` within 5 seconds in this environment. Treat
  Node as API discovery only until that is understood.
- Follow-up: https://github.com/VertoOS/wasm-host/issues/230

## Validation

```sh
npm --prefix packages/wasmer-sdk-adapter run check
npm --prefix packages/wasmer-sdk-adapter test
npm --prefix packages/wasmer-sdk-adapter run test:e2e
```
