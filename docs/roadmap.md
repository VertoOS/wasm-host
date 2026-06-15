# Wasm Host Roadmap

This roadmap turns the browser-compatible host profile into implementation
milestones. The native runner is the fast loop; browser parity is the forcing
function.

## Current Checkpoint

- The Rust crate still builds the original Python extension feature.
- A native `wasm-host-runner` can execute a local WebC package.
- The runner supports host mounts, cwd, env injection, env pass-through,
  stdin-file input, output limits, and wall-time limits.
- The runner can execute the current local CLI WebC package far enough for
  `--version`.
- The next blocker for full CLI e2e is the guest package's HTTP transport: it
  currently expects a browser-style `http://` gateway and rejects direct HTTPS.

## Milestone 1: Native Runner Foundation

Goal: make terminal execution the fast path for debugging WebC/WASIX packages.

Tasks:

- Rename or wrap the binary with the long-term runner name.
- Add a `browser-strict` profile to block native-only behavior in tests.
- Stream stdout/stderr instead of only returning captured output at process end.
- Add structured JSON output for runner events.
- Support package cache configuration.
- Add clean exit codes for package load, command resolution, timeout, and guest
  failures.
- Add tests for argument parsing and profile validation.

## Milestone 2: Host Contract

Goal: define the stable API every adapter must implement.

Tasks:

- Split the core host API from Python bindings and the runner binary.
- Define host capabilities: filesystem, stdio, terminal, process, network,
  clock, random, secrets, and persistence.
- Add explicit unsupported-capability errors.
- Add a permissions model for mounts, network, secrets, and host bridges.
- Define snapshot/import/export format for virtual workspaces.
- Define cancellation states: graceful stop, forced stop, timeout.

## Milestone 3: Conformance Suite

Goal: test host behavior independently from any one CLI.

Tasks:

- Add a conformance runner that can run the same scenario on native and browser
  adapters.
- Add fixture packages for filesystem, stdio, env, cwd, and exit-code tests.
- Add Bash tests for pipes, redirects, quoting, `read`, job-control-adjacent
  behavior, and readline expectations.
- Add Python tests for startup, imports, file IO, stdin, subprocess expectations,
  and package cache behavior.
- Add networking tests for success, streaming, invalid key/model, gateway
  unavailable, timeout, and malformed response cases.
- Add cancellation tests for long-running commands and active network requests.

## Milestone 4: Runtime Compatibility Work

Goal: fix missing or incorrect WASI/WASIX behavior with focused tests.

Tasks:

- Identify why Bash diverges between the current browser path and WebVM-style
  behavior.
- Implement or patch terminal/TTY behavior needed by Bash/readline.
- Verify process spawning and packaged command resolution.
- Verify filesystem behavior required by Git-like and language tools.
- Verify thread and SharedArrayBuffer requirements for browser runtime packages.
- Decide when to patch Wasmer/WASIX, shim in the host layer, or replace a
  browser adapter component.

## Milestone 5: Network Bridge

Goal: make API/network calls browser-compatible and terminal-testable.

Tasks:

- Replace ad hoc HTTP file bridges with a durable request/response transport.
- Support streaming responses with backpressure and cancellation.
- Normalize headers, status, body, and error propagation.
- Support browser Fetch/gateway and native runner bridge with the same wire
  semantics.
- Provide clear errors for CORS, gateway unavailable, auth failure, unsupported
  scheme, and timeout.
- Add tests that do not require real external credentials.

## Milestone 6: Full CLI E2E

Goal: run the full CLI package inside the host profile.

Tasks:

- Run non-interactive `exec` against a mounted workspace.
- Execute shell/tool calls inside the WASM sandbox.
- Confirm file edits persist to the virtual or mounted workspace.
- Confirm invalid key/model failures are clean.
- Confirm stop/cancel works during model and tool activity.
- Confirm interactive launch and exit behavior.
- Document unsupported native desktop features and their browser-safe
  replacements.

## Milestone 7: Browser Adapter

Goal: make the browser implementation use the same host contract.

Tasks:

- Run packages inside workers.
- Add OPFS/IndexedDB-backed workspace persistence.
- Add xterm.js-compatible terminal integration.
- Add Fetch/gateway networking.
- Add package and compiled-module cache strategy.
- Add browser conformance runner.
- Add browser e2e tests for the full CLI scenario.

## Milestone 8: Language Bindings

Goal: make the runtime usable from other ecosystems.

Tasks:

- Add a C ABI with opaque handles and stable ownership rules.
- Publish Go bindings from a separate Go module repo.
- Publish Python bindings from a separate Python package repo.
- Consider Node bindings after the browser adapter stabilizes.
- Keep language bindings thin over the host contract.

## Suggested Repo Split

Start with one implementation repo until the host contract stabilizes:

- `VertoOS/wasm-host`: core Rust host, native runner, browser adapter, tests.

Split distribution/import boundaries when needed:

- `VertoOS/wasm-host-spec`: host contract and behavior spec.
- `VertoOS/wasm-host-go`: Go module and cgo binding.
- `VertoOS/wasm-host-python`: Python package.
- `VertoOS/wasm-host-node`: Node package.
- `VertoOS/wasm-host-fixtures`: reusable WebC/Wasm test packages.

Keep WASIX as a supported compatibility profile:

- `wasm-host-wasi`: standards-track WASI behavior.
- `wasm-host-wasix`: WASIX/POSIX compatibility behavior.
- `wasm-host-webc`: WebC package loading behavior.
