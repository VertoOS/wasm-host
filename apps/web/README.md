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
- `test/http.test.js` and `test/http-worker.test.js` run deterministic
  Fetch/gateway/worker/stream/error tests with Node's built-in test runner and
  no external network.
- `test/http-worker-entry.test.js` runs direct Fetch, gateway, streaming body,
  gateway streaming upload/response, timeout, response-limit,
  unavailable-gateway, invalid-gateway-response, stream-error, and cancellation
  scenarios across a real worker message boundary using local HTTP fixtures.

Run the web adapter checks:

```sh
npm --prefix apps/web run check
npm --prefix apps/web test
```

This package should eventually own:

- WebC worker startup and package loading
- terminal UI integration
- OPFS/IndexedDB workspace persistence
- wiring the HTTP worker runtime into actual WebC execution
- browser e2e wiring
