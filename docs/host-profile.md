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
| MCP/local services | Stdio/local process possible | WASM MCP server, HTTP/WebSocket MCP, or remote bridge | Model every server as a capability-backed transport. |

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
| Gateway | `http://` and `https://` if the gateway allows them | The gateway owns DNS, TLS, auth, CORS/proxy policy, and upstream transport behavior. |

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
