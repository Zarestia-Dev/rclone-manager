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
3. **Verify Before Proposing**: AI agents must run build, lint, and formatting verification commands before declaring success. **Frontend changes must produce a warning-free build** (see §Build, Test & Lint Commands).
4. **Automated Testing & Test Coverage (CRITICAL)**:
   - Just like upstream Rclone and best practices, whenever adding or refactoring business logic, services, utilities, parsers, or mappings, AI agents **MUST** write or update accompanying automated unit tests.
   - **Frontend**: Unit tests (`*.spec.ts`) are placed in the same directory alongside their corresponding implementation files.
   - **Backend**: Rust unit tests (`#[cfg(test)]`) are placed inside source files or under test modules.
   - Verify tests cover both normal operation and edge cases (null inputs, empty values, special characters, error paths).

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
   - Do not use `appearence` in the material form components (inputs, selects, textareas). Use them as default.

4. **URL Opener Links (CRITICAL)**
   - **ALWAYS** use standard HTML `<a>` tags with `href` attributes for opening URLs (e.g., `<a href="https://..." target="_blank" rel="noopener noreferrer">...</a>` or `<a matButton="filled" [href]="url" target="_blank">...</a>`).
   - **DO NOT** use `<button>` elements or click handlers to open external web links. `OpenerService` runs a global link interceptor that captures all `<a>` tags with external protocols (http/https/mailto) and opens them safely in the default system browser or new tab.

5. **Menu Component Usage Rule (CRITICAL)**
   - **DO NOT** use Angular Material Menus (`mat-menu`, `MatMenuModule`, `matMenuTriggerFor`).
   - **ALWAYS** use CDK Menu (`@angular/cdk/menu`, `CdkMenuModule`, `[cdkMenuTriggerFor]`, `cdkMenu`, `cdkMenuItem`) styled with `.material-context-menu` and `.menu-item` classes.

6. **Internationalization & Backend Error Architecture (CRITICAL)**
   - **Unified Resource Directory**: All translation files reside in `resources/i18n/{lang}/` (`main.json`, `rclone.json`, `rclone-providers.json`). Do not split or duplicate translation files across other directories.
   - **Frontend Static Asset Serving**: Angular loads translations via `MultiFileLoader` from static assets (`assets/i18n/...` mapped in `angular.json`).
   - **Backend Minimal Memory Footprint**: The Rust backend (`src-tauri/src/utils/i18n.rs`) only reads `main.json` and caches only keys needed for OS integrations (`tray`, `notification`, `powerInhibitor`, `alerts`).
   - **Language-Agnostic Backend Errors**: Rust code must **never** pre-translate error messages. Always use `localized_error!("backendErrors.<category>.<key>", ...)` or `localized_success!("backendSuccess.<category>.<key>", ...)`, producing structured `{ key, params }` JSON or raw keys for `BackendTranslationService` on the frontend.

7. **Platform & Tauri Target Abstraction (CRITICAL)**
   - **TauriBaseService & `this.isTauri`**:
     - All backend-communicating services should extend `TauriBaseService`.
     - Inside classes extending `TauriBaseService`, **always** use the inherited `this.isTauri` property (`!isHeadlessMode()`) rather than re-importing or calling `isHeadlessMode()`.
     - In standalone components/functions where inheritance is not used, import and call `isHeadlessMode()` from `api-client.service`.
     - **NEVER** use redundant double-checks like `!this.isTauri || isHeadlessMode()` or call native Tauri APIs without guarding with `this.isTauri`.

8. **Automated Unit Testing & Spec Maintenance**
   - New utility functions, data transformers, flag parsers, state machines, and business services should always have corresponding unit test suites.
   - Ensure tests cover both happy paths and edge cases (e.g. empty strings, null values, invalid inputs, error handling).

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
# Build the frontend — must complete with ZERO warnings
ng build

# Lint TypeScript and HTML files
npx eslint "**/*.{ts,html}"

# Check Prettier formatting
npx prettier --check "**/*.{ts,html,scss,json}"

# Format frontend code
npx prettier --write "**/*.{ts,html,scss,json}"

# Auto-fix lint & formatting issues across project
npm run fix:all

# Run frontend unit tests
npm run test:ci
```

> **Frontend Build Rule (CRITICAL)**:
> After any frontend change, run `ng build` and verify the output contains **no warnings**.
> Warnings (e.g., unused imports, deprecated APIs, template binding issues) must be treated as build failures and fixed before declaring the task complete.

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

# 5. Run backend unit tests
cd src-tauri && cargo test --features desktop --no-default-features
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
