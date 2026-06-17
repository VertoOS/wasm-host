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
- The native runner can expose an opt-in HTTP bridge device for guest packages
  through `/dev/wasm-host-http`.
- The browser adapter package has deterministic direct Fetch and
  gateway-backed HTTP transport tests.
- The browser adapter package has an initial worker-side HTTP message runtime
  for pluggable direct/gateway dispatch.
- The browser adapter package has a worker entrypoint and local worker-boundary
  HTTP tests for direct Fetch, gateway, and cancellation behavior.
- The browser adapter package has an initial command lifecycle worker with
  load/run/cancel/stdin/terminal-resize messages, stdout/stderr chunk and close
  events, timeout shaping, HTTP transport selection, and a smoke executor for
  worker-boundary tests.
- The browser adapter package has a minimal terminal/stdio adapter that can
  attach to a command worker port, display stdout/stderr, send stdin, propagate
  resize/cancel messages, and resolve final exit status.
- The browser adapter package has a first interactive terminal UI shell that
  renders command output, accepts typed or pasted stdin, propagates resize,
  EOF, and cancellation controls, and runs the Codex version smoke through the
  real browser command worker.
- The browser terminal shell has package source controls for the built-in Codex
  smoke, uploaded package bytes, package URLs, manifest JSON, and manifest URLs;
  selected sources are normalized through the package loader or artifact
  manifest boundaries before the worker runs them. Uploaded and URL-backed Wasm
  bytes are routed through the raw WASI module executor for the current
  preview1 import surface.
- The browser adapter package has an initial package loader for explicit bytes
  and Fetch-backed WebC/Wasm artifacts, including magic-byte validation,
  optional sha256 pinning, command metadata normalization, and browser-safe
  cache path derivation.
- The browser adapter package has a first browser workspace store with
  canonical `/workspace` paths, in-memory operations, snapshot import/export,
  and IndexedDB-backed snapshot persistence when browser storage is available.
  The raw WASI executor can mount an injected store for writable `/workspace`
  fixture runs and flush mutations back as snapshots after the module exits.
- The browser adapter package can consume the interim Codex artifact manifest
  for the raw WASI `codex --version` smoke, normalize it into command load/run
  fixture messages, and verify fetched artifact bytes by size and sha256.
- The browser adapter package can load a `codex-browser`
  `wasm32-unknown-unknown` custom-export request-builder artifact, call its
  `codex_build_request` ABI, and emit deterministic Responses API request JSON
  through the command worker stdout path.
- The same `codex-browser` executor can run a mocked model turn by POSTing the
  generated request JSON through the selected browser HTTP transport and
  streaming local fixture response chunks to command stdout, including mocked
  Responses SSE `response.output_text.delta` events. It can inject a host-owned
  bearer secret from an opaque `CODEX_MODEL_BEARER_SECRET_REF` without putting
  the token in command args, ordinary env values, or stdout.
- The `codex-browser` executor can run a deterministic `workspace-edit`
  fixture that reads a browser workspace file, replaces expected text, writes
  the file back through the host-owned workspace store, and verifies persistence
  in the real-browser e2e harness.
- The browser command worker can load a deterministic `browser-tool-fixture`
  package, run a packaged command with cwd/env/stdin, read a host-owned browser
  workspace file, and verify that path through the terminal transcript and
  real-browser e2e harness. This is tool-execution contract coverage, not full
  Bash or git parity yet.
- The browser secret seam includes a deterministic fake device-flow auth broker
  for start/status/external-complete/cancel/logout tests. Completion stores the
  bearer token under a host-owned secret ref; public auth status does not expose
  raw token values.
- The browser adapter package can execute the interim raw WASI preview1
  `codex --version` smoke path with args/env, clocks, random bytes, preloaded
  stdin, cooperative yield, read-only package file reads and positioned reads,
  metadata, directory listing, optional injected workspace-store-backed
  `/workspace` reads and writes for fixture runs, volatile `/tmp` scratch
  directory create/rename/remove and file
  advise/allocate/write/positioned-write/renumber/rename/fd-and-path
  set-times/truncate/sync,
  deterministic unsupported results for link/symlink/readlink, poll, signal,
  and socket imports,
  stdio fd stat, descriptor rights reduction, stdout/stderr, and exit status
  capture for the narrow fixture import set.
- The browser adapter package has an automated command-worker-boundary smoke
  for the Codex `codex --version` contract, plus an optional local-artifact
  variant when `codex-wasix/dist` outputs are present.
