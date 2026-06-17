# Web Adapter

Browser UI and browser-host adapter work goes here while the runtime contract is
still changing.

Architecture boundary:

- `apps/web` owns low-level browser host protocols and deterministic fixtures:
  worker lifecycle, HTTP bridge, workspace, package loading, terminal stdio,
  raw WASI smoke execution, and narrow browser protocol fixtures.
- Do not add first-class MCP, plugin, OAuth, provider, or connector runtimes
  under `apps/web/src`, `apps/web/test`, `apps/web/e2e`, or
  `apps/web/fixtures`. Build those as separate packages or adapters over
  protocol-neutral browser tools.
- The current app-server files are explicit allowlist exceptions because they
  exercise a small browser-owned JSON-RPC protocol fixture. They are not the
  full native app-server engine, persistent session runtime, or provider-backed
  product integration.
- `npm run check` runs `scripts/check-architecture.js`; it blocks
  first-class high-level file names and bare package imports. Update its
  allowlist only for narrow protocol fixtures with a documented reason.

Current scope:

- `index.html`, `src/app.js`, and `src/app.css` provide the first browser app
  shell: an interactive terminal surface for local browser runtime development.
- `src/http.js` implements direct Fetch and gateway-backed HTTP transport
  surfaces for browser workers.
- `src/http-worker.js` implements a small worker-side message runtime that
  dispatches serialized HTTP bridge requests through pluggable transports.
  Buffered bodies can travel on `http.dispatch`; streaming uploads use
  `streamingBody: true` plus `http.request.body`, `http.request.body.end`, and
  `http.request.body.error` messages.
- `src/http-worker-entry.js` is the browser worker entrypoint for starting the
  HTTP bridge worker runtime.
- `src/command-worker.js` implements the first browser command lifecycle
  runtime. It handles `command.load`, `command.catalog`, `command.run`,
  `command.cancel`, stdin messages, terminal resize messages, stdout/stderr
  chunk and close events, timeout/cancellation result shaping, and pluggable
  HTTP bridge transport selection. It maintains a protocol-neutral in-memory
  command catalog for loaded packages and resolves explicit `packageId: null`
  runs through browser PATH lookup. Executor requests receive the current
  command catalog so low-level package runners can project loaded command paths
  into guest-visible virtual filesystems for shell PATH probes. Executor
  requests also receive a low-level child packaged-command helper for invoking
  another loaded command by catalog path without native process spawn. Its
  built-in `smoke` executor is a
  lifecycle fixture only; the built-in `browser-tool-fixture` executor proves
  packaged tool command dispatch and child command invocation with cwd/env/stdin,
  terminal transcript capture, and host-owned workspace reads; the `wasi-module`
  executor supports the interim raw WASI preview1 `codex --version` smoke; and
  the `webc-package`/`webc-wasix` executor boundary delegates WASI-runner WebC
  atoms to that raw Preview1 runtime. Raw WASI worker execution has an internal
  child-command RPC, and `wasix_32v1.proc_exec`/`proc_exec2`/`proc_exec3` can
  replace the current raw WASI module with a cataloged packaged command while
  preserving cwd/stdin/stdout/stderr and applying WASIX env/PATH overlays.
  `proc_exit2`, `proc_parent`, `proc_snapshot`, and no-child `proc_join`
  provide deterministic browser process results. Asyncify-capable modules can
  also use bounded browser process-continuation subsets: `proc_fork` with
  `copy_memory=false` acts as a vfork-style child-first branch, while
  `copy_memory=true` runs a serialized copied child instance from a copied
  linear-memory snapshot plus exported mutable globals. In both paths the child
  can finish through `proc_exit2` or the existing `proc_exec*` child-command
  bridge, the parent resumes with the child pid, and completed child exit codes
  can be reaped through `proc_join`. Modules that expose asyncify controls but
  not explicit stack bounds can use a host-owned high-memory asyncify buffer
  fallback when memory is large enough. It also supplies the WASIX TTY state ABI
  with
  deterministic non-interactive defaults, plus single-thread `thread_id`,
  `thread_parallelism`, and zero-duration `thread_sleep` behavior. Opt-in raw
  WASI diagnostics can report unsupported WASIX call counts by group/name,
  including `proc_exec` child runs, dynamic callback signals, and raw socket
  stubs. Common `wasix_32v1` raw socket/network imports are recognized as
  deterministic unsupported browser capability gaps. Single-instance asyncify
  modules with exported stack bounds or the host-owned fallback buffer can use
  WASIX `stack_checkpoint` and `stack_restore` as a browser continuation
  primitive. `proc_spawn`, signal/raise-interval, general blocking join,
  futex/eventfd/context, nonzero sleep, and raw socket/network semantics remain
  later process, worker-thread, or host-bridge runtime layers.
