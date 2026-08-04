# AGENTS.md

This file provides guidance to AI coding agents (e.g. Antigravity, Claude Code, Gemini CLI, Cursor, and similar tools) when working with code in this repository.

Rclone Manager welcomes AI-assisted contributions, but the expectation is that you, the human submitter, understand every line you propose and have compiled, linted, and tested it against real code — not just generated it. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

---

## Project Overview

`rclone-manager` is a cross-platform GUI and web server application for managing [Rclone](https://rclone.org).

- **Frontend**: Angular (v22+), TypeScript, SCSS, RxJS, Angular Material.
- **Backend**: Rust, Tauri v2 (`src-tauri`), `librclone` C-FFI / Go integration.

---

## General Notes & AI Guidelines

1. **Keep Changes Minimal & Elegant**: Work to make the smallest, most effective change possible. Avoid unneeded refactoring, re-ordering of imports, or restyling surrounding code.
2. **Backwards Compatibility**: PRs should preserve existing behavior across desktop, web server (headless), and mobile targets.
3. **Verify Before Proposing**: AI agents must run build, lint, and formatting verification commands before declaring success.

---

## Essential Code Quality & UI Rules

1. **Tooltip Usage Rule (CRITICAL)**
   - **DO NOT** use Angular Material Tooltips (`matTooltip`, `MatTooltipModule`).
   - **ALWAYS** use native HTML `title` attributes for tooltips (e.g., `<button title="Refresh list">...</button>`).

2. **Angular Architecture**
   - Follow existing service and component patterns.
   - Use `inject()` for dependency injection where applicable.
   - Keep translation keys organized and run `npm run audit:i18n` when adding user-facing text.

3. **Angular Material**
   - Do not use `outline` versions of the material form components (inputs, selects, textareas).

---

## CI & Automated Workflows ([.github/workflows/](.github/workflows/))

All changes proposed by AI agents must pass the checks enforced by our GitHub Actions workflows:

- **[.github/workflows/ci.yml](.github/workflows/ci.yml)**: Continuous Integration pipeline verifying TypeScript/Angular lints, Prettier formatting, and Rust Clippy compilation across all target features.
- **[.github/workflows/docker-build-push.yml](.github/workflows/docker-build-push.yml)**: Multi-architecture Docker container build for headless web-server deployment.
- **[.github/workflows/release-\*.yml](.github/workflows/)**: Cross-platform release workflows (Linux, Windows, macOS, Android, Portable, Headless).

---

## Build, Test & Lint Commands

The commands below mirror the exact validation checks executed in [.github/workflows/ci.yml](.github/workflows/ci.yml).

### 1. Frontend (Angular / TypeScript)

```bash
# Lint TypeScript and HTML files
npx eslint "**/*.{ts,html}"

# Check Prettier formatting
npx prettier --check "**/*.{ts,html,scss,json}"

# Format frontend code
npx prettier --write "**/*.{ts,html,scss,json}"

# Auto-fix lint & formatting issues across project
npm run fix:all
```

### 2. Backend (Rust / Tauri)

All Cargo commands are executed from the `src-tauri` directory.

> **Note on `LIBRCLONE_SKIP_LINK_CHECK`**:
> When `librclone.a` / Go toolchain is not compiled locally, set `export LIBRCLONE_SKIP_LINK_CHECK=1` so Clippy can type-check Rust without linking errors.

```bash
# 1. Clippy check - Desktop target
cd src-tauri && cargo clippy --features desktop --no-default-features -- -D warnings

# 2. Clippy check - Web Server target
mkdir -p dist/rclone-manager/browser
cd src-tauri && TAURI_CONFIG=$(cat ./tauri.conf.headless.json) cargo clippy --features web-server --no-default-features -- -D warnings

# 3. Clippy check - Mobile target
cd src-tauri && cargo clippy --features mobile --no-default-features -- -D warnings

# 4. Rust formatting check
cd src-tauri && cargo fmt -- --check
```

### 3. Local Development

```bash
# Launch Tauri dev server
npm run tauri dev

# Feature-specific dev modes
npm run dev:portable
npm run dev:headless
```

---

## Utility Scripts

- `npm run sync:endpoints`: Update endpoint definitions from rclone schemas.
- `npm run sync:providers`: Sync rclone provider configurations.
- `npm run sync:flags`: Sync rclone CLI flag definitions.
- `npm run audit:i18n`: Verify missing translation keys.
