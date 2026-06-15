#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "wasm_host.h"

static int fail(const char *message) {
  fprintf(stderr, "c abi smoke: %s\n", message);
  return 1;
}

static int bytes_equal(const uint8_t *data, size_t len, const char *expected) {
  size_t expected_len = strlen(expected);
  return len == expected_len && data != NULL &&
         memcmp(data, expected, expected_len) == 0;
}

static int expect_empty_buffer(const uint8_t *data, size_t len,
                               const char *name) {
  if (len != 0) {
    fprintf(stderr, "c abi smoke: expected empty %s len, got %zu\n", name, len);
    return 1;
  }
  if (data != NULL) {
    fprintf(stderr, "c abi smoke: expected null %s ptr for empty buffer\n",
            name);
    return 1;
  }
  return 0;
}

static int expect_error_result(WasmHostRunResult *result,
                               const char *expected_error) {
  if (result == NULL) {
    return fail("run returned null result");
  }
  if (wasm_host_result_status(result) != WASM_HOST_STATUS_ERROR) {
    return fail("expected error status");
  }
  if (wasm_host_result_returncode(result) != 125) {
    return fail("expected host error return code 125");
  }
  if (expect_empty_buffer(wasm_host_result_stdout_ptr(result),
                          wasm_host_result_stdout_len(result), "stdout") != 0) {
    return 1;
  }
  if (expect_empty_buffer(wasm_host_result_stderr_ptr(result),
                          wasm_host_result_stderr_len(result), "stderr") != 0) {
    return 1;
  }
  if (!bytes_equal(wasm_host_result_error_ptr(result),
                   wasm_host_result_error_len(result), expected_error)) {
    fprintf(stderr, "c abi smoke: unexpected error payload: %.*s\n",
            (int)wasm_host_result_error_len(result),
            (const char *)wasm_host_result_error_ptr(result));
    return 1;
  }
  return 0;
}

int main(void) {
  const char *version = wasm_host_version();
  if (version == NULL || version[0] == '\0') {
    return fail("version should be non-empty");
  }

  WasmHostRunResult *null_result = wasm_host_run_json(NULL);
  if (expect_error_result(null_result, "options_json cannot be null") != 0) {
    wasm_host_result_free(null_result);
    return 1;
  }
  wasm_host_result_free(null_result);

  WasmHostRunResult *empty_command = wasm_host_run_json(
      "{\"webc\":\"missing.webc\",\"command\":[]}");
  if (expect_error_result(empty_command, "command cannot be empty") != 0) {
    wasm_host_result_free(empty_command);
    return 1;
  }
  wasm_host_result_free(empty_command);

  wasm_host_result_free(NULL);
  return 0;
}
