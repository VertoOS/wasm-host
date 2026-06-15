package wasmhost

/*
#cgo CFLAGS: -I${SRCDIR}/../c
#cgo darwin LDFLAGS: -L${SRCDIR}/../../target/debug -lwasm_host_c_api
#cgo linux LDFLAGS: -L${SRCDIR}/../../target/debug -lwasm_host_c_api
#include "wasm_host.h"
#include <stdlib.h>
*/
import "C"

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"unsafe"
)

const (
	StatusOK    = int32(C.WASM_HOST_STATUS_OK)
	StatusError = int32(C.WASM_HOST_STATUS_ERROR)
)

type Alias struct {
	Alias   string `json:"alias"`
	Command string `json:"command"`
}

type Mount struct {
	Source   string `json:"source"`
	Target   string `json:"target"`
	ReadOnly *bool  `json:"read_only,omitempty"`
}

type HostCommand struct {
	GuestPath   string `json:"guest_path"`
	HostCommand string `json:"host_command"`
}

type Options struct {
	WebC           string            `json:"webc"`
	Command        []string          `json:"command"`
	Profile        string            `json:"profile,omitempty"`
	Package        string            `json:"package,omitempty"`
	Aliases        []Alias           `json:"aliases,omitempty"`
	Mounts         []Mount           `json:"mounts,omitempty"`
	HostCommands   []HostCommand     `json:"host_commands,omitempty"`
	CWD            string            `json:"cwd,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	Stdin          []byte            `json:"-"`
	OutputLimit    *int              `json:"output_limit,omitempty"`
	TimeoutSeconds *float64          `json:"timeout_seconds,omitempty"`
	ModuleCacheDir string            `json:"module_cache_dir,omitempty"`
	HTTPBridge     string            `json:"http_bridge,omitempty"`
}

type Result struct {
	Status     int32
	ReturnCode int32
	Stdout     []byte
	Stderr     []byte
	Error      []byte
}

func (result Result) OK() bool {
	return result.Status == StatusOK
}

func (result Result) ErrorText() string {
	return string(result.Error)
}

func Version() string {
	return C.GoString(C.wasm_host_version())
}

func ReadOnlyMount(source, target string) Mount {
	readOnly := true
	return Mount{Source: source, Target: target, ReadOnly: &readOnly}
}

func ReadWriteMount(source, target string) Mount {
	readOnly := false
	return Mount{Source: source, Target: target, ReadOnly: &readOnly}
}

func Run(options Options) (Result, error) {
	optionsJSON, err := options.marshal()
	if err != nil {
		return Result{}, err
	}
	return RunJSON(optionsJSON)
}

func RunJSON(optionsJSON []byte) (Result, error) {
	if len(optionsJSON) == 0 {
		return Result{}, errors.New("options JSON cannot be empty")
	}

	rawOptions := C.CString(string(optionsJSON))
	defer C.free(unsafe.Pointer(rawOptions))

	rawResult := C.wasm_host_run_json(rawOptions)
	if rawResult == nil {
		return Result{}, errors.New("wasm_host_run_json returned nil")
	}
	defer C.wasm_host_result_free(rawResult)

	return Result{
		Status:     int32(C.wasm_host_result_status(rawResult)),
		ReturnCode: int32(C.wasm_host_result_returncode(rawResult)),
		Stdout:     bytesFromC(C.wasm_host_result_stdout_ptr(rawResult), C.wasm_host_result_stdout_len(rawResult)),
		Stderr:     bytesFromC(C.wasm_host_result_stderr_ptr(rawResult), C.wasm_host_result_stderr_len(rawResult)),
		Error:      bytesFromC(C.wasm_host_result_error_ptr(rawResult), C.wasm_host_result_error_len(rawResult)),
	}, nil
}

func (options Options) marshal() ([]byte, error) {
	type ffiOptions Options
	payload := struct {
		ffiOptions
		StdinBase64 string `json:"stdin_base64,omitempty"`
	}{
		ffiOptions: ffiOptions(options),
	}
	if len(options.Stdin) > 0 {
		payload.StdinBase64 = base64.StdEncoding.EncodeToString(options.Stdin)
	}
	return json.Marshal(payload)
}

func bytesFromC(ptr *C.uint8_t, length C.size_t) []byte {
	if ptr == nil || length == 0 {
		return nil
	}
	return C.GoBytes(unsafe.Pointer(ptr), C.int(length))
}
