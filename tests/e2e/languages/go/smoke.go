package main

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
)

func main() {
	const path = "/tmp/wasm-host-go-e2e.txt"
	if err := os.WriteFile(path, []byte("go wrote this\n"), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "write failed: %v\n", err)
		os.Exit(1)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read failed: %v\n", err)
		os.Exit(1)
	}

	payload := map[string]any{
		"marker":  "GO_E2E_OK",
		"args":    os.Args[1:],
		"cwd":     mustGetwd(),
		"go":      runtime.Version(),
		"tmp":     string(data),
		"targets": runtime.GOOS + "/" + runtime.GOARCH,
	}
	if err := json.NewEncoder(os.Stdout).Encode(payload); err != nil {
		fmt.Fprintf(os.Stderr, "json failed: %v\n", err)
		os.Exit(1)
	}
}

func mustGetwd() string {
	wd, err := os.Getwd()
	if err != nil {
		return "unknown"
	}
	return wd
}