- `src/webc-wasix.js` owns the initial browser WebC/WASIX execution boundary.
  It validates command dispatch for WebC packages, maps WebC WASI-runner command
  metadata into raw WASI module requests, resolves cached atom bytes, mounts
  read-only package-root files from WebC volumes, and overlays generated command
  shims for loaded package-catalog paths so Bash-style PATH checks can see
  cataloged commands. Full WASIX process behavior, broad Bash/git semantics,
  and non-WASI runners remain later runtime layers.
- `src/codex-browser.js` implements the narrow custom-export executor for the
  Codex repo's `codex-browser` `wasm32-unknown-unknown` request-builder
  artifact. It validates the expected exports, calls `codex_version` and
  `codex_build_request`, writes generated Responses API request JSON to the
  command stdout stream, and can run a mocked `model-request` by POSTing that
  JSON through the selected HTTP bridge transport. Plain text responses pass
  through to stdout, while mocked Responses SSE `response.output_text.delta`
  events stream assistant text only. A host-owned secret provider can inject a
  bearer token from the opaque `CODEX_MODEL_BEARER_SECRET_REF` at HTTP dispatch
  time. The same executor has a deterministic `workspace-edit` fixture that
  reads a file from the host-owned browser workspace store, replaces expected
  text, writes the file back, and reports the edit result through stdout. This
  is not full CLI, real device-flow auth, real app-server, full tool
  execution, or plugin/MCP adapter execution.
- `src/app-server.js` implements a deterministic browser-owned JSON-RPC
  app-server fixture. It supports initialize/initialized, account read, device
  login start/cancel, thread start, mocked turn start/completion, turn
  interrupt, notification opt-out, bounded turn notifications, and structured
  browser capability errors for unsupported methods. It is a protocol fixture
  for browser runtime tests, not the full native app-server session engine.
- `src/app-server-transport.js` wraps that fixture in a dependency-free
  loopback socket and JSON-RPC client. It preserves text-frame ordering,
  response correlation, notification delivery, malformed-frame errors, and
  close semantics so browser tests can follow the Codex browser demo's
  app-server message shape without a native WebSocket bridge.
- `src/app-server-websocket.js` exposes that loopback transport as an
  injectable WebSocket-compatible constructor/factory for browser UI code. It
  accepts the browser-owned loopback URL shape, validates protocols, isolates
  runtime state per constructed socket by default, and is not a real network
  WebSocket server.
- `src/app-server-session.js` layers a small deterministic session controller
  over the loopback client. It owns connect/initialize, account read, fake
  device login cancellation, thread reuse, mocked prompt turns, pending turn
  interrupt, close state, and a notification transcript for browser tests. It
  is not persistent session storage or real provider-backed app-server logic.
- `src/secrets.js` owns the current browser secret-provider seam: tests can
  supply host-owned bearer tokens by reference, while command messages and
  terminal output continue to carry only opaque secret references. It also
  includes a deterministic fake device-flow auth broker for start/status,
  host-side completion, cancellation, and logout tests. It is not a real
  provider login, refresh, persistence, or browser credential UI.
- `src/workspace.js` owns the first browser workspace store. It keeps
  canonical `/workspace` paths, supports in-memory file/directory operations,
  exports and imports deterministic snapshots, and persists one snapshot per
  workspace id in IndexedDB when available. Memory storage remains the fallback
  and test-injectable store. Whole-snapshot IndexedDB writes are intentionally
  last-write-wins across store instances; OPFS, large-file storage, user
  directory grants, app-server wiring, and full Codex file-edit turns remain
  later runtime layers. The raw WASI fixture executor can consume an injected
  store as a writable `/workspace` mount by snapshotting before `_start` and
  flushing the mutated snapshot after exit, and the `codex-browser`
  `workspace-edit` fixture can read/write the host-owned store directly. The
  `browser-tool-fixture` executor can inspect the same store directly.
