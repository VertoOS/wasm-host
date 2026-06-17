# Browser Tool Protocol

Protocol-neutral helpers for browser-safe tool adapters.

This package sits below high-level integrations. Service-specific and
runtime-specific adapters should translate into this contract from separate
packages rather than becoming first-class `apps/web` modules.

Current scope:

- validate browser tool descriptors with optional namespaces
- register and list deterministic browser-safe tools
- call tools with call ids, turn ids, JSON arguments, and runtime-local
  `AbortSignal` cancellation
- normalize text/json/image content items and structured success/error results
- enforce bounded, JSON-serializable arguments and outputs

It does not implement service traffic, auth flows, or native local-process
launch.
