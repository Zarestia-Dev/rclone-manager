# Common development tasks

set working-directory := "."

just := just_executable()

docs_cmd := if os_family() == "windows" {
	"set RUSTDOCFLAGS=--cfg docsrs && cargo doc --all-features --no-deps"
} else {
	"RUSTDOCFLAGS=\"--cfg docsrs\" cargo doc --all-features --no-deps"
}

fmt:
	cargo fmt --all -- --check

clippy:
	cargo clippy --all-targets --all-features -- -D warnings

check:
	cargo check --all --all-features

pedantic:
	cargo clippy --all-features -- -W clippy::pedantic

test:
	cargo test --all --all-features

# Run all tests including ignored (requires Secret Service daemon for keychain tests)
# Uses --tests to skip doctests (which are intentionally incomplete examples)
test-all:
	cargo test --all-features --tests -- --include-ignored

docs:
	{{docs_cmd}}

deny:
	cargo deny check

deny-ci:
	cargo deny check licenses bans

deny-install:
	cargo install cargo-deny --locked

# -----------------------------------------------------------------------------
# CI parity (native execution, matching .github/workflows/ci.yml)
# -----------------------------------------------------------------------------

# Ubuntu-latest CI job behavior
ci-ubuntu:
	{{just}} fmt
	{{just}} clippy
	cargo test --all --all-features --quiet
	{{just}} deny-ci
	{{just}} docs
	cargo clippy --features full -- -W clippy::pedantic

# Windows-latest CI job behavior
ci-windows:
	{{just}} clippy
	cargo test --all --all-features --quiet

# macOS-latest CI job behavior
ci-macos:
	{{just}} clippy
	cargo test --all --all-features --quiet

# -----------------------------------------------------------------------------
# Linux cross-platform preflight (compile/lint only for non-native targets)
# -----------------------------------------------------------------------------

ci-windows-cross:
	rustup target add x86_64-pc-windows-gnu
	cargo check --all --all-features --target x86_64-pc-windows-gnu
	cargo clippy --all-features --target x86_64-pc-windows-gnu -- -D warnings

ci-macos-cross:
	rustup target add x86_64-apple-darwin aarch64-apple-darwin
	cargo check --all --all-features --target x86_64-apple-darwin
	cargo check --all --all-features --target aarch64-apple-darwin
	cargo clippy --all-features --target x86_64-apple-darwin -- -D warnings
	cargo clippy --all-features --target aarch64-apple-darwin -- -D warnings

ci-android-cross:
	rustup target add aarch64-linux-android
	cargo check --all --all-features --target aarch64-linux-android
	cargo clippy --all-features --target aarch64-linux-android -- -D warnings

ci-ios-cross:
    rustup target add aarch64-apple-ios
    cargo check --all --all-features --target aarch64-apple-ios
    cargo clippy --all-features --target aarch64-apple-ios -- -D warnings

# Full local preflight on Linux: Ubuntu-native gates + cross-target smoke
ci-local:
	{{just}} ci-ubuntu
	{{just}} ci-windows-cross
	{{just}} ci-macos-cross
	{{just}} ci-android-cross
	{{just}} ci-ios-cross
