#ifndef WASM_HOST_H
#define WASM_HOST_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct WasmHostRunResult WasmHostRunResult;

#define WASM_HOST_STATUS_OK 0
#define WASM_HOST_STATUS_ERROR 1
#define WASM_HOST_ABI_VERSION 1

const char *wasm_host_version(void);
uint32_t wasm_host_abi_version(void);

WasmHostRunResult *wasm_host_run_json(const char *options_json);

int32_t wasm_host_result_status(const WasmHostRunResult *result);
int32_t wasm_host_result_returncode(const WasmHostRunResult *result);

const uint8_t *wasm_host_result_stdout_ptr(const WasmHostRunResult *result);
size_t wasm_host_result_stdout_len(const WasmHostRunResult *result);

const uint8_t *wasm_host_result_stderr_ptr(const WasmHostRunResult *result);
size_t wasm_host_result_stderr_len(const WasmHostRunResult *result);

const uint8_t *wasm_host_result_error_ptr(const WasmHostRunResult *result);
size_t wasm_host_result_error_len(const WasmHostRunResult *result);

void wasm_host_result_free(WasmHostRunResult *result);

#ifdef __cplusplus
}
#endif

#endif
