# Bindings

Bindings stay thin over the C ABI while the host contract is still changing.
Python and Go should not duplicate runtime behavior that belongs in
`wasm-host-core` or the native runner.

## Current Distribution Shape

- `bindings/c` owns the C header and opaque-result ownership contract.
- `bindings/python` is a Python package shell that loads the C ABI shared
  library from `WASM_HOST_LIBRARY` or an explicit path.
- `bindings/go` is a Go module that links the C ABI with cgo during local
  development.

The C ABI library is built from `crates/wasm-host-c-api`. Higher-level bindings
should treat that library as the runtime artifact and keep language-specific
code focused on typed options, result conversion, and ownership safety.

The package version describes the crate/release artifact. The C ABI version is
separate and increments only when the native ABI changes incompatibly.

## Local Checks

Run all binding checks with:

```sh
tests/bindings/run.sh
```

The harness builds the C ABI library and fixture generator, emits a small WebC
package, compiles a C consumer against the public header when `cc` is installed,
validates Python package metadata, runs Python wrapper tests, and runs Go tests
when Go is installed. The C, Python, and Go checks all execute the generated
package through the C ABI and assert that the compiled header ABI version
matches the linked library.

## Split Criteria

Keep bindings in this monorepo until at least one of these is true:

- Python needs independent PyPI releases with packaged native artifacts.
- Go needs independent tags, module paths, or generated release assets.
- C ABI compatibility needs versioned headers and binary artifacts consumed by
  external repositories.
- Fixture-backed examples are stable enough to become release smoke tests.

Until then, changing the host contract and binding surfaces together keeps the
runtime, fixtures, and e2e tests aligned.
