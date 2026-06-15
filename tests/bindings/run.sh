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
else
  echo "go bindings: skipped; go is not installed"
fi
