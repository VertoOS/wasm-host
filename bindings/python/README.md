# Python Binding

Python package work lives here during the monorepo phase.

The binding should stay thin over the host contract. It should not grow a
separate runtime model from the Rust core.

The package metadata lives in `pyproject.toml` and publishes the `wasm_host`
import package. During local development, the wrapper loads the C ABI shared
library through `WASM_HOST_LIBRARY` or an explicit path.

See [`../README.md`](../README.md) for binding distribution and future split
criteria.

## Usage

Build the C ABI library first:

```sh
cargo build -p wasm-host-c-api --locked
```

Then point the binding at the shared library:

```python
from wasm_host import RunOptions, load_library, run

library = load_library("target/debug/libwasm_host_c_api.so")
result = run(
    RunOptions(
        webc="/path/to/package.webc",
        command=["package-command", "--version"],
        module_cache_dir="/tmp/wasm-host-modules",
    ),
    library,
)

print(result.returncode)
print(result.stdout.decode())
```

On macOS, use `target/debug/libwasm_host_c_api.dylib`.

Packages that use the HTTP bridge device can opt into the native bridge during
terminal testing, or route through a local gateway endpoint:

```python
RunOptions(
    webc="/path/to/package.webc",
    command=["package-command"],
    http_bridge="native",
)

RunOptions(
    webc="/path/to/package.webc",
    command=["package-command"],
    http_bridge="gateway=http://127.0.0.1:8787/bridge",
)
```

Native host commands can be exposed for terminal e2e tests through the
`native-full` profile:

```python
from wasm_host import HostCommand, Mount, RunOptions

RunOptions(
    webc="/path/to/package.webc",
    profile="native-full",
    command=["host-sh", "-c", "pwd"],
    cwd="/workspace",
    mounts=[Mount(source="/host/project", target="/workspace", read_only=False)],
    host_commands=[HostCommand(guest_path="/tools/host-sh", host_command="/bin/sh")],
    env={"PATH": "/tools:/bin:/usr/bin"},
)
```
