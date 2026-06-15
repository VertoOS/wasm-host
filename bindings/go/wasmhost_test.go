package wasmhost

import (
	"bytes"
	"os"
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
		HostCommands: []HostCommand{
			{GuestPath: "/tools/echo", HostCommand: "/bin/echo"},
		},
		ModuleCacheDir: "/tmp/wasm-host-modules",
		HTTPBridge:     "native",
	}).marshal()
	if err != nil {
		t.Fatal(err)
	}

	if !bytes.Contains(payload, []byte(`"stdin_base64":"aGVsbG8="`)) {
		t.Fatalf("payload did not include base64 stdin: %s", payload)
	}
	if !bytes.Contains(payload, []byte(`"host_commands":[{"guest_path":"/tools/echo","host_command":"/bin/echo"}]`)) {
		t.Fatalf("payload did not include host command bridge: %s", payload)
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

func TestHostCommandWithoutNativeFullReturnsErrorResult(t *testing.T) {
	result, err := Run(Options{
		WebC:    "missing.webc",
		Command: []string{"tool"},
		HostCommands: []HostCommand{
			{GuestPath: "/tools/echo", HostCommand: "/bin/echo"},
		},
	})
	if err != nil {
		t.Fatalf("run should return ABI result, got error: %v", err)
	}

	if result.OK() {
		t.Fatal("host command without native-full should fail")
	}
	if result.ReturnCode != 125 {
		t.Fatalf("return code = %d, want 125", result.ReturnCode)
	}
	if string(result.Error) != "host_commands require the native-full profile, current profile is browser-strict" {
		t.Fatalf("error = %q", result.Error)
	}
}

func TestRunsGeneratedFixturePackage(t *testing.T) {
	fixture := os.Getenv("WASM_HOST_BINDING_FIXTURE_WEBC")
	if fixture == "" {
		t.Skip("WASM_HOST_BINDING_FIXTURE_WEBC is not set")
	}

	result, err := Run(Options{
		WebC:    fixture,
		Command: []string{"stdout-fixture"},
	})
	if err != nil {
		t.Fatalf("run should return ABI result, got error: %v", err)
	}

	if !result.OK() {
		t.Fatalf("fixture run failed: %s", result.Error)
	}
	if result.ReturnCode != 0 {
		t.Fatalf("return code = %d, want 0", result.ReturnCode)
	}
	if string(result.Stdout) != "BINDING_FIXTURE_OK\n" {
		t.Fatalf("stdout = %q", result.Stdout)
	}
	if len(result.Stderr) != 0 {
		t.Fatalf("stderr should be empty: %q", result.Stderr)
	}
}