- The browser adapter package has a real-browser e2e smoke that serves
  `apps/web`, launches a browser page, starts the module command worker, and
  asserts the Codex `codex --version` stdout/stderr/exit contract.
- C ABI and initial Python/Go binding smoke tests are implemented, including
  generated WebC success-path fixtures.
- Full browser WebC/WASIX runtime wiring, packaged runtime artifacts, and full
  language WebC e2e coverage are not implemented yet.

## Run A WebC Package

```sh
cargo run --bin wasm-host-runner -- \
  --webc /path/to/package.webc \
  --profile native-full \
  --module-cache-dir .cache/wasm-host/modules \
  --http-bridge native \
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

Use `--host-command /guest/path=/absolute/host/tool` with `--profile native-full`
to register an explicit native host-command bridge. This is for fast terminal
adapter testing of process behavior; it is not available in `browser-strict`.
The bridge streams stdout/stderr back through the same output path as package
processes and maps guest cwd to a host cwd when it falls under a configured
mount.

Use `--http-bridge native` to expose `/dev/wasm-host-http` to guest packages.
The device accepts a JSON request with `method`, `url`, optional `headers`,
optional base64 `body_base64`, optional `response_body_limit`, and optional
`timeout_ms`, then returns JSON with either a response status/headers/base64
body or a classified error. Streaming uploads use framed writes to the same
device: first `{"type":"request", ...}`, then zero or more
`{"type":"body_chunk","body_base64":"..."}` frames, then
`{"type":"body_end"}` before reading the JSON response.

Use `--http-bridge gateway=http://127.0.0.1:PORT/bridge` to route the same
guest HTTP bridge requests through a local gateway endpoint instead of direct
plain HTTP. Runner events record the bridge mode as `gateway` and intentionally
omit the gateway endpoint URL. Buffered bridge requests are sent as a JSON
envelope; streaming uploads and gateway responses can use chunked
newline-delimited JSON frames.

The runner validates the package before runtime setup. Missing or invalid WebC
inputs fail with exit code `65`; command-line usage errors fail with exit code
`2`; unresolved commands fail with exit code `127`; unsupported native-only
capabilities in `browser-strict` fail with exit code `126`; wall-time timeouts
fail with exit code `124`; cancelled runs fail with exit code `130`; guest
process exits preserve the guest return code.

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
  wasm-host-fixtures/  # generated WebC fixtures for tests and examples
  wasm-host-runner/    # native terminal runner
docs/
  codex-browser-runtime-contract.md # Codex-specific browser runtime contract
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

## Web Adapter Tests

The browser adapter package currently owns direct Fetch and gateway-backed
transport code, initial HTTP and command worker message runtimes, a package
loader/cache boundary, the interim Codex artifact manifest consumer, the narrow
raw WASI preview1 smoke executor, command-worker-boundary Codex version smoke,
command-worker-boundary Codex browser request-builder smoke, real-browser Codex
version and request-builder smoke, a terminal/stdio adapter, an interactive
terminal UI shell, package source controls, a browser workspace store, and
deterministic browser-networking/lifecycle/loading/workspace tests. Run them
with:

```sh
npm --prefix apps/web run check
npm --prefix apps/web test
npm --prefix apps/web run test:e2e
```

The e2e harness looks for Chromium or Chrome on `PATH`, or an explicit
`WASM_HOST_BROWSER` executable. It skips when no browser is available unless
`WASM_HOST_BROWSER_E2E_REQUIRED=1` is set.

## Binding Tests

Python and Go bindings wrap the shared C ABI. Run their smoke tests with:

```sh
tests/bindings/run.sh
```

The harness builds `wasm-host-c-api` and `wasm-host-fixtures`, generates a small
WebC package, points Python at the produced dynamic library, compiles and runs a
C header/link smoke test when `cc` is installed, validates Python package
metadata, and runs Go tests when Go is installed. The C, Python, and Go checks
all run the generated package through the shared C ABI.

## Planning

Planning and task tracking live in GitHub issues. Design/reference docs live in
the repo:

- [`docs/host-profile.md`](docs/host-profile.md)
- [`docs/codex-browser-runtime-contract.md`](docs/codex-browser-runtime-contract.md)
- [`docs/repo-layout.md`](docs/repo-layout.md)

## Attribution

The initial runtime code is adapted from
[`tanmay-bakshi/unix-wasm-sandbox`](https://github.com/tanmay-bakshi/unix-wasm-sandbox),
which is licensed under Apache-2.0.
