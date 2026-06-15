# Web Adapter

Browser UI and browser-host adapter work goes here while the runtime contract is
still changing.

Current scope:

- `src/http.js` implements direct Fetch and gateway-backed HTTP transport
  surfaces for browser workers.
- `test/http.test.js` runs deterministic Fetch/gateway/stream/error tests with
  Node's built-in test runner and no external network.

Run the web adapter checks:

```sh
npm --prefix apps/web run check
npm --prefix apps/web test
```

This package should eventually own:

- worker startup and package loading
- terminal UI integration
- OPFS/IndexedDB workspace persistence
- wiring Fetch/gateway networking into the browser runtime worker
- browser e2e wiring
