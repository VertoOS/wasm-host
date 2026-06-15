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
- The runner supports mounts, cwd, env, env pass-through, stdin files, live
  stdout/stderr streaming, output limits, and wall-time limits.
- The host profile and monorepo layout are documented.
- Core conformance covers the first HTTP bridge contract for adapter-owned
  request dispatch, clean errors, response limits, and cancellation.
- C ABI and initial Python/Go binding smoke tests are implemented.
- Browser adapter, packaged runtime artifacts, and full language WebC e2e
  coverage are not implemented yet.

## Run A WebC Package

```sh
cargo run --bin wasm-host-runner -- \
  --webc /path/to/package.webc \
  --profile native-full \
  --module-cache-dir .cache/wasm-host/modules \
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

The runner validates the package before runtime setup. Missing or invalid WebC
inputs fail with exit code `65`; command-line usage errors fail with exit code
`2`; unresolved commands fail with exit code `127`; wall-time timeouts fail with
exit code `124`; cancelled runs fail with exit code `130`; guest process exits
preserve the guest return code.

Guest stdout and stderr are streamed to the terminal as the process writes them.
The core API still captures both streams and returns them in `CompletedProcess`
so adapters can report byte counts or inspect output after the command exits.

Use `--module-cache-dir PATH` to pin where compiled module cache artifacts are
stored. Without it, the runtime uses `XDG_CACHE_HOME`, `HOME/.cache`, or a temp
directory fallback.

Use `--event-format json` to emit structured runner lifecycle events to stderr
as JSON lines. Event payloads include package, profile, command counts, output
byte counts, exit status, and failure stage; environment values are not emitted.

## Project Shape

```text
apps/
  web/                 # browser UI/runtime app
bindings/
  README.md            # binding distribution and split criteria
  c/                   # C ABI header and ownership contract
  go/                  # Go binding surface
  python/              # Python binding/package surface
crates/
  wasm-host-c-api/     # C ABI over the core host contract
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
  fixtures/            # fixture manifest and resolver checks
  runner/              # native runner CLI behavior checks
vendor/
  wasmer-*             # backend patches required by the current runtime
```

## Language E2E

Language e2e tests run code inside the host through `wasm-host-runner`.
When a language package is configured, the harness validates the guest JSON
payload for the expected marker, cwd, `/tmp` writes, runtime metadata, and
program args.

```sh
tests/e2e/languages/run.sh
```

The script resolves package metadata through
[`packages/fixtures/languages/manifest.json`](packages/fixtures/languages/manifest.json)
and skips languages whose WebC package is not configured. To require a language:

```sh
WASM_HOST_PYTHON_WEBC=/path/to/python.webc tests/e2e/languages/run.sh --require-python
WASM_HOST_GO_WEBC=/path/to/go-toolchain.webc tests/e2e/languages/run.sh --require-go
```

Artifacts can also come from URL-backed fixture inputs:

```sh
WASM_HOST_FIXTURE_CACHE_DIR=.cache/fixtures \
WASM_HOST_PYTHON_WEBC_URL=https://example.invalid/python.webc.gz \
WASM_HOST_PYTHON_WEBC_SHA256=<sha256-of-downloaded-file> \
tests/e2e/languages/run.sh --require-python
```

For Go, the default command comes from the fixture manifest:
`go run /workspace/go/smoke.go`. A prebuilt Go fixture package can override that
with `WASM_HOST_GO_COMMAND` and `WASM_HOST_GO_ARGS`.

## Binding Tests

Python and Go bindings wrap the shared C ABI. Run their smoke tests with:

```sh
tests/bindings/run.sh
```

The harness builds `wasm-host-c-api`, points Python at the produced dynamic
library, compiles and runs a C header/link smoke test when `cc` is installed,
validates Python package metadata, and runs Go tests when Go is installed.

## Planning

Planning and task tracking live in GitHub issues. Design/reference docs live in
the repo:

- [`docs/host-profile.md`](docs/host-profile.md)
- [`docs/repo-layout.md`](docs/repo-layout.md)

## Attribution

The initial runtime code is adapted from
[`tanmay-bakshi/unix-wasm-sandbox`](https://github.com/tanmay-bakshi/unix-wasm-sandbox),
which is licensed under Apache-2.0.
