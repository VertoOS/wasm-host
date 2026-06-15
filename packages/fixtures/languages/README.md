# Language Fixtures

Language fixtures verify that code runs inside the host, not on the developer's
machine.

Initial fixture targets:

- Python: run `python /workspace/python/smoke.py` inside a Python WebC package.
- Go: run `go run /workspace/go/smoke.go` inside a Go toolchain WebC package, or
  run a prebuilt Go fixture command from a WebC package.