- `src/terminal.js` implements a dependency-free terminal/stdio session adapter
  that attaches to a worker-style command port, starts a command with open
  stdin by default, writes stdout/stderr to a sink, closes output streams
  explicitly, sends stdin chunks/end/errors, propagates terminal resize and
  cancellation messages, and resolves/rejects with the final status.
- `src/terminal-ui.js` implements the dependency-free terminal shell controller
  and DOM renderer. It renders stdout/stderr as text, accepts keyboard input and
  paste for stdin, exposes run/cancel/EOF/clear/resize controls, starts commands
  with the current terminal dimensions, and keeps the surface replaceable by a
  future xterm.js-backed renderer without changing the worker/session contract.
- `src/package-source.js` normalizes terminal package selections. Built-in
  Codex smoke and manifest inputs go through the Codex artifact manifest
  consumer; package file and URL inputs go through `BrowserPackageLoader` before
  the resulting bytes and command metadata are handed to the worker.
- `src/package-source-ui.js` renders the package source controls around the
  terminal shell. It supports built-in, file, URL, manifest JSON, and manifest
  URL sources, shows selected package metadata, and reports validation errors
  without echoing secret-bearing URL query strings or credentials.
- `src/codex-terminal-shell.js` wires that shell to the deterministic interim
  Codex `codex --version` raw WASI fixture for the default browser app and
  browser e2e coverage.
- `src/command-worker-entry.js` is the browser worker entrypoint for starting
  the command lifecycle runtime. The worker-boundary tests run the normalized
  Codex version-smoke fixture through this entrypoint, and the browser e2e
  smoke starts this entrypoint from a real module worker.
- `src/package-loader.js` implements the first browser package loading surface
  for explicit bytes and Fetch-backed artifacts. It validates WebC/Wasm magic
  bytes, parses WebC v2/v3 manifest metadata for package identity, commands,
  WASI command hints, filesystem mappings, atoms, and volume file spans,
  verifies optional sha256 pins, normalizes command metadata for `command.load`,
  derives IndexedDB-safe package/module cache paths from content hashes, and
  persists package summaries, package bytes, and extracted atom bytes in
  IndexedDB when available. Wasm package sources are mapped onto the raw WASI
  module executor; WebC WASI-runner commands can resolve cached atom bytes and
  delegate executable atoms through that same Preview1 runtime with read-only
  package-root files from extracted WebC volume spans. Memory cache remains the
  fallback and test-injectable cache. Package catalog and PATH lookup live in
  the command worker over loaded package records; the loader still does not
  implement WASIX process spawning, manage cache eviction, or wire workspace
  persistence into full package execution yet.
- `src/artifact-manifest.js` consumes the interim Codex artifact manifest
  shapes. It validates the raw `wasi-module` `codex --version` contract and
  the `codex-browser` request-builder contract, normalizes them into command
  load/run fixture messages, and can fetch artifact bytes through an injectable
  transport while verifying size and sha256.
