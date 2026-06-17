# Browser-Compatible Wasm Host Profile

This project should become a reusable host runtime for WebAssembly programs that
need Unix-like behavior. The native runner is the fast development adapter, but
the target behavior must stay close to what a browser adapter can provide.

The working platform name should be broad enough to cover WASI, WASIX, WebC,
Python, Bash, and other language runtimes. `wasm-host` is a better top-level
identity than a WASIX-only name. WASIX should be treated as one compatibility
profile because it is not the official WebAssembly standard.

## Goal

Run real WebAssembly command-line packages with a host contract that can be
implemented in both native and browser environments.

The host contract owns:

- package loading and command resolution
- virtual filesystems, mounts, and persistence
- stdin, stdout, stderr, terminal, and PTY-like streams
- environment, cwd, argv, time, randomness, and cancellation
- process and tool execution inside the sandbox
- HTTP/network bridges that respect browser security limits
- browser-safe replacements for features that cannot exist directly in browsers

The browser owns the WebAssembly engine and security model. The host layer must
adapt to those constraints instead of assuming native OS access.

## Architecture

```text
guest package: WebC/Wasm command, Bash, Python, CLI apps
        |
host contract: filesystem, stdio, process, network, terminal, permissions
        |
host adapters:
  native adapter  -> fast terminal runner for development and e2e tests
  browser adapter -> Web Workers, OPFS/IndexedDB, Fetch/gateway, xterm.js
        |
execution backend:
  native: Wasmer/WASIX
  browser: browser WebAssembly plus host imports
```

The native adapter should not become a separate product with stronger semantics.
Conformance tests should run in a browser-strict mode so native behavior does not
silently depend on capabilities the browser cannot match.

## Capability Mapping

| Capability | Native adapter | Browser adapter | Support strategy |
| --- | --- | --- | --- |
| WebC package loading | Local file and cache | Fetch, upload, registry cache | Same package metadata and command resolution. |
| Filesystem | In-memory FS plus host mounts | In-memory FS plus OPFS/IndexedDB/File System Access API | Use a virtual FS contract; host mounts are a native convenience, not required semantics. |
| Workspace writes | Writable host mount | Writable virtual workspace, optional user-granted directory | Persist through snapshot/export or browser storage. |
| stdin/stdout/stderr | Captured or streaming pipes | Message channels and terminal streams | Same chunking, close, and error semantics. |
| Terminal/PTY | Native terminal process wrapper where available | xterm.js-style terminal plus PTY emulation | Emulate enough TTY behavior for Bash/readline. |
| Processes | WASIX process execution in runtime; explicit native host-command bridges for testing | WASIX process model emulated by runtime and workers | No arbitrary host process spawn in browser. Spawn only packaged commands or approved bridges. |
| Shell/tool execution | Sandbox Bash/coreutils packages | Same packaged tools in the browser | Treat shell commands as sandbox commands, not host OS commands. |
| Signals/cancel | Runtime process termination | Cooperative cancellation and worker termination | Define graceful stop, hard stop, and exit-code behavior explicitly. |
| Networking | Native sockets or HTTP bridge | Fetch/WebSocket/gateway only | Prefer HTTP bridge semantics so browser and native match. Raw TCP/UDP requires a proxy. |
| DNS/TLS | Native stack or runtime stack | Browser Fetch/gateway | Browser security wins; TLS details may be abstracted behind the bridge. |
| Threads | Runtime support | SharedArrayBuffer and workers, subject to COOP/COEP | Feature-detect and expose clear unsupported errors. |
| File watching | Host notifications or polling | Virtual FS events and polling | Event stream belongs to the virtual FS contract. |
| Clipboard | Native clipboard | Browser clipboard API with user gesture constraints | Explicit capability with permission/error state. |
| Notifications | Native notification APIs | Browser Notification API | Optional capability; do not make core execution depend on it. |
| External editor | Native process launch | Not available directly | Replace with in-browser editor or host bridge. |
| Secrets/keychain | Env, keychain, or file | host-provided token/session storage | Never require secrets in argv; expose secret providers. |
| Tool adapters and local services | Stdio/local process possible | Packaged command, WASM, HTTP/WebSocket, or remote bridge | Model every tool adapter as a capability-backed transport; keep MCP as an adapter layer. |

