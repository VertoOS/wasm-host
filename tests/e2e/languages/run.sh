#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LANG_ROOT="$ROOT/tests/e2e/languages"
MANIFEST="$ROOT/packages/fixtures/languages/manifest.json"
RESOLVER="$ROOT/packages/fixtures/languages/resolve.py"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

require_python=false
require_go=false

usage() {
  cat <<'EOF'
Run language e2e tests through wasm-host-runner.

Usage:
  tests/e2e/languages/run.sh [--require-python] [--require-go] [--require-all]

Environment:
  WASM_HOST_RUNNER          Optional path to an existing wasm-host-runner binary.
  WASM_HOST_FIXTURE_CACHE_DIR
                            Optional cache directory for URL-backed fixtures.
  WASM_HOST_PYTHON_WEBC     Python WebC package path, .webc or .webc.gz.
  WASM_HOST_PYTHON_WEBC_URL Python WebC package URL, .webc or .webc.gz.
  WASM_HOST_PYTHON_WEBC_SHA256
                            Optional sha256 for the Python package input.
  WASM_HOST_PYTHON_COMMAND  Python command name, default from fixture manifest.
  WASM_HOST_PYTHON_ARGS     Python command args, shell-split.
  WASM_HOST_GO_WEBC         Go toolchain or fixture WebC package path, .webc or .webc.gz.
  WASM_HOST_GO_WEBC_URL     Go WebC package URL, .webc or .webc.gz.
  WASM_HOST_GO_WEBC_SHA256  Optional sha256 for the Go package input.
  WASM_HOST_GO_COMMAND      Go command name, default from fixture manifest.
  WASM_HOST_GO_ARGS         Go command args, default from fixture manifest.

Examples:
  WASM_HOST_PYTHON_WEBC=/path/to/python.webc tests/e2e/languages/run.sh --require-python
  WASM_HOST_GO_WEBC=/path/to/go.webc tests/e2e/languages/run.sh --require-go
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --require-python)
      require_python=true
      ;;
    --require-go)
      require_go=true
      ;;
    --require-all)
      require_python=true
      require_go=true
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ -n "${WASM_HOST_RUNNER:-}" ]]; then
  RUNNER=("$WASM_HOST_RUNNER")
else
  cargo build --quiet --manifest-path "$ROOT/Cargo.toml" --bin wasm-host-runner
  RUNNER=("$ROOT/target/debug/wasm-host-runner")
fi

run_package() {
  local webc="$1"
  local package="$2"
  shift 2

  "${RUNNER[@]}" \
    --webc "$webc" \
    --profile native-full \
    --package "$package" \
    --mount "$LANG_ROOT:/workspace:ro" \
    --cwd /workspace \
    --env HOME=/home/sandbox \
    --env TERM=xterm-256color \
    -- "$@"
}

json_args_to_array() {
  local json="$1"
  python3 - "$json" <<'PY'
import json
import sys

for arg in json.loads(sys.argv[1]):
    print(arg)
PY
}

run_language() {
  local language="$1"
  local required="$2"
  local resolved
  resolved="$("$RESOLVER" \
    --manifest "$MANIFEST" \
    --language "$language" \
    --tmp-root "$TMP_ROOT" \
    --optional)"
  eval "$resolved"

  if [[ "${WASM_HOST_RESOLVED_AVAILABLE:-0}" != "1" ]]; then
    if [[ "$required" == true ]]; then
      echo "$language e2e: ${WASM_HOST_RESOLVED_REASON:-fixture is not configured}" >&2
      exit 1
    fi
    echo "$language e2e: skipped; ${WASM_HOST_RESOLVED_REASON:-fixture is not configured}"
    return
  fi

  local args=()
  mapfile -t args < <(json_args_to_array "$WASM_HOST_RESOLVED_ARGS_JSON")

  local output
  ran_any=true
  echo "$language e2e: $WASM_HOST_RESOLVED_COMMAND ${args[*]}"
  output="$(run_package \
    "$WASM_HOST_RESOLVED_WEBC" \
    "$WASM_HOST_RESOLVED_PACKAGE" \
    "$WASM_HOST_RESOLVED_COMMAND" \
    "${args[@]}")"
  printf '%s\n' "$output"
  grep -q "$WASM_HOST_RESOLVED_MARKER" <<<"$output"
}

ran_any=false

run_language python "$require_python"
run_language go "$require_go"

if [[ "$ran_any" == false ]]; then
  echo "language e2e: no language packages configured"
fi
