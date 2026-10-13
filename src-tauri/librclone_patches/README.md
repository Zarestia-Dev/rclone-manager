# librclone Go Patches

This directory contains modular Go patches and custom RC commands compiled into `librclone`.

## Structure

Each patch is written in `package main` in a separate `.go` file. Each patch file can include its own `init()` function to register RC endpoints or setup custom behaviors.

- `*_patch.go`: Patch implementations compiled into `librclone`.
- `*_patch_test.go`: Unit tests for the patches.
- `go.mod`: Module definition pointing to local `rclone` source for testing.

## Adding a New Patch

1. Create a new file `<feature>_patch.go` in `package main`.
2. Add your custom logic, functions, and an `init()` block registering any RC endpoints with `rc.Add(...)`.
3. Optionally add `<feature>_patch_test.go` to test your patch logic.

## Running Tests

Run all patch unit tests directly from this directory:

```bash
go test -v ./...
```