- `src/wasi-module.js` implements the narrow raw WASI preview1 fixture runner
  for modules that import args/env, realtime and monotonic clocks, cooperative
  `sched_yield`, Web Crypto random bytes, preloaded fd 0 stdin through
  `fd_read`, stdio descriptor metadata through `fd_fdstat_get` and
  `fd_fdstat_set_flags`, descriptor rights reduction through
  `fd_fdstat_set_rights`, a read-only `/workspace` package-file preopen through
  `fd_prestat_get`, `fd_prestat_dir_name`, `path_open`, `path_filestat_get`,
  `path_filestat_set_times`, `fd_readdir`, `fd_filestat_get`, `fd_close`,
  `fd_renumber`, and file-backed `fd_read`, `fd_pread`, `fd_pwrite`,
  `fd_seek`, `fd_tell`, and `fd_advise`,
  an optional injected browser workspace-store-backed `/workspace` mount for
  fixture reads, writes, create/remove, rename, directory listing, truncate,
  allocation, and snapshot flush after module exit,
  plus a volatile in-memory `/tmp` scratch preopen for create,
  `path_create_directory`, write, positioned write, readback, positioned read,
  stat, `fd_allocate`, `fd_advise`, `fd_filestat_set_times`,
  truncate/sync, directory listing, `path_rename`, and `path_remove_directory` /
  `path_unlink_file`. `poll_oneoff` reports deterministic immediate
  clock/stdin/stdout/file readiness snapshots without blocking the worker.
  Worker-backed raw WASI runs can use an internal child-command RPC to ask the
  host-side command worker to resolve and run cataloged packaged commands.
  Supported Preview1 imports are also mirrored through `wasix_32v1` for
  WASIX/WebC modules whose 32-bit import ABI matches the current browser
  handlers. Modules that import `env.memory` are supported by parsing the Wasm
  import section, constructing the requested memory before instantiation, and
  attaching that memory to the WASI/WASIX handlers; modules that export memory
  continue to use the exported-memory path.
  The separate `wasi.thread-spawn` namespace is also present so
  pthread-shaped WebC atoms instantiate, but it returns deterministic negative
  `NOTSUP` until a browser worker-thread runtime exists.
  `wasix_32v1.proc_exec`/`proc_exec2`/`proc_exec3` map to that child-command
  bridge with cwd/env/stdin, PATH-aware catalog lookup, and inherited
  stdout/stderr. `proc_exit2` maps to normal WASI exit status propagation, while
  `proc_parent` and `proc_snapshot` expose deterministic browser process state.
  No-child `proc_join` returns the WASIX no-child status, and completed forked
  children can be reaped with `JoinStatus::ExitNormal`. Asyncify-capable raw
  WASI modules can use a bounded `proc_fork(copy_memory=false)` vfork path that
  resumes the child first, then resumes the parent after child `proc_exit2` or
  `proc_exec*`. They can also use a serialized
  `proc_fork(copy_memory=true)` child-exec subset: the browser host snapshots
  linear memory and exported mutable globals, instantiates a copied child, runs
  that child to `proc_exit2` or `proc_exec*`, marks the child complete, and then
  rewinds the parent with the child pid. This is not a full
  store/global/FD/thread process clone. Process spawn, signal, raise-interval,
  and general blocking join imports return deterministic unsupported capability
  errors until the runtime has a fuller process snapshot strategy.
  `wasix_32v1.getcwd`/`chdir` are backed by the browser virtual cwd across
  `/workspace`, `/tmp`, and read-only package-root paths. The package-root `/`
  preopen resolves absolute guest paths like `/bin/ls` against package-root
  files and exposes virtual `/workspace` and `/tmp` directories for package
  tools reached through that root. `path_open2`,
  `fd_fdflags_get`/`fd_fdflags_set`, `fd_dup`, `fd_dup2`, `fd_pipe`, `pipe`,
  `getpid`, empty signal-disposition queries, and non-interactive
  `tty_get`/`tty_set` state are also wired for low-level compatibility. Clock
  mutation, dynamic linking, and advanced process variants remain explicit
  deterministic unsupported capability gaps.
  WASIX `thread_id`, `thread_parallelism`, and zero-duration `thread_sleep`
  expose deterministic single-thread browser state. `stack_checkpoint` keeps
  the browser-safe zero probe for non-asyncify modules, and asyncify-capable
  modules with `__stack_low`/`__stack_high` exports or a large enough memory for
  the host-owned fallback buffer can checkpoint and restore within one running
  instance. Missing snapshots or modules without the needed continuation
  exports fail with stable runtime errors and diagnostics. Futex,
  eventfd, epoll, context-switching, thread spawn/join/signal, and nonzero
  sleep imports instantiate with deterministic unsupported capability errors
  until the browser profile has a real worker-thread strategy.
  `callback_signal` is a diagnostic no-op for the current single-thread
  profile. Runs that set `diagnostics.unsupportedWasixCalls` receive grouped
  unsupported-call counts in the command result, with child `proc_exec`
  diagnostics merged back into the parent.
  Common `wasix_32v1` raw socket/network imports, including inherited
  Preview1-style `sock_accept`/`sock_recv`/`sock_send`/`sock_shutdown` stubs,
  also instantiate and return deterministic unsupported capability errors so
  browser networking can stay on explicit HTTP, WebSocket, gateway, or
  tool-adapter bridges instead of becoming first-class raw WASIX socket support.
  Eight shallow Preview1 handlers remain for link/symlink/readlink,
  `proc_raise`, and sockets; they stay wired with deterministic browser-safe
  error/no-op behavior so modules can instantiate without implying symlink,
  signal, or socket support. It captures stdout/stderr and exit status for the
  interim browser smoke; it is not an interactive TTY/readline, persistent
  filesystem, networking, WASIX, or WebC runtime.
