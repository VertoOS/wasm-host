# Python Binding

Python package work lives here during the monorepo phase.

The binding should stay thin over the host contract. It should not grow a
separate runtime model from the Rust core.

Initial implementation should call the C ABI in `bindings/c` and wrap its owned
result handles in Python objects/context managers.

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
    ),
    library,
)

print(result.returncode)
print(result.stdout.decode())
```

On macOS, use `target/debug/libwasm_host_c_api.dylib`.
