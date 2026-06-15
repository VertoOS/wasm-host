# Conformance Tests

Adapter-independent host behavior tests go here.

Run the current native conformance harness with:

```sh
tests/conformance/run.sh
```

The first conformance slice covers:

- virtual filesystem read/write/list/rename/delete behavior
- directory creation and removal
- symlink creation and readlink behavior
- filesystem event emission for create/modify/rename/delete
- read-only and writable host mounts
- virtual executable dispatch through the host bridge
- virtual process exit-code/stderr propagation
- virtual process wall-time timeout and external cancellation

These tests should eventually run against:

- native full profile
- native browser-strict profile
- browser adapter

The goal is to prove filesystem, stdio, terminal, process, networking, and
permission behavior without depending on one application.
