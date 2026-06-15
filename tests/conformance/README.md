# Conformance Tests

Adapter-independent host behavior tests go here.

Run the current native conformance harness with:

```sh
tests/conformance/run.sh
```

The first conformance slice covers:

- virtual filesystem read/write/list behavior
- filesystem event emission
- read-only and writable host mounts
- virtual executable dispatch through the host bridge

These tests should eventually run against:

- native full profile
- native browser-strict profile
- browser adapter

The goal is to prove filesystem, stdio, terminal, process, networking, and
permission behavior without depending on one application.