## Unsupported Native Features

Some native behavior cannot be reproduced in a normal browser:

- unrestricted local filesystem access
- arbitrary local process execution
- kernel-level fork, exec, PTY, and signal behavior
- raw sockets and arbitrary TCP/UDP
- background daemons with native lifetime
- system keychain and editor launch without host integration
- bypassing CORS or browser permission rules

For each unsupported feature, the project should provide one of:

- a sandboxed WebAssembly equivalent
- a browser API backed adapter
- an HTTP/WebSocket/host bridge
- a clear unsupported error with a documented fallback

## Runtime Profiles

The host should expose explicit profiles instead of hiding differences.

`native-full`
: Native development mode. Allows host mounts and native conveniences for local
debugging.

`browser-strict`
: Native runner mode that only allows behavior the browser adapter can support.
This should be the default profile for conformance and CLI e2e tests.
Native-only capabilities requested in this profile must return a structured
`UnsupportedCapability` host error instead of a generic host failure.

`browser`
: Real browser adapter. Uses browser storage, workers, fetch/gateway networking,
and terminal emulation.

## Testing Strategy

Every new runtime capability should land with a conformance test that can run in
at least `browser-strict` mode. The same scenario should later run in the browser
adapter unchanged.

Required conformance groups:

- package loading and command discovery
- filesystem create/read/write/rename/delete/symlink behavior
- workspace mount and persistence behavior
- stdin/stdout/stderr streaming and backpressure
- Bash/readline/TTY behavior
- Python startup, imports, stdin, files, subprocess expectations
- process spawn, exit codes, cancellation, and timeouts
- HTTP request/response streaming and clean failures
- tool execution through packaged shell commands
- browser permission and unsupported-capability errors

The initial HTTP bridge contract is adapter-owned request dispatch with
normalized methods, URLs, headers, request/response body streams, body limits,
classified errors, and cancellation. Guest syscall or socket integration is a
later layer on top of that contract.

Small request bodies may still use the buffered body field. Streaming request
bodies must use the stream instead of also carrying a buffered body. The stream
is a bounded chunk stream from producer to adapter: each chunk is delivered in
order, end-of-body and producer failure are explicit stream events, and adapters
must not require unbounded buffering. Cancellation and wall-time expiry must be
observable both while a producer is generating body chunks and while an adapter
is waiting for them. Native adapters may map this stream to chunked transfer
encoding; browser adapters should map it to Fetch/gateway streaming when
available and otherwise fail with a classified bridge error.

Native terminal runs can expose the current bridge contract through
`/dev/wasm-host-http` with `wasm-host-runner --http-bridge native`. The device is
a simple JSON request/response surface for early guest-package tests; browser
adapters should implement the same logical contract over Fetch or a gateway
rather than depending on native sockets.

The device keeps the buffered request shape for small requests:
`method`, `url`, optional `headers`, optional base64 `body_base64`, optional
`response_body_limit`, and optional `timeout_ms`. Streaming uploads use framed
writes on the same open file. A guest writes one `{"type":"request", ...}` frame,
then zero or more `{"type":"body_chunk","body_base64":"..."}` frames, then an
explicit `{"type":"body_end"}` frame before reading the response. Hosts should
feed body chunks through the bounded request-body stream rather than collecting
an unbounded upload buffer.

Device requests may include `timeout_ms` to set a request-scoped wall-time
limit. Browser adapters should map this to per-request Fetch/gateway
aborts and return the same structured `timeout` error that the native bridge
returns, while still respecting any stricter outer sandbox timeout.

### HTTP Scheme And Gateway Policy

The logical HTTP bridge accepts normalized `http://` and `https://` request
URLs. Concrete adapters decide how those URLs are dispatched:

