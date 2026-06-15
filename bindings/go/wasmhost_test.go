package wasmhost

import (
	"bytes"
	"testing"
)

func TestVersionComesFromCABI(t *testing.T) {
	if Version() == "" {
		t.Fatal("version should not be empty")
	}
}

func TestEmptyCommandReturnsErrorResult(t *testing.T) {
	result, err := Run(Options{WebC: "missing.webc", Command: []string{}})
	if err != nil {
		t.Fatalf("run should return ABI result, got error: %v", err)
	}

	if result.OK() {
		t.Fatal("empty command should fail")
	}
	if result.ReturnCode != 125 {
		t.Fatalf("return code = %d, want 125", result.ReturnCode)
	}
	if string(result.Error) != "command cannot be empty" {
		t.Fatalf("error = %q", result.Error)
	}
	if len(result.Stdout) != 0 || len(result.Stderr) != 0 {
		t.Fatalf("stdout/stderr should be empty: %q %q", result.Stdout, result.Stderr)
	}
}

func TestOptionsEncodeStdin(t *testing.T) {
	payload, err := (Options{
		WebC:           "missing.webc",
		Command:        []string{"tool"},
		Stdin:          []byte("hello"),
		ModuleCacheDir: "/tmp/wasm-host-modules",
		HTTPBridge:     "native",
	}).marshal()
	if err != nil {
		t.Fatal(err)
	}

	if !bytes.Contains(payload, []byte(`"stdin_base64":"aGVsbG8="`)) {
		t.Fatalf("payload did not include base64 stdin: %s", payload)
	}
	if !bytes.Contains(payload, []byte(`"module_cache_dir":"/tmp/wasm-host-modules"`)) {
		t.Fatalf("payload did not include module cache dir: %s", payload)
	}
	if !bytes.Contains(payload, []byte(`"http_bridge":"native"`)) {
		t.Fatalf("payload did not include HTTP bridge mode: %s", payload)
	}
}

func TestUnknownHTTPBridgeReturnsErrorResult(t *testing.T) {
	result, err := RunJSON([]byte(`{"webc":"missing.webc","command":["tool"],"http_bridge":"bad"}`))
	if err != nil {
		t.Fatalf("run should return ABI result, got error: %v", err)
	}

	if result.OK() {
		t.Fatal("unknown HTTP bridge mode should fail")
	}
	if result.ReturnCode != 125 {
		t.Fatalf("return code = %d, want 125", result.ReturnCode)
	}
	if string(result.Error) != "unknown HTTP bridge mode: bad; expected off or native" {
		t.Fatalf("error = %q", result.Error)
	}
}
