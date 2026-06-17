# Issue 217 WASIX TTY Terminal Size

Date: 2026-06-17

Issue: https://github.com/VertoOS/wasm-host/issues/217

Parent issues: https://github.com/VertoOS/wasm-host/issues/115 and
https://github.com/VertoOS/wasm-host/issues/6

Sub-agent: Curie (`019ed5a5-a55e-7da2-8d50-eaab7ed67382`)

## Summary

The browser command worker and terminal session already carry terminal
columns/rows through `command.run` and `command.terminal.resize`. This slice
connects that low-level host terminal geometry to raw WASI/WASIX execution so
`wasix_32v1.tty_get` reports host-provided columns/rows instead of always
returning the fixed 80x25 default.

This is still non-interactive TTY behavior. `tty_set` remains a no-op after
validating the state pointer, TTY mode flags remain disabled, and pixel
dimensions keep deterministic defaults unless a future protocol explicitly
supplies them.

## Runtime Shape

- `runRawWasiModule` passes `request.terminal` into `WasiPreview1Runtime`.
- `WasiPreview1Runtime` normalizes terminal dimensions once, accepting
  `columns` or `cols`, preserving 80x25 defaults for missing/null fields, and
  rejecting non-positive or unsafe integer values.
- `WasixRuntime.ttyGet` writes the request-backed terminal state into the
  24-byte WASIX TTY ABI structure.
- Worker-backed raw WASI requests carry cloneable terminal data:
  `{ columns, rows, width, height }`.
- Copied-fork child instances inherit the parent runtime terminal state.

## Verification

- `node --check apps/web/src/wasi-module.js`
- `node --check apps/web/test/wasi-module.test.js`
- `node --test apps/web/test/wasi-module.test.js`
- `node --test apps/web/test/command-worker.test.js`
- `npm --prefix apps/web run check`
- `npm --prefix apps/web run test:e2e`

## Architecture Boundary

No first-class MCP, plugin, OAuth, provider, or connector runtime modules were
added under `apps/web`. This remains a low-level browser host ABI change for
WASIX terminal geometry.

## Follow-Ups

- Resizes that happen after a raw worker `wasi.run` message is posted still need
  a separate worker state/update channel.
- Readline-grade behavior, canonical/raw input modes, ANSI rendering, xterm.js
  integration, and hard-stop semantics remain broader #115 work.
- Pixel terminal dimensions should only become dynamic when the browser
  terminal protocol explicitly carries pixel metrics.
