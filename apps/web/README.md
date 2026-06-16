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
  lifecycle fixture only; real WebC package execution still depends on package
  loading and runtime wiring.
- `src/command-worker-entry.js` is the browser worker entrypoint for starting
  the command lifecycle runtime.
- `src/package-loader.js` implements the first browser package loading surface
  for explicit bytes and Fetch-backed artifacts. It validates WebC/Wasm magic
  bytes, verifies optional sha256 pins, normalizes command metadata for
  `command.load`, and derives IndexedDB-safe package/module cache paths from
  content hashes. It does not parse full WebC metadata or execute packages yet.
- `test/http.test.js` and `test/http-worker.test.js` run deterministic
  Fetch/gateway/worker/stream/error tests with Node's built-in test runner and
  no external network.
- `test/http-worker-entry.test.js` runs direct Fetch, gateway, streaming body,
  gateway streaming upload/response, timeout, response-limit,
  unavailable-gateway, invalid-gateway-response, stream-error, and cancellation
  scenarios across a real worker message boundary using local HTTP fixtures.
- `test/command-worker.test.js` and `test/command-worker-entry.test.js` cover
  command lifecycle success, startup failure, stdin, cancellation, timeout,
  duplicate-run rejection, HTTP transport selection, and the smoke command
  across a real worker message boundary.
- `test/package-loader.test.js` covers explicit-byte and Fetch-backed package
  loading, fake WebC/Wasm fixtures, cache path derivation, sha256 pinning, clean
  package errors, and handoff into the command lifecycle worker.

Run the web adapter checks:

```sh
npm --prefix apps/web run check
npm --prefix apps/web test
```

This package should eventually own:

- WebC worker startup and package loading
- terminal UI integration
- OPFS/IndexedDB workspace persistence
- wiring the command and HTTP worker runtimes into actual WebC execution
- browser e2e wiring
