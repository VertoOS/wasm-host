# Go Binding

Go binding work lives here during the monorepo phase.

Before release, this may split into a dedicated Go module repo if import paths
and version tags need to be independent from the core runtime repo.

Initial implementation should call the C ABI in `bindings/c` through cgo and
keep Go types as thin wrappers over the shared host contract.

## Usage

Build the C ABI library first:

```sh
cargo build -p wasm-host-c-api --locked
```

Then use the Go package:

```go
package main

import (
	"fmt"

	wasmhost "github.com/VertoOS/wasm-host/bindings/go"
)

func main() {
	result, err := wasmhost.Run(wasmhost.Options{
		WebC:    "/path/to/package.webc",
		Command: []string{"package-command", "--version"},
	})
	if err != nil {
		panic(err)
	}

	fmt.Println(result.ReturnCode)
	fmt.Println(string(result.Stdout))
}
```

The dynamic library must be available on the platform library path at runtime.