| Adapter | Supported request schemes | Policy |
| --- | --- | --- |
| Native `--http-bridge native` | `http://` only | Direct plain HTTP for deterministic local and terminal-runner tests. `https://` returns `unsupported_scheme` until a gateway or TLS adapter exists. |
| Browser Fetch | Browser-allowed `http://` and `https://` | Browser security policy wins. Mixed content, CORS, credential mode, and permission failures are reported as bridge errors rather than bypassed. |
| Gateway `--http-bridge gateway=<url>` | `http://` and `https://` if the gateway allows them | The terminal runner posts bridge requests to a configured local `http://` gateway endpoint. The gateway owns DNS, TLS, auth, CORS/proxy policy, and upstream transport behavior. |

Core exposes an adapter foundation for this policy. The native terminal runner
uses `GatewayHttpBridgeWorker`, which consumes the same `HttpBridgeRequest`
stream as the native worker and delegates dispatch to a `GatewayHttpTransport`.
Browser workers should use `run_async_http_bridge_worker` with an
`AsyncHttpBridgeTransport` instead of spawning a native thread. Both worker
paths receive normalized request metadata plus a bounded body reader, return
the same `HttpResponse`/`HttpBridgeError` contract, and map response chunks
through the same response-limit and cancellation path used by every other HTTP
bridge caller. Browser Fetch and browser gateway transports should implement
the async transport trait rather than defining a separate HTTP contract.
Buffered browser requests can enter the bridge with `HttpBridge::request_async`.
Streaming browser uploads should use `HttpBridge::request_streaming_async` and
consume body chunks with `GatewayHttpRequestBodyReader::read_chunk_async` or
`read_to_end_async`; the blocking body reader is reserved for native worker
paths.

The first browser Fetch transport lives in `apps/web/src/http.js`. It uses
browser `fetch` directly, defaults to `credentials: "same-origin"`, streams
upload bodies with `ReadableStream` when available, streams response body chunks
back through the bridge writer, and enforces the bridge response body limit
while reading. Browser `TypeError` fetch failures are classified as `cors`
because browsers intentionally collapse CORS, mixed-content, policy, and some
network failures into opaque Fetch errors.

The browser gateway transport also lives in `apps/web/src/http.js`. It posts the
same JSON or newline-delimited JSON gateway envelope to a configured endpoint,
defaults gateway endpoint credentials to `same-origin`, streams upload frames
with `ReadableStream`, streams gateway response frames back through the bridge
writer, and maps gateway endpoint status or wire errors into the bridge error
vocabulary. Browser adapters should prefer direct Fetch only when the target
URL is browser-reachable under normal browser security policy. Requests that
need server-side DNS/TLS behavior, private credentials, proxy policy,
non-browser origins, or centralized upstream auth should go through a gateway.
Generated gateway transport errors must not include configured gateway endpoint
URLs, request URLs, auth headers, cookies, bearer tokens, or secret-bearing
query strings.

The initial browser HTTP worker message runtime lives in
`apps/web/src/http-worker.js`. It accepts `http.dispatch` messages with
normalized request metadata, optional body chunks, timeouts, and response body
limits; it accepts `http.cancel` messages for in-flight requests; and it emits
`http.response.body`, `http.response.complete`, or `http.response.error` events.
Streaming uploads use `streamingBody: true` on the dispatch request and then
send ordered `http.request.body` chunk messages with either `chunk` bytes or
`chunkBase64`, followed by `http.request.body.end`. Producers can fail the
stream with `http.request.body.error` and a bridge-shaped `{kind, message}`
error. This is the worker-side message layer for pluggable direct/gateway
transports. `apps/web/src/http-worker-entry.js` starts that runtime in a
browser worker context. The local worker-boundary harness uses the same
entrypoint through a Node worker and local HTTP fixtures for direct Fetch,
gateway, streaming body, and cancellation coverage. This is not yet the full
WebC package startup or browser filesystem runtime.

