# Fixtures

Reusable source and packaged fixtures for conformance and e2e tests live here.

Large generated WebC/Wasm artifacts are not committed. Each fixture family owns a
small manifest that records the intended package source, version, sha256, command
surface, and cache/download settings. The first language manifest lives at
[`languages/manifest.json`](languages/manifest.json).

Pinned artifacts should be stored outside git, fetched by URL or supplied by a
local path, and verified with sha256 before the e2e harness is made required in
CI. Source fixtures should stay small and readable.
