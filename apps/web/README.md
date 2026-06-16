# Web Adapter

Browser UI and browser-host adapter work goes here while the runtime contract is
still changing.

Current scope:

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
  messages, stdout/stderr events, timeout/cancellation result shaping, and
  pluggable HTTP bridge transport selection. Its built-in `smoke` executor is a
  lifecycle fixture only; the `wasi-module` executor supports the interim raw
  WASI preview1 `codex --version` smoke, while real WebC package execution
  still depends on package loading and runtime wiring.
- `src/command-worker-entry.js` is the browser worker entrypoint for starting
  the command lifecycle runtime. The worker-boundary tests run the normalized
  Codex version-smoke fixture through this entrypoint.
- `src/package-loader.js` implements the first browser package loading surface
  for explicit bytes and Fetch-backed artifacts. It validates WebC/Wasm magic
  bytes, verifies optional sha256 pins, normalizes command metadata for
  `command.load`, and derives IndexedDB-safe package/module cache paths from
  content hashes. It does not parse full WebC metadata or execute packages yet.
- `src/artifact-manifest.js` consumes the interim Codex
  `codex-wasix/dist/artifact-manifest.json` shape. It validates the raw
  `wasi-module` `codex --version` contract, normalizes it into command
  load/run fixture messages, and can fetch artifact bytes through an injectable
  transport while verifying size and sha256.
- `src/wasi-module.js` implements the narrow raw WASI preview1 fixture runner
  for modules that import only args/env, `fd_write`, and `proc_exit`. It
  captures stdout/stderr and exit status for the interim browser smoke; it is
  not a general filesystem, networking, WASIX, or WebC runtime.
- `test/http.test.js` and `test/http-worker.test.js` run deterministic
  Fetch/gateway/worker/stream/error tests with Node's built-in test runner and
  no external network.
- `test/http-worker-entry.test.js` runs direct Fetch, gateway, streaming body,
  gateway streaming upload/response, timeout, response-limit,
  unavailable-gateway, invalid-gateway-response, stream-error, and cancellation
  scenarios across a real worker message boundary using local HTTP fixtures.
- `test/command-worker.test.js` and `test/command-worker-entry.test.js` cover
  command lifecycle success, startup failure, stdin, cancellation, timeout,
  duplicate-run rejection, HTTP transport selection, the smoke command, and the
  Codex `codex --version` contract across a real worker message boundary.
- `fixtures/codex-version-smoke-fixture.js` owns the deterministic inline Codex
  version-smoke manifest and raw WASI fixture used by worker-boundary tests, and
  the optional local artifact path lookup for `codex-wasix/dist` outputs.
- `test/package-loader.test.js` covers explicit-byte and Fetch-backed package
  loading, fake WebC/Wasm fixtures, cache path derivation, sha256 pinning, clean
  package errors, and handoff into the command lifecycle worker.
- `test/artifact-manifest.test.js` covers valid Codex manifest normalization,
  unsupported capability/artifact cases, fake artifact fetches, size checks,
  streaming overflow, and sha256 mismatch handling.
- `test/wasi-module.test.js` covers raw WASI module byte loading, argv/env
  plumbing, stdout/stderr capture, `proc_exit` status mapping, command worker
  lifecycle integration, and the local Codex version-smoke artifact when it is
  present.

Run the web adapter checks:

```sh
npm --prefix apps/web run check
npm --prefix apps/web test
```

This package should eventually own:

- full WebC worker startup and package loading
- terminal UI integration
- OPFS/IndexedDB workspace persistence
- wiring the command and HTTP worker runtimes into actual WebC execution
- browser e2e wiring