The initial browser command lifecycle runtime lives in
`apps/web/src/command-worker.js`. It accepts `command.load` messages for
package metadata, `command.catalog` messages for the current browser command
catalog, `command.run` messages with package id, command, argv, env, cwd,
stdin, timeout, and HTTP transport selection, `command.cancel` messages for the
active run, `command.terminal.resize` messages for active terminal dimensions,
and `command.stdin` / `command.stdin.end` / `command.stdin.error` messages for
streamed input. It emits `command.loaded`, `command.catalog`,
`command.started`, `command.stdout`, `command.stderr`,
`command.stdout.close`, `command.stderr.close`, `command.complete`, and
`command.error` events.
Completion payloads mirror the native runner shape at the browser message
boundary: exit code, stdout/stderr byte counts, failure stage, cancellation
state, and timeout state. The worker maintains a protocol-neutral in-memory
catalog for loaded package commands, exposes `/bin` and `/usr/bin` command
paths, and resolves explicit `packageId: null` runs through browser PATH lookup
without making higher-level tool adapter concepts first-class. Executor
requests also receive a low-level child packaged-command helper that resolves
another loaded command through the same package/catalog rules, carries
cwd/env/args/stdin, can pipe or inherit stdout/stderr, and follows parent
timeout/cancel signals. This is not arbitrary native process spawn. The first
built-in `smoke` executor is only a lifecycle fixture for worker-boundary
tests. The deterministic `browser-tool-fixture` executor is the first packaged
tool-command fixture: it receives cwd, filtered env, stdin, timeout/cancel
signals, can invoke a cataloged child command, reads a host-owned browser
workspace file, and emits JSON through stdout plus a fixed stderr line. The
terminal transcript adapter now drives the same fixture with stdin writes, EOF,
stdout/stderr capture, stream close ordering, and exit status. It proves the
command-worker and terminal tool boundary only; real Bash, git, and arbitrary
tool packages remain separate browser adapter layers.

The first browser terminal/stdio adapter lives in `apps/web/src/terminal.js`.
It is dependency-free and intentionally shaped for a later xterm.js surface: a
session attaches to a worker-style command port, starts `command.run` with stdin
open by default, can include initial terminal dimensions, forwards stdin
chunks/end/errors, sends terminal resize and cancellation messages, writes
stdout/stderr chunks to a sink in order, closes both output streams explicitly,
and resolves or rejects with the final command status.

The first browser terminal UI shell lives in `apps/web/src/terminal-ui.js` and
is mounted by `apps/web/index.html`. It is a small dependency-free DOM surface
over that adapter: output is rendered as text, typed and pasted input is sent to
stdin, EOF and cancellation are explicit controls, and resize controls update
the command session dimensions. This shell proves the page-to-worker terminal
path for the interim Codex version smoke; readline-grade TTY behavior and a
future xterm.js renderer remain part of the Bash/terminal compatibility work.

The browser app wraps that terminal with package source controls in
`apps/web/src/package-source.js` and `apps/web/src/package-source-ui.js`.
Built-in Codex smoke and artifact manifest inputs are normalized through the
Codex manifest consumer and raw WASI module loader path. Uploaded package bytes
and package URLs are normalized through the browser package loader, then passed
to the command worker with explicit bytes, command metadata, and sanitized
source labels so the worker still owns package loading and cache derivation.
This is the browser app selection surface; full WebC/WASIX execution,
credentialed artifact fetching, and persistent package-source history remain
separate runtime and packaging concerns.

The initial browser package loading surface lives in
`apps/web/src/package-loader.js`. It accepts explicit package bytes or a
Fetch-backed URL, validates WebC (`\0webc`) and Wasm (`\0asm`) magic bytes,
parses WebC v2/v3 manifest metadata for package identity, commands, WASI
command hints, filesystem mappings, atoms, and volume file spans, hashes
content with SHA-256, verifies optional expected hashes, and derives
browser-safe cache paths under `wasm-host/v1/packages/sha256/` and
`wasm-host/v1/modules/sha256/`. The loader normalizes command names,
entrypoints, artifact kind, source metadata, content hash, and cache metadata
into a `command.load` package shape for the command lifecycle runtime while
caching extracted atom bytes as module artifacts. This is the package
input/cache boundary plus the first dispatch boundary:
`apps/web/src/webc-wasix.js` now receives loaded WebC commands, resolves WASI
command atom metadata, reads cached atom bytes, and delegates executable atoms
to the browser raw WASI Preview1 runtime with read-only package-root files from
extracted WebC volume spans. Unsupported runners and missing atom artifacts
still fail with structured errors. Compiled module cache persistence, package
WASIX process import semantics, and Bash/coreutils execution are later browser
runtime layers. Raw WASI worker execution uses an internal child-command RPC so
worker-side runtime code can request cataloged packaged commands without
structured-cloning JavaScript functions, but synchronous WASIX process import
handlers still need a later async-safe integration strategy.

