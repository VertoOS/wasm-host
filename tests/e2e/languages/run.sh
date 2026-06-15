#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LANG_ROOT="$ROOT/tests/e2e/languages"
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
  WASM_HOST_PYTHON_WEBC     Python WebC package path, .webc or .webc.gz.
  WASM_HOST_PYTHON_COMMAND  Python command name, default: python.
  WASM_HOST_GO_WEBC         Go toolchain or fixture WebC package path, .webc or .webc.gz.
  WASM_HOST_GO_COMMAND      Go command name, default: go.
  WASM_HOST_GO_ARGS         Go command args, default: run /workspace/go/smoke.go.

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

resolve_webc() {
  local input="$1"
  local name="$2"
  if [[ ! -s "$input" ]]; then
    echo "missing WebC package: $input" >&2
    exit 1
  fi

  case "$input" in
    *.webc.gz)
      local output="$TMP_ROOT/$name.webc"
      gzip -dc "$input" > "$output"
      printf '%s\n' "$output"
      ;;
    *)
      printf '%s\n' "$input"
      ;;
  esac
}

run_package() {
  local webc="$1"
  local package="$2"
  shift 2

  "${RUNNER[@]}" \
    --webc "$webc" \
    --package "$package" \
    --mount "$LANG_ROOT:/workspace:ro" \
    --cwd /workspace \
    --env HOME=/home/sandbox \
    --env TERM=xterm-256color \
    -- "$@"
}

ran_any=false

if [[ -n "${WASM_HOST_PYTHON_WEBC:-}" ]]; then
  ran_any=true
  python_webc="$(resolve_webc "$WASM_HOST_PYTHON_WEBC" python)"
  python_command="${WASM_HOST_PYTHON_COMMAND:-python}"
  echo "python e2e: $python_command /workspace/python/smoke.py"
  python_output="$(run_package "$python_webc" python "$python_command" /workspace/python/smoke.py)"
  printf '%s\n' "$python_output"
  grep -q "PYTHON_E2E_OK" <<<"$python_output"
else
  if [[ "$require_python" == true ]]; then
    echo "WASM_HOST_PYTHON_WEBC is required for Python e2e" >&2
    exit 1
  fi
  echo "python e2e: skipped; set WASM_HOST_PYTHON_WEBC to enable"
fi

if [[ -n "${WASM_HOST_GO_WEBC:-}" ]]; then
  ran_any=true
  go_webc="$(resolve_webc "$WASM_HOST_GO_WEBC" go)"
  go_command="${WASM_HOST_GO_COMMAND:-go}"
  if [[ "${WASM_HOST_GO_ARGS+x}" ]]; then
    read -r -a go_args <<<"${WASM_HOST_GO_ARGS}"
  else
    go_args=(run /workspace/go/smoke.go)
  fi

  echo "go e2e: $go_command ${go_args[*]}"
  go_output="$(run_package "$go_webc" go "$go_command" "${go_args[@]}")"
  printf '%s\n' "$go_output"
  grep -q "GO_E2E_OK" <<<"$go_output"
else
  if [[ "$require_go" == true ]]; then
    echo "WASM_HOST_GO_WEBC is required for Go e2e" >&2
    exit 1
  fi
  echo "go e2e: skipped; set WASM_HOST_GO_WEBC to enable"
fi

if [[ "$ran_any" == false ]]; then
  echo "language e2e: no language packages configured"
fi
