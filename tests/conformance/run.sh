#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cargo test \
  --manifest-path "$ROOT/Cargo.toml" \
  -p wasm-host-core \
  --test conformance \
  --locked
