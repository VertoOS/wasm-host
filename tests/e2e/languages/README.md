# Language E2E

These tests run language code inside `wasm-host-runner`. Package metadata and
default commands are resolved through
[`../../../packages/fixtures/languages/manifest.json`](../../../packages/fixtures/languages/manifest.json).
The harness validates structured JSON output from the guest program, including
the expected marker, `/workspace` cwd, guest `/tmp` writes, and program args.

```sh
WASM_HOST_PYTHON_WEBC=/path/to/python.webc tests/e2e/languages/run.sh --require-python
WASM_HOST_GO_WEBC=/path/to/go-toolchain.webc tests/e2e/languages/run.sh --require-go
```

The package may be a local `.webc` or `.webc.gz` file. The harness can also
fetch URL-backed packages into `WASM_HOST_FIXTURE_CACHE_DIR` when the manifest
or environment provides a URL:

```sh
WASM_HOST_PYTHON_WEBC_URL=https://example.invalid/python.webc.gz \
WASM_HOST_PYTHON_WEBC_SHA256=<sha256-of-downloaded-file> \
tests/e2e/languages/run.sh --require-python
```

The Go package may be a Go toolchain package that exposes `go`, or a prebuilt
fixture package with a custom command:

```sh
WASM_HOST_GO_WEBC=/path/to/go-smoke.webc \
WASM_HOST_GO_COMMAND=go-smoke \
WASM_HOST_GO_ARGS= \
tests/e2e/languages/run.sh --require-go
```

Run validator-only checks without a WebC artifact:

```sh
tests/e2e/languages/test-validator.sh
```
