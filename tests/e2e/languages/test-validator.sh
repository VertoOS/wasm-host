#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
VALIDATOR="$ROOT/tests/e2e/languages/validate_output.py"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

python3 -m py_compile "$VALIDATOR"

python3 "$VALIDATOR" \
  --language python \
  --marker PYTHON_E2E_OK \
  --args-json '["/workspace/python/smoke.py"]' <<'JSON'
{"argv":[],"cwd":"/workspace","marker":"PYTHON_E2E_OK","tmp":"python wrote this","version":[3,12,1]}
JSON

python3 "$VALIDATOR" \
  --language go \
  --marker GO_E2E_OK \
  --args-json '["run","/workspace/go/smoke.go","arg1"]' <<'JSON'
{"args":["arg1"],"cwd":"/workspace","go":"go1.22.0","marker":"GO_E2E_OK","targets":"wasip1/wasm","tmp":"go wrote this\n"}
JSON

bad_log="$TMP_ROOT/bad.log"
if python3 "$VALIDATOR" \
  --language python \
  --marker PYTHON_E2E_OK \
  --args-json '["/workspace/python/smoke.py"]' 2>"$bad_log" <<'JSON'
{"argv":[],"cwd":"/host","marker":"PYTHON_E2E_OK","tmp":"python wrote this","version":[3,12,1]}
JSON
then
  echo "validator accepted a payload with the wrong cwd" >&2
  exit 1
fi
grep -q "expected cwd '/workspace', got '/host'" "$bad_log"

echo "language validator tests passed"
