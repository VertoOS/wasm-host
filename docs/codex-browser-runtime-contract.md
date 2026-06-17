# Codex Browser Runtime Contract

This document defines the runtime contract needed to run useful Codex sessions
inside the `wasm-host` browser adapter. It is the Codex-specific layer on top of
the general browser-compatible host profile in
[`docs/host-profile.md`](host-profile.md).

## Goal

Run Codex from a browser surface without depending on native OS capabilities.
The browser host must provide explicit services for filesystem state, terminal
streams, network dispatch, credentials, tool execution, process lifecycle, and
plugin transports.

The current raw WASI `codex --version` smoke proves only that a narrow Codex
artifact can instantiate, read its arguments and environment, touch browser-safe
workspace files, write stdio, and exit through the command worker boundary. It
does not prove full Codex parity.

## Current Evidence

`wasm-host` currently has these browser-side building blocks:

- A command worker protocol for package load, run, stdin, resize, cancel,
  stdout, stderr, completion, and errors.
- Direct Fetch and gateway-backed HTTP worker transports with bounded response
  bodies, streaming upload support, timeout handling, and cancellation.
- A package loader boundary for explicit bytes, Fetch-backed artifacts, WebC or
  Wasm magic-byte validation, SHA-256 pinning, and browser-safe cache path
  derivation.
- A first WebC/WASIX executor boundary that routes loaded WebC packages to a
  dedicated browser runtime layer and returns a structured unimplemented error
  until real WebC/WASIX execution is wired.
- An interim Codex artifact manifest consumer for the raw `wasi-module`
  `codex --version` contract.
- A raw WASI Preview1 module executor that wires the tracked import surface used
  by the version smoke, including deterministic unsupported or no-op handlers
  for link, symlink, readlink, poll, signal, and socket imports.
- A first browser workspace store with canonical `/workspace` paths, in-memory
  file and directory operations, deterministic snapshot import/export, and
  IndexedDB-backed snapshot persistence when browser storage is available.
- Raw WASI fixture runs can mount an injected browser workspace store for
  writable `/workspace` operations, with synchronous in-run mutations flushed
  back to a snapshot after the module exits.
- The `codex-browser` executor has a deterministic `workspace-edit` fixture
  that reads a file from the host-owned browser workspace store, writes a simple
  edit back, and verifies persistence in the real-browser e2e harness.
- A deterministic `browser-tool-fixture` package type can run a packaged
  command with cwd, filtered env, stdin, and host-owned browser workspace reads
  through the terminal transcript adapter and real-browser e2e harness.
- Browser e2e coverage that runs the Codex version contract through a real page
  and module worker.

The current Codex repo at `/home/codex/github/codex` exposes a separate browser
bundle:

- `scripts/build_codex_browser_wasm.sh` builds package `codex-browser` for
  `wasm32-unknown-unknown` and copies `codex_browser.wasm`, `index.html`,
  `app.js`, and `styles.css` into a browser bundle directory.
- `codex-rs/browser/src/lib.rs` exports allocation helpers,
  `codex_build_request`, `codex_version`, and output-buffer accessors. It builds
  OpenAI Responses API JSON and identifies its runtime as
  `wasm32-unknown-unknown`.
- `codex-rs/browser/web/app.js` instantiates that Wasm bundle with no imports,
  can dry-run request JSON, can directly `fetch` a configured endpoint with an
  API key, and can optionally speak JSON-RPC to an app-server WebSocket.
- `codex-rs/browser/host/server.mjs` serves the browser bundle and bridges
  `/app-server` by spawning native `codex app-server`.

That Codex browser bundle is a request-builder and app-server protocol
prototype. It is not a full WebC/WASI/WASIX Codex package, and the demo
app-server path still depends on a native `codex` process.
`wasm-host` now carries a deterministic browser-owned app-server JSON-RPC
fixture for protocol tests; that fixture proves the browser host can own the
session protocol loop. A dependency-free loopback socket/client wraps the
fixture so browser tests can use text-frame request/response/notification
semantics without a native WebSocket bridge, but it is not a real network
server or the full native app-server engine. An injectable WebSocket-compatible
constructor exposes the loopback URL shape that browser UI code can mount, and
a small deterministic session controller layers the browser app-server
lifecycle over that loopback client for connect, account, login, thread, turn,
and interrupt tests.

