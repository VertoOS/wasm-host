# Python Binding

Python package work lives here during the monorepo phase.

The binding should stay thin over the host contract. It should not grow a
separate runtime model from the Rust core.

Initial implementation should call the C ABI in `bindings/c` and wrap its owned
result handles in Python objects/context managers.
