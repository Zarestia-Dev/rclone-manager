# Contributing to rcman

Thanks for considering contributing! This project aims to provide a robust, well-documented configuration manager for Rust applications.

## Workflow

1. Fork and create a feature branch.
2. Make focused changes with clear commit messages.
3. Ensure tests and lints pass locally.
4. Open a PR with a concise summary and rationale.

### Toolchain & MSRV

- Minimum Supported Rust Version (MSRV): 1.88 (declared in `Cargo.toml`).
- A `rust-toolchain.toml` pins the local channel to `stable` and installs `rustfmt` + `clippy`.

## Local Checks

Run these before pushing:

```bash
cargo fmt --all
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all --all-features
cargo clippy --all-features -- -W clippy::pedantic
```

### Pre-commit Hook (auto-run clippy)

Enable a git hook that runs clippy before every commit:

```bash
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit
```

The hook runs `cargo clippy --all-targets --all-features -- -D warnings` and blocks commits on warnings.

## CI

- GitHub Actions runs format check, clippy (warnings = errors), tests.
- `cargo deny` checks licenses/advisories/duplicates.
- Docs are built with `RUSTDOCFLAGS=--cfg docsrs`.

## Helpful Tasks (just)

If you have `just` installed, common tasks are available:

```bash
just fmt
just clippy
just pedantic
just test
just docs
just deny
```

## Coding Guidelines

- Prefer returning `Result<T, Error>` over panicking.
- Avoid `unwrap()` in library code; handle lock poisoning by recovering guards.
- Keep functions small and focused; avoid unnecessary generics.
- Public APIs must have rustdoc comments and examples.
- Use `thiserror` to model error variants with helpful messages.

## Documentation

- Keep README focused on the most common tasks.
- Add doctests to public functions and modules when practical.
- Use feature-gated docs with `#[cfg_attr(docsrs, doc(cfg(feature = "...")))]` for optional features.

## Tests

- Write unit tests close to the code they cover.
- Favor integration tests for cross-module workflows (see `tests/`).
- In examples/tests, `unwrap()` is acceptable; in library code, prefer graceful errors.

## Changelog

- Update `CHANGELOG.md` under `[Unreleased]` for user-visible changes.
- Follow Keep a Changelog format.
