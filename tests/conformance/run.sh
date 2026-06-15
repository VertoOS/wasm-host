#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROFILE="all"

usage() {
  cat <<'USAGE'
Usage: tests/conformance/run.sh [--profile browser-strict|native-full|all]

Runs the host conformance tests against one runtime profile or both profiles.
The default is --profile all.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      if [[ $# -lt 2 ]]; then
        echo "missing value for --profile" >&2
        usage >&2
        exit 2
      fi
      PROFILE="$2"
      shift 2
      ;;
    --profile=*)
      PROFILE="${1#--profile=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

run_profile() {
  local profile="$1"
  echo "Running conformance profile: $profile"
  WASM_HOST_CONFORMANCE_PROFILE="$profile" cargo test \
    --manifest-path "$ROOT/Cargo.toml" \
    -p wasm-host-core \
    --test conformance \
    --locked
}

case "$PROFILE" in
  browser-strict | native-full)
    run_profile "$PROFILE"
    ;;
  all)
    run_profile browser-strict
    run_profile native-full
    ;;
  *)
    echo "unknown profile: $PROFILE" >&2
    usage >&2
    exit 2
    ;;
esac
