# wasm-host

`wasm-host` is a browser-compatible WebAssembly host runtime project.

The goal is to make WebC/Wasm command packages run with the same host contract
in two places:

- a native terminal runner for fast development and end-to-end testing
- a browser adapter with browser-safe filesystem, terminal, process, network,
  and permission behavior

This is a fast-moving monorepo while the host contract is still changing. Keep
runtime code, browser adapter work, bindings, fixtures, and e2e tests together
until the boundaries are stable enough to split.

## Status

- Native runner can execute a local WebC package.
- The runner supports mounts, cwd, env, env pass-through, stdin files, output
  limits, and wall-time limits.
- The host profile and monorepo layout are documented.
- Core conformance covers the first HTTP bridge contract for adapter-owned
  request dispatch, clean errors, response limits, and cancellation.
- Browser adapter, conformance fixtures, C ABI, and language bindings are
  scaffolded but not implemented yet.

## Run A WebC Package

```sh
cargo run --bin wasm-host-runner -- \
  --webc /path/to/package.webc \
  --profile native-full \
  --mount "$PWD:/workspace:rw" \
  --cwd /workspace \
  --env HOME=/workspace \
  --env-pass OPENAI_API_KEY \
  -- package-command --version
```

Use `--env-pass KEY` for secrets so values come from the host environment
without being embedded in the shell command.

The runner defaults to `--profile browser-strict`, which rejects native host
mounts. Use `--profile native-full` for local development scenarios that mount
host directories.

## Project Shape

```text
apps/
  web/                 # browser UI/runtime app
bindings/
  go/                  # Go binding surface
  python/              # Python binding/package surface
crates/
  wasm-host-core/      # core host runtime and Wasmer/WASIX backend
  wasm-host-runner/    # native terminal runner
docs/
  host-profile.md      # browser-compatible host contract
  repo-layout.md       # monorepo layout and future split rules
packages/
  fixtures/            # source and packaged language/runtime fixtures
tests/
  conformance/         # host behavior tests shared by adapters
  e2e/                 # full runtime/language/application e2e tests
vendor/
  wasmer-*             # backend patches required by the current runtime
```

## Language E2E

Language e2e tests run code inside the host through `wasm-host-runner`.

```sh
tests/e2e/languages/run.sh
```

The script skips languages whose WebC package is not configured. To require a
language:

```sh
WASM_HOST_PYTHON_WEBC=/path/to/python.webc tests/e2e/languages/run.sh --require-python
WASM_HOST_GO_WEBC=/path/to/go-toolchain.webc tests/e2e/languages/run.sh --require-go
```

For Go, the default command is `go run /workspace/go/smoke.go`. A prebuilt Go
fixture package can override that with `WASM_HOST_GO_COMMAND` and
`WASM_HOST_GO_ARGS`.

## Planning

Planning and task tracking live in GitHub issues. Design/reference docs live in
the repo:

- [`docs/host-profile.md`](docs/host-profile.md)
- [`docs/repo-layout.md`](docs/repo-layout.md)

## Attribution

The initial runtime code is adapted from
[`tanmay-bakshi/unix-wasm-sandbox`](https://github.com/tanmay-bakshi/unix-wasm-sandbox),
which is licensed under Apache-2.0.