## Target Shape

Codex browser support should be staged as two compatible artifacts:

| Artifact | Purpose | Host treatment | Tracking |
| --- | --- | --- | --- |
| `codex-browser` bundle | Browser-native request builder and app-server protocol prototype. | Load as an explicit browser bundle or component-like package, not as raw WASI. Validate exports and drive request-building or protocol smoke tests. | [#122](https://github.com/VertoOS/wasm-host/issues/122), [#117](https://github.com/VertoOS/wasm-host/issues/117), [#118](https://github.com/VertoOS/wasm-host/issues/118) |
| Full Codex runtime package | Runs the real Codex session engine with filesystem, auth, model traffic, tool execution, and plugin behavior delegated through host services. | Package as WebC/WASI/WASIX or another explicit component contract once Codex publishes the required artifact shape. Unsupported imports must produce deterministic capability errors. | [#109](https://github.com/VertoOS/wasm-host/issues/109), [#110](https://github.com/VertoOS/wasm-host/issues/110) |

The browser host owns all capabilities that a normal web page cannot safely
obtain by itself. The guest may request these capabilities, but it must not
assume native files, native process spawn, raw sockets, keychains, or local
services.

## Host And Guest Boundary

| Surface | Guest responsibility | Browser host responsibility | Tracking |
| --- | --- | --- | --- |
| Session state | Maintain Codex protocol state that is portable to Wasm. | Start, route, cancel, and persist browser sessions. | [#118](https://github.com/VertoOS/wasm-host/issues/118) |
| Credentials | Ask for auth or named secrets through a capability. Never embed secrets in argv or package manifests. | Own device login, token storage, secret redaction, and permission prompts. | [#111](https://github.com/VertoOS/wasm-host/issues/111) |
| Model traffic | Build logical model requests and consume streamed model events. | Dispatch through direct Fetch only when browser policy allows it; otherwise use a gateway. Enforce body limits, cancellation, and secret redaction. | [#112](https://github.com/VertoOS/wasm-host/issues/112), [#7](https://github.com/VertoOS/wasm-host/issues/7), [#14](https://github.com/VertoOS/wasm-host/issues/14) |
| Workspace | Read and write through the host filesystem contract. | Provide virtual workspace persistence, snapshots, import/export, and user-granted directory access where available. | [#113](https://github.com/VertoOS/wasm-host/issues/113), [#1](https://github.com/VertoOS/wasm-host/issues/1) |
| Tools and shell | Request packaged commands by name and stream their stdio. | Run sandboxed Bash, git, and tool packages. Do not expose arbitrary native process spawn in the browser profile. | [#114](https://github.com/VertoOS/wasm-host/issues/114), [#6](https://github.com/VertoOS/wasm-host/issues/6) |
| Terminal | Use stdin, stdout, stderr, resize, cancellation, and terminal mode contracts. | Provide a readline-grade terminal renderer and PTY-like behavior where browser-safe. | [#115](https://github.com/VertoOS/wasm-host/issues/115), [#6](https://github.com/VertoOS/wasm-host/issues/6) |
| Tool adapters, plugins, and MCP | Declare protocol-neutral tool specs, invocations, results, approvals, and workspace effects first. Treat MCP/plugin servers as adapters over that boundary, not primitive browser imports. | Provide browser-safe packaged command, WASM, HTTP, WebSocket, or gateway transports. Reject native stdio/local process launch with classified capability errors. | [#156](https://github.com/VertoOS/wasm-host/issues/156), [#116](https://github.com/VertoOS/wasm-host/issues/116) |
| Package imports | Declare required WASI/WASIX/component imports. | Instantiate supported imports and fail unsupported imports with classified capability errors. | [#110](https://github.com/VertoOS/wasm-host/issues/110), [#3](https://github.com/VertoOS/wasm-host/issues/3) |

## Capability Matrix

| Capability | Current state | Target contract | Issue |
| --- | --- | --- | --- |
| Version smoke | Raw WASI Preview1 `codex --version` runs through the browser worker and e2e page. | Keep this as the lowest conformance level and regression test. | [#37](https://github.com/VertoOS/wasm-host/issues/37) |
| Artifact shape | Interim raw WASI manifest exists for the version smoke; Codex also has a `wasm32-unknown-unknown` request-builder bundle. Loaded WebC packages now parse v2/v3 manifest metadata and expose package identity, commands, WASI hints, filesystem mappings, atom artifacts, and volume file spans before routing to the browser WebC/WASIX executor boundary, but that runtime still reports structured unimplemented errors. | Publish browser-runnable Codex artifact contracts, including the near-term request-builder bundle and the later full-runtime package with manifest metadata, exports/imports, commands, hashes, and capability declarations. | [#168](https://github.com/VertoOS/wasm-host/issues/168), [#166](https://github.com/VertoOS/wasm-host/issues/166), [#164](https://github.com/VertoOS/wasm-host/issues/164), [#122](https://github.com/VertoOS/wasm-host/issues/122), [#109](https://github.com/VertoOS/wasm-host/issues/109) |
| WASI/WASIX imports | Browser raw WASI runner wires the tracked Preview1 smoke imports. It is not a general WASIX runtime. | Inventory full Codex import requirements and implement or explicitly reject each unsupported import with stable errors. | [#110](https://github.com/VertoOS/wasm-host/issues/110), [#3](https://github.com/VertoOS/wasm-host/issues/3) |
| Auth and secrets | A minimal host-owned bearer secret seam can inject a token into mocked `codex-browser model-request` dispatch from an opaque `CODEX_MODEL_BEARER_SECRET_REF`. A deterministic fake device-flow broker can start, report status, be completed externally, cancel, and logout without exposing raw tokens. Real provider HTTP, refresh, persistence, storage policy, and browser UI are not wired yet. | Host-owned device login and secret provider with redaction, storage policy, cancellation, and no secret-bearing argv or logs. | [#111](https://github.com/VertoOS/wasm-host/issues/111) |
| Model HTTP | The `codex-browser model-request` path can send a mocked model request through the host HTTP bridge, pass through non-SSE fixture bodies, and decode mocked Responses SSE text deltas from bridge-delivered chunks. Real provider traffic, low-latency direct Fetch response streaming, and broader event/tool-call semantics are not integrated yet. | Route model traffic through host Fetch or gateway, with streaming events, cancellation, response limits, and secret-safe errors. | [#112](https://github.com/VertoOS/wasm-host/issues/112), [#7](https://github.com/VertoOS/wasm-host/issues/7) |
| Workspace | Raw version smoke has read-only package files and volatile `/tmp`. The browser workspace store supports in-memory operations, whole-snapshot IndexedDB persistence, injected raw WASI `/workspace` fixture mounts, and a deterministic `codex-browser workspace-edit` fixture, but it is not wired into the app-server path or full Codex edit turns yet. | Persistent browser workspace with clear mount semantics, snapshots, import/export, and file edit turn coverage. | [#113](https://github.com/VertoOS/wasm-host/issues/113), [#1](https://github.com/VertoOS/wasm-host/issues/1) |
| Shell, git, and tools | Native runner has explicit host-command bridges for development. The browser command worker can run a deterministic packaged tool fixture with cwd, filtered env, stdin/EOF, timeout, workspace reads, and terminal transcript capture, but not real Bash or git packages yet. | Codex tool calls run sandboxed packaged commands with stdio, cwd, env, timeout, and cancellation semantics. | [#114](https://github.com/VertoOS/wasm-host/issues/114), [#6](https://github.com/VertoOS/wasm-host/issues/6) |
| Terminal and PTY | Browser terminal shell supports typed/pasted stdin, EOF, resize, cancel, and text output. It is not readline-grade PTY behavior. | Terminal contract supports interactive Codex sessions, readline behavior, resize, cancellation, and clean stream close semantics. | [#115](https://github.com/VertoOS/wasm-host/issues/115), [#6](https://github.com/VertoOS/wasm-host/issues/6) |
| Tool adapters, plugins, and MCP | The browser adapter does not expose MCP as a first-class runtime module. `packages/browser-tool-protocol` now defines a protocol-neutral browser tool boundary for descriptors, namespaced calls, normalized results, output bounds, JSON serialization, and cancellation. Current runtime proofs remain the packaged tool fixture, terminal transcript plumbing, and app-server session protocol. | MCP/plugin servers run through explicit packaged command, WASM, HTTP, WebSocket, or gateway adapters with capability declarations. Native stdio/local process launch stays unsupported in browser hosts. | [#161](https://github.com/VertoOS/wasm-host/issues/161), [#156](https://github.com/VertoOS/wasm-host/issues/156), [#116](https://github.com/VertoOS/wasm-host/issues/116) |
| Browser app-server protocol | Codex browser demo speaks app-server JSON-RPC over WebSocket, but its server spawns native `codex app-server`. The browser adapter now has a deterministic browser-owned app-server fixture, loopback transport, WebSocket-compatible constructor, and session controller covering initialize, account read, device login cancel, thread reuse, mocked turn completion, turn interrupt, notification transcript, malformed frames, close behavior, and unsupported capability errors. | Browser-hosted app-server/session runtime that does not require a native child process. | [#118](https://github.com/VertoOS/wasm-host/issues/118) |
| End-to-end parity | Current e2e proves `codex --version`, request building, a mocked model turn, workspace edit persistence, a browser app-server protocol fixture, and a packaged tool fixture through the terminal transcript path. The page-level smoke result now reports these as named stages so partial browser support is visible in CI. | Add staged Codex browser e2e tests for auth, richer model turns, shell/git tool turns, terminal behavior, the browser tool adapter protocol, and later MCP/plugin adapters. | [#117](https://github.com/VertoOS/wasm-host/issues/117), [#3](https://github.com/VertoOS/wasm-host/issues/3) |

## Browser Tool Adapter Protocol

MCP and plugin support should be adapters over the browser tool protocol, not
the protocol itself. `packages/browser-tool-protocol` owns the shared helper
surface for the neutral concepts below:

| Concern | Browser contract |
| --- | --- |
| Session boundary | JSON-RPC request, response, and notification frames preserve request ids, initialize/initialized handshakes, connection capabilities, notification opt-outs, close behavior, and structured errors. |
| Turn lifecycle | Thread, turn, item, and call ids are carried through turn start, interruption, item start/completion, and turn completion so browser tools can be correlated with model output and session state. |
| Discovery | Tool descriptors include name, optional namespace, description, JSON input schema, optional output shape, exposure/deferred-loading metadata, and declared capabilities. |
| Invocation | Calls carry call id, turn id, namespace/tool name, JSON arguments, start/completion timestamps, and a stable cancellation path. |
| Results | Results are JSON-serializable, bounded, explicitly successful or failed, and returned as model-consumable content items plus optional structured error text. |
| Workspace effects | File reads, writes, and patches go through host-owned workspace mounts or app-server file-change events, never implicit native filesystem access. |
| Command-like tools | Stdio, cwd, env, EOF, resize, timeout, and transcript behavior use the packaged command and terminal protocols already exercised by the web tests. |
| Network access | HTTP requests use the host bridge with direct Fetch or gateway routing, streaming bodies where supported, bounded response sizes, timeout/cancellation, and classified browser policy errors. |
| Auth and approval | Secrets remain host-owned opaque references; approvals, permission requests, and elicitations are separate protocol events with user-visible decisions. |
| Transports | Browser-safe transports can be packaged commands, WASM components, workers, HTTP, WebSocket, or gateways. Native stdio server launch and arbitrary local process spawn are unsupported browser capabilities. |

`apps/web` must not grow first-class high-level integration modules for MCP,
plugins, OAuth, providers, or connectors. Those integrations should live in
separate packages or adapter layers over the neutral browser tool protocol.
The web package check enforces this with
`apps/web/scripts/check-architecture.js`; it blocks first-class high-level file
names and bare package imports. Additions to its allowlist should be limited to
narrow protocol fixtures with documented reasons.

## Milestone Ladder

| Level | Success criterion | Test shape | Issues |
| --- | --- | --- | --- |
| M0: version smoke | Browser page starts a worker, loads the raw WASI Codex version artifact, returns exit `0`, stdout prefix `codex-cli `, and empty stderr. | Existing worker-boundary and browser e2e tests. | [#37](https://github.com/VertoOS/wasm-host/issues/37) |
| M1: request-builder bundle | `wasm-host` can load the `codex-browser` bundle or manifest, validate its exports, call `codex_version`, and build deterministic Responses API JSON without network. | Browser worker or page test using the `wasm32-unknown-unknown` bundle contract. | [#122](https://github.com/VertoOS/wasm-host/issues/122), [#117](https://github.com/VertoOS/wasm-host/issues/117) |
| M2: full artifact admission | A full Codex package manifest can be fetched or uploaded, validated, and either loaded or rejected with a complete missing-capability report. | Package-loader test plus conformance case for classified unsupported capabilities. | [#109](https://github.com/VertoOS/wasm-host/issues/109), [#110](https://github.com/VertoOS/wasm-host/issues/110), [#3](https://github.com/VertoOS/wasm-host/issues/3) |
| M3: model turn without credentials | A Codex turn can send a mocked model request through the host HTTP/gateway bridge and consume plain-text or mocked Responses SSE text-delta output. | Local gateway fixture and browser worker test, no external network. | [#112](https://github.com/VertoOS/wasm-host/issues/112), [#117](https://github.com/VertoOS/wasm-host/issues/117) |
| M4: auth provider | Device login can start, complete or cancel, store a token through host-owned state, and avoid leaking secrets to argv, logs, manifests, or error messages. The current fake broker proves the state-machine seam; real provider calls, refresh, persistence, and UI remain. | Browser-safe auth provider test with fake device flow. | [#111](https://github.com/VertoOS/wasm-host/issues/111) |
| M5: file edit turn | Codex can read a workspace file, produce an edit, write it back, and persist or export the workspace. The current deterministic `codex-browser workspace-edit` fixture proves the host-store read/write/persist loop; model-authored edits and app-server sessions remain later. | Browser workspace fixture and e2e file edit scenario. | [#113](https://github.com/VertoOS/wasm-host/issues/113), [#117](https://github.com/VertoOS/wasm-host/issues/117) |
| M6: shell and git turn | Codex can run sandboxed shell/git/tool packages with cwd, env, stdio, timeout, and cancellation. The current deterministic packaged tool fixture proves cwd/env/stdin/EOF/workspace-read plumbing and terminal transcript capture while real Bash and git packages remain later. | Packaged tool fixture plus terminal transcript assertions. | [#114](https://github.com/VertoOS/wasm-host/issues/114), [#6](https://github.com/VertoOS/wasm-host/issues/6) |
| M7: interactive terminal | An interactive Codex task can use readline-grade input, resize, EOF, cancel, and stream close behavior in the browser UI. | Browser terminal e2e with deterministic interactive fixture. | [#115](https://github.com/VertoOS/wasm-host/issues/115), [#6](https://github.com/VertoOS/wasm-host/issues/6) |
| M8: browser tool adapter protocol | Codex can discover and call browser-safe tools through a protocol-neutral adapter boundary without native local process spawn. The shared package covers tool specs, calls, results, output bounds, JSON serialization, and cancellation; approval state and workspace effects still need deeper runtime wiring. | Fake tool adapter over packaged command, WASM, HTTP, WebSocket, or gateway fixture. | [#161](https://github.com/VertoOS/wasm-host/issues/161), [#156](https://github.com/VertoOS/wasm-host/issues/156), [#116](https://github.com/VertoOS/wasm-host/issues/116) |
| M9: browser-hosted app-server | The first deterministic browser app-server fixture runs the core JSON-RPC protocol subset in the browser host without spawning native `codex app-server`; the loopback transport/client exercises ordered text-frame request/response/notification semantics; the WebSocket-compatible constructor gives browser UI code an injectable app-server socket; and the session controller owns the connect/account/login/thread/turn lifecycle used by e2e. Full session state, real auth/provider traffic, persistence, and production UI replacement remain later. | Browser e2e using app-server JSON-RPC over the host runtime. | [#118](https://github.com/VertoOS/wasm-host/issues/118), [#117](https://github.com/VertoOS/wasm-host/issues/117) |

## Non-Goals For The Next PRs

- Do not add more syscall shims unless a milestone proves they are required by
  the full Codex artifact or a conformance fixture.
- Do not expose arbitrary native process spawn in the browser profile.
- Do not put API keys, device codes, bearer tokens, cookies, or secret-bearing
  URLs in argv, manifests, logs, worker messages, or test snapshots.
- Do not treat the current native app-server bridge as browser parity; it is a
  compatibility reference until [#118](https://github.com/VertoOS/wasm-host/issues/118)
  replaces the native child process dependency.