The initial browser workspace store lives in `apps/web/src/workspace.js`. It
keeps host-visible paths canonical under `/workspace`, supports in-memory
file/directory operations, exports and imports deterministic snapshots, and
persists one whole-workspace snapshot per workspace id in IndexedDB when
available. Memory storage is the fallback. This is the first workspace state
boundary only: raw WASI fixture runs can mount an injected store by snapshotting
before `_start` and flushing mutations after exit, and the `codex-browser`
`workspace-edit` fixture and `browser-tool-fixture` executor can use the
host-owned store directly.
OPFS-backed large-file storage, user-granted directories, app-server
integration, and full Codex file-edit turn wiring remain later browser runtime
layers.

The interim Codex browser smoke manifest consumer lives in
`apps/web/src/artifact-manifest.js`. It validates
`codex-wasix/dist/artifact-manifest.json` for the raw `wasi-module`
`codex --version` fixture, rejects manifests that require network, workspace,
host-command, terminal, non-preview1 WASI, or non-WASI artifact support, and
normalizes accepted manifests into command lifecycle load/run fixture messages.
It can fetch artifact bytes through an injectable transport and verify the
declared size and SHA-256.

The interim raw WASI preview1 fixture runner lives in
`apps/web/src/wasi-module.js` and is wired into the command lifecycle worker as
package type `wasi-module`. It loads explicit raw Wasm bytes, verifies optional
SHA-256 pins, instantiates modules that export `_start` and memory, and
implements only the preview1 calls required by the current browser smoke and
package-file fixtures:
`args_sizes_get`, `args_get`, `clock_res_get`, `clock_time_get`,
`environ_sizes_get`, `environ_get`, `fd_allocate`, `fd_advise`, `fd_close`,
`fd_datasync`, `fd_filestat_get`, `fd_filestat_set_size`,
`fd_filestat_set_times`, `fd_pread`, `fd_prestat_dir_name`, `fd_prestat_get`,
`fd_pwrite`, `fd_read`, `fd_readdir`, `fd_renumber`, `fd_seek`, `fd_sync`,
`fd_tell`,
`fd_fdstat_get`, `fd_fdstat_set_flags`, `fd_fdstat_set_rights`, `fd_write`,
`path_create_directory`, `path_filestat_get`, `path_filestat_set_times`,
`path_link`, `path_open`, `path_readlink`, `path_rename`,
`path_remove_directory`, `path_symlink`, `path_unlink_file`, `poll_oneoff`,
`proc_exit`, `proc_raise`, `random_get`, `sched_yield`, `sock_accept`,
`sock_recv`, `sock_send`, and `sock_shutdown`.
This runner captures stdout, stderr, and exit status for the interim browser
smoke path, can expose explicit package files through a read-only `/workspace`
preopen, can optionally back `/workspace` with an injected browser workspace
store for fixture read/write/create/remove/rename operations, and provides a
volatile in-memory `/tmp` scratch preopen for narrow directory
create/list/rename/remove and file
advise/allocate/create/write/positioned-write/readback/positioned-read/stat,
rights-reduction/renumber/rename, fd/path set-times/truncate/sync/unlink
fixtures. `poll_oneoff` reports deterministic immediate clock and fd readiness
snapshots without blocking the browser worker. Eight shallow handlers remain:
link/symlink/readlink stay unsupported until the filesystem model has link
metadata, `proc_raise` is a deterministic signal no-op, and socket imports stay
unsupported native/browser capability boundaries. Live workspace stores stay on
the main-thread executor path; worker runs can carry cloneable workspace
snapshots but not IndexedDB-backed store instances. It is not a general WASIX
runtime and does not itself provide sockets, threads, or WebC metadata
execution.

