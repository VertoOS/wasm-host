# Conformance Tests

Adapter-independent host behavior tests go here.

Run the current native conformance harness with:

```sh
tests/conformance/run.sh
```

The harness defaults to both supported host profiles:

```sh
tests/conformance/run.sh --profile all
tests/conformance/run.sh --profile browser-strict
tests/conformance/run.sh --profile native-full
```

The core runtime defaults to the `browser-strict` profile. Profile-neutral tests
run under whichever profile the harness selects. Tests that require native-only
host mounts run only under `native-full`; tests that prove browser-safe mount
rejection run only under `browser-strict`.

The first conformance slice covers:

- virtual filesystem read/write/list/rename/delete behavior
- directory creation and removal
- symlink creation and readlink behavior
- filesystem event emission for create/modify/rename/delete
- read-only and writable host mounts
- virtual executable dispatch through the host bridge
- virtual process exit-code/stderr propagation
- process stdout/stderr streaming while preserving captured output, including
  host-backed virtual process output chunks before final response
- virtual process stdout/stderr output limits
- virtual process wall-time timeout and external cancellation
- HTTP bridge request/response normalization, response body chunks, clean
  errors, response limits, and cancellation delivery

These tests should eventually run against:

- native browser-strict profile
- native full profile
- browser adapter

The goal is to prove filesystem, stdio, terminal, process, networking, and
permission behavior without depending on one application.
