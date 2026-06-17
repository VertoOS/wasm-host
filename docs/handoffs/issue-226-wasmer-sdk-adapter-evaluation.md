# Issue 226: Wasmer SDK Adapter Evaluation

## Links

- Issue: https://github.com/VertoOS/wasm-host/issues/226
- Follow-up browser parity proof: https://github.com/VertoOS/wasm-host/issues/228
- Branch: `bkamal/wasmer-sdk-adapter-eval`
- Wasmer JS SDK docs: https://docs.wasmer.io/sdk/wasmer-js/
- Wasmer JS SDK filesystem docs: https://docs.wasmer.io/sdk/wasmer-js/how-to/use-filesystem/
- Wasmer JS SDK COOP/COEP docs: https://docs.wasmer.io/sdk/wasmer-js/how-to/coop-coep-headers/

## Goal

Evaluate `@wasmer/sdk` as a browser WASIX backend behind a clean adapter
boundary, without making Wasmer, MCP, plugin, provider, OAuth, or connector
concepts first-class in `apps/web`.

## Scope

- Add an isolated package or equivalent non-first-class adapter boundary outside
  `apps/web`.
- Prove what can be mapped from the wasm-host command/runtime contract to the
  SDK: args, env, stdout, stderr, exit status, cwd, workspace mounts, and PATH.
- Document whether the SDK path depends on Wasmer registry packages or can also
  participate in the pinned artifact/cache flow.
- Document browser requirements, especially COOP/COEP and SharedArrayBuffer.
- Keep the existing hand-built WASI/WASIX runtime and browser e2e contract in
  place while the adapter is evaluated.

## Constraints

- Do not import `@wasmer/sdk` from `apps/web/src`, `apps/web/e2e`, or
  `apps/web/fixtures`.
- Do not add MCP/provider/plugin/OAuth/connector modules under `apps/web`.
- Do not replace `apps/web/src/wasi-module.js`, `webc-wasix.js`, or the command
  worker contract in this PR.
- Prefer a small, explicit adapter contract and a deterministic test over a
  broad integration.

## Validation Targets

- `npm --prefix packages/wasmer-sdk-adapter run check`
- `npm --prefix packages/wasmer-sdk-adapter test`
- `npm --prefix apps/web run check` to keep the architecture guard active.
- `git diff --check`.

## Implementation Notes

- `packages/wasmer-sdk-adapter` owns the SDK-specific executor boundary outside
  `apps/web`.
- The package uses an injected SDK loader in tests so `apps/web` never imports
  `@wasmer/sdk`.
- `@wasmer/sdk@0.10.0` exposes the adapter primitives we need:
  `Wasmer.fromRegistry()`, `Wasmer.fromFile()`, `Wasmer.fromWasm()`,
  `Command.run()`, `Directory`, `cwd`, `env`, `stdin`, mounted directories, and
  `wait()` output with `code`, `stdout`, and `stderr`.
- A local Node probe using `@wasmer/sdk/node` could enumerate
  `wasmer/coreutils@1.0.25` commands, but `Command.run().wait()` did not settle
  for `true`, `false`, or `echo` within 5 seconds in this environment. Treat
  the Node path as API discovery only.
- Real browser SDK-backed Bash/coreutils parity remains the follow-up before the
  adapter should be wired into the command worker; track that in
  https://github.com/VertoOS/wasm-host/issues/228.

## Open Questions

- Does `@wasmer/sdk@0.10.0` expose enough stable API to run the pinned
  `wasmer/bash` and `wasmer/coreutils` packages with exact stdout, stderr, and
  exit-code assertions?
- Can the adapter load pinned WebC bytes directly, or is registry loading the
  only practical SDK path?
- How should a wasm-host workspace snapshot map to `Directory` mounts and back?
