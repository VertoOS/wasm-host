# Repository Layout

`wasm-host` is a monorepo during the runtime discovery phase. The host contract,
native runner, browser adapter, bindings, fixtures, and e2e tests should evolve
together until the behavior is stable.

## Current Layout

```text
apps/
  web/                 # browser UI/runtime app
bindings/
  c/                   # C ABI header and ownership contract
  go/                  # Go binding and examples
  python/              # Python package surface
crates/
  wasm-host-core/      # Rust host runtime
  wasm-host-fixtures/  # generated WebC fixtures for tests and examples
  wasm-host-runner/    # native terminal runner
docs/                  # host profile and layout
packages/
  fixtures/            # source and package fixtures
tests/
  bindings/            # C ABI wrapper smoke tests
  conformance/         # host behavior tests shared by adapters
  e2e/                 # language and application e2e flows
vendor/                # patched backend dependencies
```

## Split Rules

Split a directory into its own repo only when there is a concrete distribution
boundary:

- Go needs a stable module path, tags, and release cadence.
- Python needs a separate PyPI package release cadence.
- The browser app needs independent deployment.
- Fixtures become too large or generated to keep in the core repo.
- External users need a stable package that should not track runtime internals.

Until then, keeping everything here makes host contract changes faster and keeps
e2e coverage close to the implementation.
