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
		WebC:    "missing.webc",
		Command: []string{"tool"},
		Stdin:   []byte("hello"),
	}).marshal()
	if err != nil {
		t.Fatal(err)
	}

	if !bytes.Contains(payload, []byte(`"stdin_base64":"aGVsbG8="`)) {
		t.Fatalf("payload did not include base64 stdin: %s", payload)
	}
}
