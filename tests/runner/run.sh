#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

cargo build --quiet --manifest-path "$ROOT/Cargo.toml" --bin wasm-host-runner --locked

printf '<!doctype html>' > "$TMP_ROOT/bad.webc"

set +e
"$ROOT/target/debug/wasm-host-runner" \
  --event-format json \
  --webc "$TMP_ROOT/bad.webc" \
  -- tool >"$TMP_ROOT/stdout" 2>"$TMP_ROOT/stderr"
status="$?"
set -e

if [[ "$status" -ne 65 ]]; then
  echo "expected invalid package exit 65, got $status" >&2
  exit 1
fi

if [[ -s "$TMP_ROOT/stdout" ]]; then
  echo "expected no stdout for invalid package" >&2
  exit 1
fi

python3 - "$TMP_ROOT/stderr" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    events = [json.loads(line) for line in handle if line.strip()]

assert [event["event"] for event in events] == ["runner.started", "runner.failed"]
started, failed = events
assert started["schema"] == 1
assert started["env_keys"] == []
assert started["argc"] == 1
assert failed["stage"] == "package"
assert failed["exit_code"] == 65
assert "expected magic bytes \\0webc" in failed["error"]
assert "found <!doc" in failed["error"]
PY

echo "runner harness tests passed"