The automated Codex browser smoke path runs this contract across
`apps/web/src/command-worker-entry.js`: tests build a normalized Codex
`command.load` / `command.run` fixture from a manifest, attach verified raw
WASI bytes, send both messages across a real worker boundary, and assert exit
`0`, stdout prefix `codex-cli `, and empty stderr. The e2e harness also serves
`apps/web` to a real Chromium/Chrome page, starts the command entrypoint as a
module worker from that page, and asserts the same version contract through the
browser runtime boundary. CI uses a deterministic inline version-smoke module
with the same browser contract; local runs also exercise
`codex-wasix/dist/codex-version-smoke.wasm` when that Codex artifact is
available.

The browser adapter also has a separate `codex-browser` request-builder path for
the Codex repo's `wasm32-unknown-unknown` browser artifact. This path validates
the custom exports, calls `codex_build_request(prompt, model)`, and emits
generated Responses API request JSON through command stdout. It can also run a
mocked model turn by posting that generated JSON through the browser HTTP bridge
and streaming local fixture response chunks to stdout, including mocked
Responses SSE text deltas. For authenticated model fixtures, the host can
inject a bearer token through an opaque
`CODEX_MODEL_BEARER_SECRET_REF` resolved by the browser secret provider at HTTP
dispatch time; the raw token is not guest argv, ordinary env, terminal output,
or package metadata. The same executor has a deterministic `workspace-edit`
fixture that reads a file from the host-owned browser workspace store, replaces
expected text, writes the file back, and verifies the persisted edit across the
real browser page/worker boundary. The browser profile also has a deterministic
fake device-flow auth broker for start/status, host-side completion,
cancellation, and logout tests. It is intentionally not modeled as raw WASI and
does not imply real provider credentials, refresh, full Codex CLI, real
app-server, full tool, or plugin/MCP adapter support.

The browser profile also has a deterministic app-server JSON-RPC fixture in
`apps/web/src/app-server.js`. It accepts browser-owned app-server messages for
initialize/initialized, `account/read`, device login start/cancel,
`thread/start`, `turn/start`, and `turn/interrupt`; emits bounded
`thread/started`, `turn/started`, `item/completed`, and `turn/completed`
notifications; honors notification opt-out; and returns structured unsupported
capability errors for native-only methods. The real-browser e2e harness drives
this fixture through a dependency-free loopback socket and JSON-RPC client, so
the test path uses ordered text frames, request correlation, notification
delivery, malformed-frame handling, and close behavior without a native
WebSocket bridge. A small browser session controller sits on top of that
transport to own initialize, account read, fake login cancellation, thread
reuse, mocked turn completion, pending turn interrupt, close state, and a
notification transcript for tests. The same loopback transport is also exposed
through an injectable WebSocket-compatible constructor for browser UI-facing
tests. It is not yet a real network WebSocket replacement for the Codex browser
demo, a persistent session store, or the full native app-server engine.

Browser tool integrations should use a protocol-neutral adapter boundary before
MCP or plugins become visible runtime layers. That boundary needs explicit tool
specs, namespaces, JSON-schema inputs, call ids, turn ids, structured results,
approval and cancellation semantics, bounded output, and declared workspace
effects. MCP stdio and local-process server launch remain unsupported browser
capabilities; future MCP/plugin support should translate browser-safe packaged
command, WASM, HTTP, WebSocket, or gateway transports onto the shared tool
protocol.

The browser profile also has a deterministic packaged tool fixture. The command
worker loads a `browser-tool-fixture` package, runs `tool-inspect` or the
`tool-child` child-command fixture, passes cwd, filtered env, stdin, timeout,
and cancellation through the normal run message, and lets the executor read a
host-owned `/workspace` file or invoke another loaded packaged command by PATH.
The fixture is covered by unit tests and the real-browser e2e harness after the
workspace-edit path. The e2e run now uses `createBrowserTerminalSession`,
writes stdin through the terminal adapter, sends EOF, and asserts transcript
stdout, stderr, stream close ordering, and exit status, so it proves a tool
command can observe persisted browser workspace state through terminal stdio.
Worker-backed raw WASI fixtures can also exercise the internal child-command
RPC to resolve cataloged packaged commands through the host-side command worker.
It is not Bash, git, native process spawning, or arbitrary uploaded JavaScript.

