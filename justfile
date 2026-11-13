# Thin task runner over the commands CI runs (.github/workflows/ci.yml, AGENTS.md).
# It holds no logic of its own: every recipe calls the npm / cargo commands directly.
#
#   just          list the recipes
#   just ci       everything CI checks
#   just rust     only the backend checks

set shell := ["bash", "-euo", "pipefail", "-c"]

# Clippy cannot link without a compiled librclone.a; override with =0 when it is built.
export LIBRCLONE_SKIP_LINK_CHECK := env("LIBRCLONE_SKIP_LINK_CHECK", "1")

manifest := "backend/Cargo.toml"

default:
    @just --list

# Everything CI checks.
ci: frontend rust scripts

# Frontend: warning-free build, lint, formatting, unit tests.
frontend:
    ng build
    npx eslint "**/*.{ts,html}"
    npx prettier --check "**/*.{ts,html,scss,json}"
    npm run test:ci

# Backend: clippy for every target, formatting, unit tests.
rust: clippy rust-fmt rust-test

clippy:
    for features in desktop desktop,tray portable; do \
      cargo clippy --manifest-path {{manifest}} -p rclone-manager --features "$features" --no-default-features -- -D warnings; \
    done
    mkdir -p dist/rclone-manager/browser
    cargo clippy --manifest-path {{manifest}} -p rclone-manager-server -- -D warnings
    cargo clippy --manifest-path {{manifest}} -p rclone-manager --features mobile --no-default-features -- -D warnings

rust-fmt:
    cargo fmt --manifest-path {{manifest}} --all -- --check

rust-test:
    cargo test --manifest-path {{manifest}} -p rclone-manager-core --features desktop --lib
    for features in desktop desktop,tray,tauri-test; do \
      cargo test --manifest-path {{manifest}} -p rclone-manager --features "$features" --no-default-features --lib -- --test-threads=1; \
    done
    cargo test --manifest-path {{manifest}} -p rclone-manager-core --features updater --lib services::updates -- --test-threads=1

# Release metadata and update manifest tests.
scripts:
    node --test scripts/create-update-manifest.test.cjs scripts/publish-custom-updater.test.cjs scripts/release-version.test.cjs