- `test/http.test.js` and `test/http-worker.test.js` run deterministic
  Fetch/gateway/worker/stream/error tests with Node's built-in test runner and
  no external network.
- `test/http-worker-entry.test.js` runs direct Fetch, gateway, streaming body,
  gateway streaming upload/response, timeout, response-limit,
  unavailable-gateway, invalid-gateway-response, stream-error, and cancellation
  scenarios across a real worker message boundary using local HTTP fixtures.
- `test/codex-browser.test.js` covers the custom-export Codex browser
  request-builder executor, mocked model-request dispatch through direct Fetch
  and gateway transports, mocked Responses SSE text-delta decoding, host-owned
  bearer secret injection/redaction, export validation, and command error
  shaping.
- `test/app-server.test.js` covers the browser app-server fixture's JSON-RPC
  initialization, account status, device login cancellation, thread start,
  mocked turn completion, turn interrupt, unsupported-method errors, malformed
  protocol errors, and turn notification bounds.
- `test/app-server-transport.test.js` covers the app-server loopback
  transport and JSON-RPC client, including frame ordering, request correlation,
  notifications, malformed frames, close behavior, and the same deterministic
  app-server protocol slice through the transport surface.
- `test/app-server-websocket.test.js` covers the app-server WebSocket-shaped
  constructor/factory, including JSON-RPC traffic over constructed sockets,
  isolated runtime counters, accepted loopback URL/protocol shapes, unsupported
  URL/protocol errors, and open/close events.
- `test/app-server-session.test.js` covers the app-server session controller's
  connect/account/login/thread/turn workflow, thread reuse, mocked turn text,
  pending turn interrupt, unsupported method propagation, close behavior, and
  misuse errors before connection.
- `test/secrets.test.js` covers the in-memory browser secret provider and fake
  device-flow broker, including external completion, classified denied/expired/
  cancelled errors, logout, and token redaction.
- `test/workspace.test.js` covers the browser workspace store's file,
  directory, rename, snapshot import/export, invalid path, copied byte, default
  memory fallback, and fake IndexedDB persistence behavior.
- `test/command-worker.test.js` and `test/command-worker-entry.test.js` cover
  command lifecycle success, startup failure, stdin, cancellation, timeout,
  duplicate-run rejection, terminal resize, explicit stream close, HTTP
  transport selection, the smoke command, the Codex `codex --version` contract,
  the browser tool fixture, and the Codex browser request-builder contract
  across a real worker message boundary.
- `test/terminal.test.js` covers the terminal/stdio adapter's message ordering,
  stdout/stderr transcript capture, browser tool fixture transcript execution,
  stdin forwarding, terminal resize, cancellation, stream close, and exit/error
  reporting.
- `test/terminal-ui.test.js` covers the terminal shell controller's output
  rendering, keyboard stdin, paste stdin, EOF, resize, cancellation, and
  pre-run terminal size handling with a fake DOM and fake worker.
- `test/package-source.test.js` covers built-in, file, URL, manifest JSON, and
  manifest URL source normalization, worker load/run message shaping, URL
  redaction, and package arg parsing.
- `test/package-source-ui.test.js` covers the package source controller's apply
  flow, terminal reconfiguration, metadata rendering, and validation errors.
- `fixtures/codex-version-smoke-core.js` owns the browser-safe deterministic
  inline Codex version-smoke manifest and raw WASI fixture. The Node-only
  `fixtures/codex-version-smoke-fixture.js` wrapper adds optional local artifact
  path lookup for `codex-wasix/dist` outputs.
