#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cargo build --manifest-path "$ROOT/Cargo.toml" -p wasm-host-c-api --locked

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
  TMP_ROOT="$(mktemp -d)"
  trap 'rm -rf "$TMP_ROOT"' EXIT
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
  "$TMP_ROOT/c-abi-smoke"
else
  echo "c abi: skipped; cc is not installed"
fi

echo "python bindings"
PYTHONPATH="$ROOT/bindings/python" WASM_HOST_LIBRARY="$LIB" \
  python3 -m unittest discover -s "$ROOT/bindings/python/tests"

if command -v go >/dev/null 2>&1; then
  echo "go bindings"
  (
    cd "$ROOT/bindings/go"
    go test ./...
  )
else
  echo "go bindings: skipped; go is not installed"
fi
