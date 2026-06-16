# Go Binding

Go binding work lives here during the monorepo phase.

The module path is `github.com/VertoOS/wasm-host/bindings/go`. Before release,
this may split into a dedicated Go module repo if import paths, version tags,
or native release artifacts need to be independent from the core runtime repo.

The implementation calls the C ABI in `bindings/c` through cgo and keeps Go
types as thin wrappers over the shared host contract.

`ABIVersion` is the Go package's compiled-against C ABI version.
`LinkedABIVersion()` returns the version exported by the linked native library
so callers can detect mismatched artifacts.

See [`../README.md`](../README.md) for binding distribution and future split
criteria.

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
		WebC:           "/path/to/package.webc",
		Command:        []string{"package-command", "--version"},
		ModuleCacheDir: "/tmp/wasm-host-modules",
	})
	if err != nil {
		panic(err)
	}

	fmt.Println(result.ReturnCode)
	fmt.Println(string(result.Stdout))
}
```

The dynamic library must be available on the platform library path at runtime.

Packages that use the HTTP bridge device can opt into the native bridge during
terminal testing, or route through a local gateway endpoint:

```go
_, err := wasmhost.Run(wasmhost.Options{
	WebC:       "/path/to/package.webc",
	Command:    []string{"package-command"},
	HTTPBridge: "native",
})

_, err = wasmhost.Run(wasmhost.Options{
	WebC:       "/path/to/package.webc",
	Command:    []string{"package-command"},
	HTTPBridge: "gateway=http://127.0.0.1:8787/bridge",
})
```

Native host commands can be exposed for terminal e2e tests through the
`native-full` profile:

```go
_, err := wasmhost.Run(wasmhost.Options{
	WebC:    "/path/to/package.webc",
	Profile: "native-full",
	Command: []string{"host-sh", "-c", "pwd"},
	CWD:     "/workspace",
	Mounts: []wasmhost.Mount{
		wasmhost.ReadWriteMount("/host/project", "/workspace"),
	},
	HostCommands: []wasmhost.HostCommand{
		{GuestPath: "/tools/host-sh", HostCommand: "/bin/sh"},
	},
	Env: map[string]string{"PATH": "/tools:/bin:/usr/bin"},
})
```