- `fixtures/codex-browser-request-builder-core.js` owns a deterministic
  custom-export Codex browser request-builder Wasm fixture. The Node-only
  `fixtures/codex-browser-request-builder-fixture.js` wrapper adds optional
  local artifact lookup for a built `codex_browser.wasm`.
- `e2e/codex-version-smoke.html`, `e2e/codex-version-smoke.js`,
  `e2e/terminal-shell.html`, `e2e/terminal-shell.js`, and
  `e2e/codex-version-smoke-runner.js` serve `apps/web`, launch real
  Chromium/Chrome pages through the DevTools protocol, start
  `src/command-worker-entry.js` as a module worker, assert the Codex
  `codex --version` stdout/stderr/exit contract, assert the Codex browser
  request-builder JSON contract, assert a mocked model-turn HTTP bridge
  contract with local Responses SSE deltas, assert a workspace-edit fixture
  persists through the browser workspace store, assert the browser app-server
  fixture through the WebSocket-compatible constructor and session controller
  can initialize, report account status, cancel login, reuse a thread, complete
  a mocked turn, interrupt a pending turn, and reject unsupported native
  methods, assert a packaged tool fixture can read the edited file with
  cwd/env/stdin through the terminal transcript adapter, load the pinned
  `wasmer/bash` and `wasmer/coreutils` WebC artifacts for the first passing
  browser Bash/coreutils smoke, and publish named
  stage summaries for the page-level smoke result. The browser e2e also drives
  the terminal UI shell through DOM controls. The terminal shell e2e also
  applies a package URL source backed by a local data URL,
  verifies sanitized package metadata, and runs the selected package through
  the worker smoke executor.
- `test/package-loader.test.js` covers explicit-byte and Fetch-backed package
  loading, fake WebC/Wasm fixtures, cache path derivation, sha256 pinning, clean
  package errors, and handoff into the command lifecycle worker.
- `test/artifact-manifest.test.js` covers valid Codex manifest normalization,
  unsupported capability/artifact cases, fake artifact fetches, size checks,
  streaming overflow, and sha256 mismatch handling.
- `test/wasi-module.test.js` covers raw WASI module byte loading, argv/env
  plumbing, clocks, cooperative yield, random bytes, stdin, read-only package
  files, stdio fd stat, descriptor rights reduction, path/file metadata,
  directory listing and cookies, file
  seek/tell/advice/pread/pwrite behavior, descriptor renumbering, volatile
  scratch-file allocation/truncate/sync and directory create/remove operations,
  scratch path rename behavior, injected workspace-store reads and persisted
  workspace mutations, WASIX namespace mirroring for supported Preview1 calls,
  WASIX cwd/fd utility import coverage, fd duplication and pipe behavior,
  WASIX process/catalog bridge behavior, single-thread defaults, opt-in
  unsupported-call diagnostics, and explicit process, thread/event, and network
  unsupported capability behavior,
  stdout/stderr capture, `proc_exit` status mapping, command worker lifecycle
  integration, and the local Codex version-smoke artifact when it is present.

Run the web adapter checks:

```sh
npm --prefix apps/web run check
npm --prefix apps/web test
npm --prefix apps/web run test:e2e
```

`test:e2e` looks for `chromium`, `chromium-browser`, `google-chrome`,
`google-chrome-stable`, `microsoft-edge`, or an explicit `WASM_HOST_BROWSER`
path. It skips when no browser is available unless
`WASM_HOST_BROWSER_E2E_REQUIRED=1` is set, which is how CI keeps the browser
smoke required. This e2e smoke covers the successful page-to-worker version run,
the first Bash/coreutils WebC package smoke, and the first interactive terminal
UI shell path. Full Bash/readline TTY
behavior is still tracked by #6, and hard termination of non-cooperative Wasm
remains #50.

This package should eventually own:

- full WebC worker startup and package loading
- persistent package source history and richer release artifact selection
- xterm.js/readline-grade terminal rendering and TTY compatibility
- OPFS-backed large workspace persistence and full WASI/Codex edit-turn wiring
- wiring the command and HTTP worker runtimes into actual WebC execution
- full interactive browser app e2e wiring
