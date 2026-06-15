#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

cargo build --quiet --manifest-path "$ROOT/Cargo.toml" --bin wasm-host-runner --bin wasm-host-fixtures --locked

expected_version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/Cargo.toml" | head -n 1)"
version_output="$("$ROOT/target/debug/wasm-host-runner" --version)"
if [[ "$version_output" != "wasm-host-runner $expected_version" ]]; then
  echo "unexpected runner version output: $version_output" >&2
  exit 1
fi

printf '<!doctype html>' > "$TMP_ROOT/bad.webc"

set +e
"$ROOT/target/debug/wasm-host-runner" \
  --event-format json \
  --module-cache-dir "$TMP_ROOT/modules" \
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
assert started["module_cache_dir"].endswith("/modules")
assert failed["stage"] == "package"
assert failed["exit_code"] == 65
assert "expected magic bytes \\0webc" in failed["error"]
assert "found <!doc" in failed["error"]
PY

"$ROOT/target/debug/wasm-host-fixtures" stdout \
  --output "$TMP_ROOT/valid.webc" \
  --stdout "unused"

workspace="$TMP_ROOT/workspace"
mkdir -p "$workspace"
printf 'stdin-data' > "$TMP_ROOT/stdin.txt"

"$ROOT/target/debug/wasm-host-runner" \
  --webc "$TMP_ROOT/valid.webc" \
  --profile native-full \
  --package fixture \
  --mount "$workspace:/workspace:rw" \
  --cwd /workspace \
  --env PATH=/tools:/bin:/usr/bin \
  --stdin-file "$TMP_ROOT/stdin.txt" \
  --host-command /tools/host-sh=/bin/sh \
  -- host-sh \
  -c 'cat > host-command-output.txt; printf "arg=%s\n" "$1"; printf "host-stderr\n" >&2' \
  script-name \
  arg1 >"$TMP_ROOT/host-command-stdout" 2>"$TMP_ROOT/host-command-stderr"

if [[ "$(cat "$TMP_ROOT/host-command-stdout")" != "arg=arg1" ]]; then
  echo "unexpected host-command stdout" >&2
  cat "$TMP_ROOT/host-command-stdout" >&2
  exit 1
fi

if [[ "$(cat "$TMP_ROOT/host-command-stderr")" != "host-stderr" ]]; then
  echo "unexpected host-command stderr" >&2
  cat "$TMP_ROOT/host-command-stderr" >&2
  exit 1
fi

if [[ "$(cat "$workspace/host-command-output.txt")" != "stdin-data" ]]; then
  echo "host-command did not write stdin into the mounted workspace" >&2
  exit 1
fi

echo "runner harness tests passed"
