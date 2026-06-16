# Web Adapter

Browser UI and browser-host adapter work goes here while the runtime contract is
still changing.

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
  runtime. It handles `command.load`, `command.run`, `command.cancel`, stdin
  messages, terminal resize messages, stdout/stderr chunk and close events,
  timeout/cancellation result shaping, and pluggable HTTP bridge transport
  selection. Its built-in `smoke` executor is a lifecycle fixture only; the
  `wasi-module` executor supports the interim raw WASI preview1
  `codex --version` smoke, while real WebC package execution still depends on
  package loading and runtime wiring.
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
  bytes, verifies optional sha256 pins, normalizes command metadata for
  `command.load`, derives IndexedDB-safe package/module cache paths from
  content hashes, and persists package summaries, package bytes, and module
  artifacts in IndexedDB when available. Wasm package sources are mapped onto
  the raw WASI module executor; WebC sources keep their selected executor type.
  Memory cache remains the fallback and test-injectable cache. It does not parse
  full WebC metadata, execute WebC/WASIX packages, manage cache eviction, or
  provide workspace persistence yet.
- `src/artifact-manifest.js` consumes the interim Codex
  `codex-wasix/dist/artifact-manifest.json` shape. It validates the raw
  `wasi-module` `codex --version` contract, normalizes it into command
  load/run fixture messages, and can fetch artifact bytes through an injectable
  transport while verifying size and sha256.
- `src/wasi-module.js` implements the narrow raw WASI preview1 fixture runner
  for modules that import args/env, realtime and monotonic clocks, cooperative
  `sched_yield`, Web Crypto random bytes, preloaded fd 0 stdin through
  `fd_read`, stdio descriptor metadata through `fd_fdstat_get` and
  `fd_fdstat_set_flags`, a read-only `/workspace` package-file preopen through
  `fd_prestat_get`, `fd_prestat_dir_name`, `path_open`, `path_filestat_get`,
  `fd_readdir`, `fd_filestat_get`, `fd_close`, `fd_renumber`, and file-backed
  `fd_read`, `fd_pread`, `fd_seek`, `fd_tell`, and `fd_advise`, plus a
  volatile in-memory `/tmp` scratch preopen for create,
  `path_create_directory`, write, readback, positioned read, stat,
  `fd_allocate`, `fd_advise`,
  truncate/sync, directory listing, `path_rename`, and `path_remove_directory` /
  `path_unlink_file`. It captures stdout/stderr and exit status for the interim
  browser smoke; it is not an interactive TTY/readline, persistent filesystem,
  networking, WASIX, or WebC runtime.
- `test/http.test.js` and `test/http-worker.test.js` run deterministic
  Fetch/gateway/worker/stream/error tests with Node's built-in test runner and
  no external network.
- `test/http-worker-entry.test.js` runs direct Fetch, gateway, streaming body,
  gateway streaming upload/response, timeout, response-limit,
  unavailable-gateway, invalid-gateway-response, stream-error, and cancellation
  scenarios across a real worker message boundary using local HTTP fixtures.
- `test/command-worker.test.js` and `test/command-worker-entry.test.js` cover
  command lifecycle success, startup failure, stdin, cancellation, timeout,
  duplicate-run rejection, terminal resize, explicit stream close, HTTP
  transport selection, the smoke command, and the Codex `codex --version`
  contract across a real worker message boundary.
- `test/terminal.test.js` covers the terminal/stdio adapter's message ordering,
  stdout/stderr transcript capture, stdin forwarding, terminal resize,
  cancellation, stream close, and exit/error reporting.
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
- `e2e/codex-version-smoke.html`, `e2e/codex-version-smoke.js`,
  `e2e/terminal-shell.html`, `e2e/terminal-shell.js`, and
  `e2e/codex-version-smoke-runner.js` serve `apps/web`, launch real
  Chromium/Chrome pages through the DevTools protocol, start
  `src/command-worker-entry.js` as a module worker, assert the Codex
  `codex --version` stdout/stderr/exit contract, and drive the terminal UI shell
  through DOM controls. The terminal shell e2e also applies a package URL source
  backed by a local data URL, verifies sanitized package metadata, and runs the
  selected package through the worker smoke executor.
- `test/package-loader.test.js` covers explicit-byte and Fetch-backed package
  loading, fake WebC/Wasm fixtures, cache path derivation, sha256 pinning, clean
  package errors, and handoff into the command lifecycle worker.
- `test/artifact-manifest.test.js` covers valid Codex manifest normalization,
  unsupported capability/artifact cases, fake artifact fetches, size checks,
  streaming overflow, and sha256 mismatch handling.
- `test/wasi-module.test.js` covers raw WASI module byte loading, argv/env
  plumbing, clocks, cooperative yield, random bytes, stdin, read-only package
  files, stdio fd stat, path/file metadata, directory listing and cookies, file
  seek/tell/advice/pread behavior, descriptor renumbering, volatile
  scratch-file allocation/truncate/sync and directory create/remove operations,
  scratch path rename behavior,
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
smoke required. This e2e smoke covers the successful page-to-worker version run
and the first interactive terminal UI shell path. Bash/readline TTY behavior is
still tracked by #6, and hard termination of non-cooperative Wasm remains #50.

This package should eventually own:

- full WebC worker startup and package loading
- persistent package source history and richer release artifact selection
- xterm.js/readline-grade terminal rendering and TTY compatibility
- OPFS/IndexedDB workspace persistence
- wiring the command and HTTP worker runtimes into actual WebC execution
- full interactive browser app e2e wiring
