# Language Fixtures

Language fixtures verify that code runs inside the host, not on the developer's
machine.

`manifest.json` is the source of truth for the Python and Go fixture package
metadata. It records package names, command defaults, expected smoke-test
markers, and the environment variables used to provide local paths, URLs, and
sha256 pins.

Initial fixture targets are:

- Python: run `python /workspace/python/smoke.py` inside a Python WebC package.
- Go: run `go run /workspace/go/smoke.go` inside a Go toolchain WebC package, or
  run a prebuilt Go fixture command from a WebC package.

Local artifact inputs:

```sh
WASM_HOST_PYTHON_WEBC=/path/to/python.webc tests/e2e/languages/run.sh --require-python
WASM_HOST_GO_WEBC=/path/to/go.webc.gz tests/e2e/languages/run.sh --require-go
```

URL-backed inputs:

```sh
WASM_HOST_FIXTURE_CACHE_DIR=.cache/fixtures \
WASM_HOST_PYTHON_WEBC_URL=https://example.invalid/python.webc.gz \
WASM_HOST_PYTHON_WEBC_SHA256=<sha256-of-downloaded-file> \
tests/e2e/languages/run.sh --require-python
```

When a fixture is promoted to CI-required, update `manifest.json` with the
artifact URL, source version, and sha256. Keep generated `.webc` and `.webc.gz`
files out of git unless that changes through an explicit storage decision.
