#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

cargo build --manifest-path "$ROOT/Cargo.toml" \
  -p wasm-host-c-api \
  -p wasm-host-fixtures \
  --locked

FIXTURE_WEBC="$TMP_ROOT/stdout-fixture.webc"
"$ROOT/target/debug/wasm-host-fixtures" stdout \
  --output "$FIXTURE_WEBC" \
  --stdout $'BINDING_FIXTURE_OK\n'
export WASM_HOST_BINDING_FIXTURE_WEBC="$FIXTURE_WEBC"

case "$(uname -s)" in
  Darwin)
    LIB="$ROOT/target/debug/libwasm_host_c_api.dylib"
    export DYLD_LIBRARY_PATH="$ROOT/target/debug:${DYLD_LIBRARY_PATH:-}"
    ;;
  Linux)
    LIB="$ROOT/target/debug/libwasm_host_c_api.so"
    export LD_LIBRARY_PATH="$ROOT/target/debug:${LD_LIBRARY_PATH:-}"
    ;;
  *)
    echo "bindings: unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac

if [[ ! -s "$LIB" ]]; then
  echo "bindings: missing C ABI library: $LIB" >&2
  exit 1
fi

if command -v cc >/dev/null 2>&1; then
  echo "c abi"
  cc \
    -std=c11 \
    -Wall \
    -Wextra \
    -Werror \
    -I "$ROOT/bindings/c" \
    "$ROOT/tests/bindings/c/abi_smoke.c" \
    -L "$ROOT/target/debug" \
    -lwasm_host_c_api \
    -Wl,-rpath,"$ROOT/target/debug" \
    -o "$TMP_ROOT/c-abi-smoke"
  "$TMP_ROOT/c-abi-smoke" "$FIXTURE_WEBC"
else
  echo "c abi: skipped; cc is not installed"
fi

echo "python package metadata"
python3 - "$ROOT/bindings/python/pyproject.toml" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")

for expected in [
    'name = "vertoos-wasm-host"',
    'version = "0.1.0"',
    'requires-python = ">=3.9"',
    'packages = ["wasm_host"]',
]:
    if expected not in text:
        raise AssertionError(f"missing pyproject metadata: {expected}")
PY

echo "python bindings"
PYTHONPATH="$ROOT/bindings/python" WASM_HOST_LIBRARY="$LIB" \
  python3 -m unittest discover -s "$ROOT/bindings/python/tests"

echo "python out-of-tree consumer"
PYTHON_CONSUMER="$TMP_ROOT/python-consumer"
mkdir -p "$PYTHON_CONSUMER/site" "$PYTHON_CONSUMER/work"
cp -R "$ROOT/bindings/python/wasm_host" "$PYTHON_CONSUMER/site/"
(
  cd "$PYTHON_CONSUMER/work"
  PYTHONPATH="$PYTHON_CONSUMER/site" WASM_HOST_LIBRARY="$LIB" \
    python3 - "$FIXTURE_WEBC" "$ROOT" <<'PY'
import os
import sys
from pathlib import Path

import wasm_host
from wasm_host import ABI_VERSION, RunOptions, load_library, run

fixture = sys.argv[1]
repo_root = Path(sys.argv[2]).resolve()
binding_path = Path(wasm_host.__file__).resolve()

if os.path.commonpath([str(repo_root), str(binding_path)]) == str(repo_root):
    raise AssertionError(f"imported wasm_host from repo path: {binding_path}")

library = load_library()
if not library.version():
    raise AssertionError("library version should be non-empty")
if ABI_VERSION != 1:
    raise AssertionError(f"compiled ABI version = {ABI_VERSION}, want 1")
if library.abi_version() != ABI_VERSION:
    raise AssertionError(
        f"linked ABI version = {library.abi_version()}, want {ABI_VERSION}"
    )

result = run(RunOptions(webc=fixture, command=["stdout-fixture"]), library)
if not result.ok:
    raise AssertionError(result.error_text)
if result.returncode != 0:
    raise AssertionError(f"return code = {result.returncode}, want 0")
if result.stdout != b"BINDING_FIXTURE_OK\n":
    raise AssertionError(f"stdout = {result.stdout!r}")
if result.stderr != b"":
    raise AssertionError(f"stderr = {result.stderr!r}")
PY
)

if command -v go >/dev/null 2>&1; then
  echo "go bindings"
  (
    cd "$ROOT/bindings/go"
    module_path="$(go list -m)"
    if [[ "$module_path" != "github.com/VertoOS/wasm-host/bindings/go" ]]; then
      echo "go bindings: unexpected module path: $module_path" >&2
      exit 1
    fi
    go test ./...
  )

  echo "go out-of-tree consumer"
  GO_CONSUMER="$TMP_ROOT/go-consumer"
  mkdir -p "$GO_CONSUMER"
  cat >"$GO_CONSUMER/go.mod" <<EOF
module wasm-host-binding-consumer-smoke

go 1.22

require github.com/VertoOS/wasm-host/bindings/go v0.0.0

replace github.com/VertoOS/wasm-host/bindings/go => $ROOT/bindings/go
EOF
  cat >"$GO_CONSUMER/main.go" <<'GO'
package main

import (
	"fmt"
	"os"

	wasmhost "github.com/VertoOS/wasm-host/bindings/go"
)

func main() {
	if wasmhost.Version() == "" {
		panic("version should not be empty")
	}
	if wasmhost.ABIVersion != 1 {
		panic(fmt.Sprintf("compiled ABI version = %d, want 1", wasmhost.ABIVersion))
	}
	if wasmhost.LinkedABIVersion() != wasmhost.ABIVersion {
		panic(fmt.Sprintf("linked ABI version = %d, want %d", wasmhost.LinkedABIVersion(), wasmhost.ABIVersion))
	}

	fixture := os.Getenv("WASM_HOST_BINDING_FIXTURE_WEBC")
	if fixture == "" {
		panic("WASM_HOST_BINDING_FIXTURE_WEBC is not set")
	}

	result, err := wasmhost.Run(wasmhost.Options{
		WebC:    fixture,
		Command: []string{"stdout-fixture"},
	})
	if err != nil {
		panic(err)
	}
	if !result.OK() {
		panic(result.ErrorText())
	}
	if result.ReturnCode != 0 {
		panic(fmt.Sprintf("return code = %d, want 0", result.ReturnCode))
	}
	if string(result.Stdout) != "BINDING_FIXTURE_OK\n" {
		panic(fmt.Sprintf("stdout = %q", result.Stdout))
	}
	if len(result.Stderr) != 0 {
		panic(fmt.Sprintf("stderr = %q", result.Stderr))
	}
}
GO
  (
    cd "$GO_CONSUMER"
    WASM_HOST_BINDING_FIXTURE_WEBC="$FIXTURE_WEBC" go run .
  )
else
  echo "go bindings: skipped; go is not installed"
fi
