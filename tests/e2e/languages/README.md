# Language E2E

These tests run language code inside `wasm-host-runner`.

```sh
WASM_HOST_PYTHON_WEBC=/path/to/python.webc tests/e2e/languages/run.sh --require-python
WASM_HOST_GO_WEBC=/path/to/go-toolchain.webc tests/e2e/languages/run.sh --require-go
```

The Python package may be a `.webc` or `.webc.gz` file. The Go package may be a
Go toolchain package that exposes `go`, or a prebuilt fixture package with a
custom command:

```sh
WASM_HOST_GO_WEBC=/path/to/go-smoke.webc \
WASM_HOST_GO_COMMAND=go-smoke \
WASM_HOST_GO_ARGS= \
tests/e2e/languages/run.sh --require-go
```
