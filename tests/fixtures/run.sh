#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST="$ROOT/packages/fixtures/languages/manifest.json"
RESOLVER="$ROOT/packages/fixtures/languages/resolve.py"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

sha256_file() {
  python3 - "$1" <<'PY'
import hashlib
import sys

digest = hashlib.sha256()
with open(sys.argv[1], "rb") as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(chunk)
print(digest.hexdigest())
PY
}

python3 -m py_compile "$RESOLVER"

optional_output="$("$RESOLVER" \
  --manifest "$MANIFEST" \
  --language python \
  --tmp-root "$TMP_ROOT" \
  --optional)"
grep -q "WASM_HOST_RESOLVED_AVAILABLE=0" <<<"$optional_output"

printf '\0webc003fake' > "$TMP_ROOT/python.webc"
python_sha="$(sha256_file "$TMP_ROOT/python.webc")"
python_output="$(WASM_HOST_PYTHON_WEBC="$TMP_ROOT/python.webc" \
  WASM_HOST_PYTHON_WEBC_SHA256="$python_sha" \
  "$RESOLVER" \
  --manifest "$MANIFEST" \
  --language python \
  --tmp-root "$TMP_ROOT")"
grep -q "WASM_HOST_RESOLVED_AVAILABLE=1" <<<"$python_output"
grep -q "WASM_HOST_RESOLVED_ARGS_JSON='\\[\"/workspace/python/smoke.py\"\\]'" <<<"$python_output"

printf '\0webc003fake' | gzip > "$TMP_ROOT/go.webc.gz"
go_sha="$(sha256_file "$TMP_ROOT/go.webc.gz")"
go_output="$(WASM_HOST_GO_WEBC="$TMP_ROOT/go.webc.gz" \
  WASM_HOST_GO_WEBC_SHA256="$go_sha" \
  "$RESOLVER" \
  --manifest "$MANIFEST" \
  --language go \
  --tmp-root "$TMP_ROOT")"
grep -q "WASM_HOST_RESOLVED_AVAILABLE=1" <<<"$go_output"
grep -q "WASM_HOST_RESOLVED_WEBC=$TMP_ROOT/go.webc" <<<"$go_output"
grep -q "WASM_HOST_RESOLVED_ARGS_JSON='\\[\"run\",\"/workspace/go/smoke.go\"\\]'" <<<"$go_output"

go_override_output="$(WASM_HOST_GO_WEBC="$TMP_ROOT/go.webc.gz" \
  WASM_HOST_GO_WEBC_SHA256="$go_sha" \
  WASM_HOST_GO_COMMAND=go-smoke \
  WASM_HOST_GO_ARGS='--mode smoke "value with spaces" --flag' \
  "$RESOLVER" \
  --manifest "$MANIFEST" \
  --language go \
  --tmp-root "$TMP_ROOT")"
grep -q "WASM_HOST_RESOLVED_AVAILABLE=1" <<<"$go_override_output"
grep -q "WASM_HOST_RESOLVED_COMMAND=go-smoke" <<<"$go_override_output"
grep -q "WASM_HOST_RESOLVED_ARGS_JSON='\\[\"--mode\",\"smoke\",\"value with spaces\",\"--flag\"\\]'" <<<"$go_override_output"

printf '<!doctype html>' > "$TMP_ROOT/bad.webc"
bad_log="$TMP_ROOT/bad.log"
if WASM_HOST_PYTHON_WEBC="$TMP_ROOT/bad.webc" "$RESOLVER" \
  --manifest "$MANIFEST" \
  --language python \
  --tmp-root "$TMP_ROOT" 2>"$bad_log"; then
  echo "resolver accepted invalid WebC magic" >&2
  exit 1
fi
grep -q "expected magic bytes \\\\0webc" "$bad_log"
grep -q "found <!doc" "$bad_log"

echo "fixture resolver tests passed"