These smoke paths intentionally do not provide interactive terminal UI behavior,
hard termination of non-cooperative Wasm, or final WebC/WASIX package
execution. Those remain separate browser adapter layers so the successful
version and request-builder paths can stay small and deterministic.

The Codex-specific runtime contract is tracked in
[`codex-browser-runtime-contract.md`](codex-browser-runtime-contract.md). That
document separates the current raw WASI version smoke and Codex
`wasm32-unknown-unknown` request-builder bundle from the full browser-hosted
Codex runtime target.

The terminal gateway uses JSON over `POST` for buffered requests:

```json
{
  "schema": 1,
  "id": 1,
  "method": "GET",
  "url": "https://example.test/api",
  "headers": [{"name": "x-test", "value": "yes"}],
  "body_chunks_base64": []
}
```

Gateway responses use the same normalized response/error vocabulary as the
guest device:

```json
{"ok":true,"response":{"status":200,"headers":[],"body_chunks_base64":["T0s="]}}
```

```json
{"ok":false,"error":{"kind":"cors","message":"request blocked by gateway policy"}}
```

For streaming response bodies, the gateway may return
`Content-Type: application/x-ndjson` with chunked transfer encoding. The first
line is a response frame, followed by zero or more body chunks, then an
explicit end frame:

```json
{"type":"response","status":200,"headers":[]}
{"type":"body_chunk","body_base64":"c3RyZWFtLQ=="}
{"type":"body_chunk","body_base64":"b2s="}
{"type":"body_end"}
```

For streaming request bodies, the terminal gateway sends
`Content-Type: application/x-ndjson` with chunked transfer encoding. The first
line is a request frame, followed by zero or more body chunks, then an explicit
end frame:

```json
{"type":"request","schema":1,"id":1,"method":"POST","url":"https://example.test/upload","headers":[]}
{"type":"body_chunk","body_base64":"Z3Vlc3Qt"}
{"type":"body_chunk","body_base64":"dXBsb2Fk"}
{"type":"body_end"}
```

The buffered JSON envelope is acceptable for small, non-streaming requests.
Streaming request frames are required when the guest provides a streaming upload
or when an adapter cannot safely collect the full request body before dispatch.
Streaming response frames are required when the gateway cannot safely collect
the full upstream response body before replying.

Endpoint URLs are configuration, not telemetry. Runner events expose the bridge
mode as `gateway` but must not include the configured gateway URL.

Error mapping is part of the bridge contract:

| Failure | Bridge error kind |
| --- | --- |
| Unsupported URL scheme or adapter-disabled scheme | `unsupported_scheme` |
| Gateway process unavailable, closed dispatcher, or unreachable gateway endpoint | `gateway_unavailable` |
| Gateway credential/session failure, missing auth token, or rejected secret provider | `auth_failure` |
| Browser Fetch CORS denial, mixed-content block, or gateway origin-policy denial | `cors` |
| TLS/certificate/handshake failure before an HTTP response is available | `transport` |
| Request timeout or adapter abort caused by `timeout_ms` or the sandbox wall-time limit | `timeout` |

HTTP status codes such as `401`, `403`, and `5xx` remain successful bridge
responses unless the adapter itself cannot dispatch the request. Errors and
events must not include full URLs, auth headers, cookies, bearer tokens, or
secret-bearing query strings.

## Full CLI Target

The browser-capable CLI target should be a sandboxed CLI runtime, not a native
desktop clone. It should support:

- running the packaged CLI command
- reading and writing a virtual workspace
- executing shell/tool calls inside the WASM sandbox
- making model/API calls through the supported network bridge
- streaming output and structured events
- stopping/canceling cleanly
- preserving project state through browser-safe storage

Native-only behaviors must be replaced by explicit adapters rather than hidden
behind accidental host access.
