# wasm-host

`wasm-host` is a browser-compatible WebAssembly host runtime project.

The goal is to make WebC/Wasm command packages run with the same host contract
in two places:

- a native terminal runner for fast development and end-to-end testing
- a browser adapter with browser-safe filesystem, terminal, process, network,
  and permission behavior

This repo starts lean: Rust core runtime, native runner, vendor patches required
for the current Wasmer/WASIX backend, and the host profile docs. Language
bindings and package fixtures should split into separate repos once the host
contract stabilizes.

## Status

- Native runner can execute a local WebC package.
- The runner supports mounts, cwd, env, env pass-through, stdin files, output
  limits, and wall-time limits.
- The host profile and roadmap are documented.
- Browser adapter, conformance fixtures, C ABI, and language bindings are not
  implemented yet.

## Run A WebC Package

```sh
cargo run --bin wasm-host-runner -- \
  --webc /path/to/package.webc \
  --mount "$PWD:/workspace:rw" \
  --cwd /workspace \
  --env HOME=/workspace \
  --env-pass OPENAI_API_KEY \
  -- package-command --version
```

Use `--env-pass KEY` for secrets so values come from the host environment
without being embedded in the shell command.

## Project Shape

```text
crates/
  wasm-host-core/      # core host runtime and Wasmer/WASIX backend
  wasm-host-runner/    # native terminal runner
docs/
  host-profile.md      # browser-compatible host contract
  roadmap.md           # milestones and repo split
vendor/
  wasmer-*             # backend patches required by the current runtime
```

## Roadmap

Start with the native runner as the fast adapter, but keep it constrained by the
browser-compatible host profile. See:

- [`docs/host-profile.md`](docs/host-profile.md)
- [`docs/roadmap.md`](docs/roadmap.md)

## Attribution

The initial runtime code is adapted from
[`tanmay-bakshi/unix-wasm-sandbox`](https://github.com/tanmay-bakshi/unix-wasm-sandbox),
which is licensed under Apache-2.0.
