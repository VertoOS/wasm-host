# C ABI

The C ABI is the stable native surface for higher-level bindings during the
monorepo phase. Python, Go, and any other C-compatible language should build on
this layer instead of duplicating runtime behavior.

## Surface

`wasm_host_run_json` accepts a UTF-8 JSON object and returns an owned opaque
result. Callers must release the result with `wasm_host_result_free`.

Minimal options:

```json
{
  "webc": "/path/to/package.webc",
  "profile": "browser-strict",
  "package": "package",
  "cwd": "/work",
  "env": {
    "HOME": "/home/sandbox"
  },
  "command": ["package-command", "--version"]
}
```

Optional fields:

- `aliases`: `[{"alias":"python","command":"python"}]`
- `mounts`: `[{"source":"/host/path","target":"/workspace","read_only":true}]`
  where `read_only` defaults to `true`
- `stdin_base64`: base64-encoded stdin bytes
- `output_limit`: stdout/stderr byte limit
- `timeout_seconds`: wall-time limit
- `module_cache_dir`: directory for compiled module cache entries
- `http_bridge`: `off` or `native`; `native` exposes `/dev/wasm-host-http`
  through the native HTTP bridge worker

The result status reports host/API success or failure. A guest process that exits
non-zero still has status `0`; inspect `wasm_host_result_returncode`.

## Tests

`tests/bindings/run.sh` builds the C ABI library and, when `cc` is available,
compiles `tests/bindings/c/abi_smoke.c` against this header. The smoke binary
links the produced shared library and verifies version lookup, owned error
results, empty buffer pointer/length behavior, and null-safe result freeing.

## C usage

```c
#include "wasm_host.h"

int main(void) {
  const char *options =
    "{\"webc\":\"/path/to/package.webc\","
    "\"command\":[\"package-command\",\"--version\"]}";

  WasmHostRunResult *result = wasm_host_run_json(options);
  int status = wasm_host_result_status(result);
  int returncode = wasm_host_result_returncode(result);

  const uint8_t *stdout_data = wasm_host_result_stdout_ptr(result);
  size_t stdout_len = wasm_host_result_stdout_len(result);
  (void)stdout_data;
  (void)stdout_len;

  wasm_host_result_free(result);
  return status == WASM_HOST_STATUS_OK ? returncode : 125;
}
```
