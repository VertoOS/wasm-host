# Go Binding

Go binding work lives here during the monorepo phase.

Before release, this may split into a dedicated Go module repo if import paths
and version tags need to be independent from the core runtime repo.

Initial implementation should call the C ABI in `bindings/c` through cgo and
keep Go types as thin wrappers over the shared host contract.
