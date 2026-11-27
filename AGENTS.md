# AGENTS.md

This file provides guidance to AI coding agents (e.g. Antigravity, Claude Code, Gemini CLI, Cursor, and similar tools) when working with code in this repository.

RClone Manager welcomes AI-assisted contributions, but the expectation is that you, the human submitter, understand every line you propose and have compiled, linted, and tested it against real code — not just generated it. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

---

## Project Overview

`rclone-manager` is a cross-platform GUI and web server application for managing [Rclone](https://rclone.org).

- **Frontend**: Angular (v22+), TypeScript, SCSS, RxJS, Angular Material.
- **Backend**: Rust, Tauri v2 (`backend/desktop`), `librclone` C-FFI / Go integration.

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
   - **Backend Minimal Memory Footprint**: The Rust backend (`backend/core/src/utils/i18n.rs`) only reads `main.json` and caches only keys needed for OS integrations (`tray`, `notification`, `powerInhibitor`, `alerts`, `backendErrors`).
   - **Language-Agnostic Backend Errors**: Rust code must **never** pre-translate error messages. Always use `localized_error!("backendErrors.<category>.<key>", ...)` or `localized_success!("backendSuccess.<category>.<key>", ...)`, producing structured `{ key, params }` JSON or raw keys for `BackendTranslationService` on the frontend.
   - **Every user-visible string is a key**: this includes command results (`UpdateResult.message`), notification parameters and the failure text the update helper leaves behind. Do not return hard-coded English from Rust, and add each new key to **every** language directory under `resources/i18n/` (`npm run audit:i18n` must report no missing keys).
   - **Plurals**: Never build a plural with a `{{s}}` suffix parameter, `(s)` or a `count === 1 ? 'a' : 'b'` choice of two keys. A string that counts things is a plural object, `{ "one": "{{count}} file", "other": "{{count}} files" }`, with the forms of each language (`Intl.PluralRules`: Slovak also needs `few`, Russian and Ukrainian `few` and `many`, Japanese and Chinese only `other`) and every placeholder of the English text in every form. The number is always the `count` parameter: `'key' | translate: { count: n }` and `translate.instant('key', { count: n })` pick the form (`PluralCompiler` in `src/app/services/i18n/plural.ts`, registered in `app.config.ts`). Do not pass the number under another name. Texts the Rust backend translates itself (`tray`, `powerInhibitor`, `notification`, `backendErrors`) have no plural support: write them as `Label: {{count}}`, and so for a string that takes a type or a list instead of a number. `npm run audit:i18n` reports a language that lacks a form or drops a placeholder, a plural group without `{{count}}` in its English text, and a plural group inside a section Rust translates.
   - **Native-speaker review of every new or changed string (CRITICAL)**: `npm run audit:i18n` only checks keys, plural forms and placeholders; it cannot tell whether a sentence reads well. Whenever you add or change a translation key, read the text of **every language** again as a native speaker would, and fix it before handing over:
     - **Use the words the app already uses.** A name the user will look for in the UI (a tab, a menu entry, a button, a path such as `Flow › Quick Runs`) must be exactly what that language's own `main.json` shows for it (for example `flow.tabs.quickRun`), never the English product name left in place and never a new word of your own. Search the language's file for the term before you write it.
     - Read for repeated words, wrong case, gender, tense or politeness level, literal translations of English idioms (`by` that means an agent, `in` that means a medium), unnatural pronouns in languages that drop them, and the quotation marks of that language.
     - Check that every language ends up saying the same thing as the English text, including the limits ("only while the app is open", "nothing is deleted").
     - In the hand-off, say which languages were reviewed this way. A model's review is a second reading, not a replacement for a human native speaker; flag any wording you are unsure about.

7. **Platform & Tauri Target Abstraction (CRITICAL)**
   - **TauriBaseService & `this.isTauri`**:
     - All backend-communicating services should extend `TauriBaseService`.
     - Inside classes extending `TauriBaseService`, **always** use the inherited `this.isTauri` property (`!isHeadlessMode()`) rather than re-importing or calling `isHeadlessMode()`.
     - In standalone components/functions where inheritance is not used, import and call `isHeadlessMode()` from `api-client.service`.
     - **NEVER** use redundant double-checks like `!this.isTauri || isHeadlessMode()` or call native Tauri APIs without guarding with `this.isTauri`.

8. **Automated Unit Testing & Spec Maintenance**
   - New utility functions, data transformers, flag parsers, state machines, and business services should always have corresponding unit test suites.
   - Ensure tests cover both happy paths and edge cases (e.g. empty strings, null values, invalid inputs, error handling).

9. **Unique ID Generation & Non-Secure HTTP Compatibility (CRITICAL)**
   - **DO NOT** use `crypto.randomUUID()` or Web Crypto APIs directly in frontend code. They are restricted to secure contexts (HTTPS/localhost) by modern browsers and are `undefined` over plain HTTP (e.g., remote IP headless web server access), causing `TypeError: crypto.randomUUID is not a function` and blank screens.
   - **ALWAYS** use `generatePrefixedId(prefix)` from `src/app/shared/utils` for generating unique IDs, request tokens, temporary keys, or job groups (e.g., `generatePrefixedId('qr')`, `generatePrefixedId('picker')`, `generatePrefixedId('usr-tpl')`).

10. **Event System & Reactive State Architecture (CRITICAL)**
    - **Frontend Centralization & Strict Typing**:
      - **ALWAYS** route frontend event subscriptions through the singleton `EventListenersService` (`src/app/services/infrastructure/system/event-listeners.service.ts`).
      - **DO NOT** call `this.listenToEvent(...)` or import `@tauri-apps/api/event` directly in components or domain services. Bypassing `EventListenersService` causes duplicate Tauri IPC listeners and separate SSE pipelines.
      - **ALWAYS** define event name constants and structured payload interfaces in `src/app/shared/types/events.ts` (re-exported from `@app/types`). Every method in `EventListenersService` must return a strongly-typed `Observable<T>`.
    - **Backend Event Emission & Headless SSE Parity (Rust)**:
      - All event strings **MUST** be declared as constants in `backend/core/src/utils/types/events.rs` with docstrings identifying emitting sources and consuming listeners.
      - Any event intended for frontend consumption across desktop and headless modes **MUST** be included in `SSE_FORWARD_EVENTS` in `backend/core/src/utils/types/events.rs`.
      - Internal backend listeners for system integration (tray re-render, power inhibition, engine restarts) **MUST** be registered inside `backend/core/src/services/event_listener.rs`.

11. **Drag & Drop / HTML5 Drag Prohibition in UI (CRITICAL)**
    - **DO NOT** use the native HTML5 Drag and Drop API (`draggable="true"`, `(dragstart)`, `(dragover)`, `(drop)`, `event.dataTransfer`) for internal UI dragging interactions.
    - Native HTML5 drag causes severe webview freezes, crashes, dropped payloads, or erratic behavior in Tauri (WebKitGTK on Linux and WebView2 on Windows) and does not support mobile touch gestures natively.
    - **ALWAYS** implement internal Pointer Drag systems using pointer events (`pointerdown`, `pointermove`, `pointerup`, `pointercancel`) with floating ghost elements and `document.elementFromPoint()` or bounding box hit-testing. Refer to `NautilusDragDropService` (`src/app/services/ui/nautilus-drag-drop.service.ts`) and `WorkflowDragDropService` (`src/app/services/flow/workflow-drag-drop.service.ts`) as reference implementations.
    - Always enforce a pointer movement threshold (e.g. 6–8px) before initiating a drag so that regular `click` and touch tap actions continue to work seamlessly.

12. **Dead Code & Compiler Warning Suppression Prohibition (CRITICAL)**
    - **DO NOT** use `#[allow(dead_code)]`, `#[allow(unused)]`, or similar compiler warning suppression attributes to silence unused structs, methods, fields, functions, or imports in backend code.
    - Every function, struct, field, or method introduced must be actively used or properly integrated.
    - If an item is target- or feature-specific, use exact conditional compilation attributes (`#[cfg(feature = "...")]` or `#[cfg(not(feature = "..."))]`) instead of silencing warnings with `allow`.
    - Unused code must be removed rather than suppressed. Backend code must compile cleanly with `-D warnings` across all target configurations (Desktop, Web Server, Mobile) without suppressing dead code.

13. **Design System First, Global SCSS & Anti-Duplication Rule (CRITICAL)**
    - **Never Reinvent Existing Classes (Single Canonical Class Rule)**: Before adding any new CSS class to a component's `.scss` file, AI agents **MUST** inspect `src/custom-theme.scss` and `src/app/styles/`. There is **exactly ONE** canonical global class for each UI primitive. You **MUST** reuse it instead of inventing a custom class or alias with duplicate styling:
      - **Pills / Badges / Chips**: Always use the `appPill` directive (`PillDirective`, `src/app/shared/directives/pill.directive.ts`), which owns the `.app-pill` class. `<span appPill tone="accent" size="xs">`, `<span appPill="solid" tone="primary">` (emphasis: `tonal` default, `solid`, `outline`), `<button appPill tone="accent" [selected]="on()">`. `size` is `xs` (20px), `sm` (24px) or `md` (28px, the default); do not restyle a pill's height, padding or font size in component SCSS. `tone` is a typed `PillTone` (`primary | accent | orange | yellow | purple | warn | dim`; omit for neutral). A `<button>`, `<a>` or `role="button"` pill is interactive and a `<span>` never is; `[selected]` sets `aria-pressed`. Keep tones as `PillTone` values in TypeScript (`toPillTone()` narrows a colour name), never as class-name strings. **DO NOT** add `p-*`, `interactive`, `is-selected` or `pill-sm` classes, or custom `.filter-chip`, `.badge`, `.status-tag`, `.job-id-pill`, `.stat-pill` or `.chip` classes. Pills that perform an action (run, insert, allow) are `matButton`, not pills. Code that builds a pill without Angular sets the `app-pill` class plus the same `data-tone`, `data-variant`, `data-size` and `data-selected` attributes.
      - **Action / Icon Buttons**: Always use `.action-button` (standard 32x32px icon button). **DO NOT** create custom `.action-btn`, `.icon-btn`, `.tool-btn`, `.chip-delete-btn`, `.action-mini-btn`, or `.custom-icon-button` classes.
      - **Material Icons**: Before using a `mat-icon` with `svgIcon`, inspect `src/app/services/ui/constants/icon-registry.ts` and reuse an existing registered icon whenever possible. Every static or dynamically returned icon name must match a registered key; do not invent names that only compile but fail at runtime. If a genuinely new icon is needed, add its SVG asset and register it in the shared icon registry in the same change.
      - **Open-Path Buttons**: A button that opens a path shows the plain `folder` icon for a local path and `folder-open` for a remote folder: `this.pathService.isLocalPath(path) ? 'folder' : 'folder-open'` (see `remote-card` and `quick-run-card`). Do not add a second, leading icon for the same path.
      - **Text Truncation (Ellipsis)**: Always use the single canonical `.truncate` class. **DO NOT** re-declare `white-space: nowrap; overflow: hidden; text-overflow: ellipsis;` in component SCSS files.
      - **Counter Badges**: A count is a pill: `<span appPill size="xs" tone="dim">{{ n }}</span>` (`tone="primary"` / `"accent"` when active, `appPill="solid"` for a notification bubble). **DO NOT** create custom `.count-badge`, `.cat-count-badge`, `.log-count-badge` or `.config-count-badge` classes. Push it to the end of a flex row with the global `.ml-auto`.
      - **Empty States**: Always use `.empty-state` (flex column, centered, with `mat-icon`, `span`, `p`). **DO NOT** create `.no-data`, `.empty-view`, `.profile-empty-state`, `.empty`, `.popup-empty`, `.no-results`, `.empty-list`, or component-specific empty-state clones. This covers every "nothing to show" message, however small: a sidebar filter with no match, an empty history popup or a list with no rows all use `.empty-state` (an icon is optional; a lone `span` is fine). Before writing any class whose name contains `empty`, `no-` or `none`, check `src/custom-theme.scss`.
      - **Loaders / Overlays**: Always use `.loading-container` (inline spinner) or `.loading-overlay` (modal absolute overlay from `_shared-modal.scss`).
      - **Context Menus**: Always use `.material-context-menu` and `.menu-item` (see Rule 5).
      - **Scrollbar Concealing**: Always use `.hide-scrollbar`. **DO NOT** write custom `::-webkit-scrollbar { display: none; }` or `scrollbar-width: none` in components.
      - **Detail Sections & Rows**: Always use `.detail-section`, `.section-title`, `.error-entry`, and `.card-row-item`.
      - **Modal Scaffolding**: Standard modals should extend or include `src/app/styles/_shared-modal.scss` via `styleUrls: ['...', 'path/to/_shared-modal.scss']` and use standard `header`, `main`, `footer`, `.form-section`, and `.section-label`.
    - **Colour Roles & the Tone Scope (CRITICAL)**:
      - A colour role (an operation, a status, a mode) is a `PillTone` (`primary | accent | orange | yellow | purple | warn | dim`). **ONE** place decides which operation has which role: `tone` in `OPERATION_REGISTRY` (`src/app/shared/types/operation-registry.ts`); read it through `OPERATION_TONE[key]` or `OPERATION_REGISTRY`. **DO NOT** copy that mapping into a component, a `switch`, a Record or a per-operation SCSS block.
      - In a template, give the element that owns the colour `[attr.data-tone]="tone"` (or `data-tone="accent"` when fixed). That is the **tone scope** (`custom-theme.scss`): it sets `--tone`, `--tone-rgb` and `--tone-on` for the element and everything inside it, and also `--mat-sys-primary`, so Material controls (progress bars, toggles) and `var(--mat-sys-primary)` follow it. Nested scopes override outer ones.
      - In SCSS, read the role with `var(--tone)`, `rgba(var(--tone-rgb), 0.15)` and `var(--tone-on)` (text on a solid fill). **DO NOT** write `&.sync { color: var(--primary-color) }`, `.op-*`, `.color-*`, `.box-*` or `@each` colour maps in component SCSS, and **DO NOT** invent `--state-color`, `--op-color`, `--mode-primary-color`, `--row-color`-style aliases.
      - Hold tones as `PillTone` in TypeScript, never as a class name or a free `string`. `PILL_TONE_VAR` exists only for the few places that cannot read the scope (a CSS gradient built in TypeScript).
      - **DO NOT** write `#fff`, `#ffffff` or `white` for text on a coloured fill: use `var(--accent-fg-color)` (or `var(--tone-on)`). A custom property a component reads must have its default declared on `:host` or the element, never as a `var(--x, fallback)`.
      - A coloured icon is `<mat-icon data-tone="warn">`; a coloured Material button is filled by its tone: `<button matButton="filled" data-tone="accent">` (also `matIconButton`, `matMiniFab`, `matFab`); any other button needs `data-variant="solid"` as well, because a plain button's `data-tone` is only a tone scope. **DO NOT** put `primary`, `accent`, `warn`, `orange`, `purple` or `yellow` in a `class` or `[class]` binding, and do not write `color: white !important`; the global rules in `custom-theme.scss` read `data-tone`.
      - Spacing and radius are tokens: write `var(--space-xs)` or `var(--radius-sm)` whenever the value equals one (4, 8, 12, 16, 20, 24, 32 px; radius 4, 8, 12, 16, 24 px), and `var(--transition-fast)` / `var(--transition-standard)` for those exact transitions.
      - Status colours (success, failure, running) are not operation colours: they keep their semantic tokens and are not read from the registry.
    - **Global Inherited Resets Prohibition**:
      - `html, body` globally enforces `user-select: none;` and `-webkit-user-drag: none;` across the entire application.
      - **DO NOT** declare redundant `user-select: none;` or `-webkit-user-drag: none;` in component SCSS files.
      - **ONLY** use `user-select: text;` or `user-select: all;` when explicitly opting-in to allow text selection (e.g. copyable IDs, tokens, paths, or interactive log outputs).
    - **Design System Tokens & Strict Token Integrity (CRITICAL)**:
      - Never hardcode raw pixel sizes, margins, paddings, or arbitrary hex colors (e.g. Bootstrap `#28a745`, `#ffc107`, `#17a2b8` or Tailwind `#3b82f6`, `#ef4444`).
      - **DO NOT invent CSS variables or alias tokens**: Every semantic role maps to exactly ONE canonical variable (1-to-1 token mapping). Defining alias/duplicate variables (e.g. `--text-secondary`, `--text-muted`, `--color-danger`, `--bg-hover`, `--bg-selected`, `--bg-elevated-05`) is strictly prohibited.
      - **DO NOT write fallbacks** into `var()` calls (e.g. `var(--accent-color, #3b82f6)`, `var(--dim-color, #a0a0a0)`, or `var(--bg-elevated, rgba(...))`). Global tokens in `src/custom-theme.scss` are guaranteed to exist at `:root`.
      - Before deleting a CSS variable as unused, search **every** file type, not only `.scss`, `.ts` and `.html`: SVG icons read `--rc-spinner-main`, `--rc-spinner-inner` and `--rc-spinner-track` (`src/assets/icons`), and backend resources carry their own styles. A variable that is read but never defined silently does nothing, so a new `var(--x)` must name a token that exists in `src/custom-theme.scss`.
      - Always use canonical CSS variables:
        - Spacing: `var(--space-xxs)` through `var(--space-2xl)`
        - Border Radius: `var(--radius-xxs)` through `var(--radius-lg)`
        - Typography: `var(--font-size-xs)` through `var(--font-size-3xl)`, `var(--font-mono)`
        - Transitions: `var(--transition-fast)`, `var(--transition-standard)`
        - Elevated Backgrounds: `var(--bg-elevated)` (base 2%), and `var(--bg-elevated-1)` through `var(--bg-elevated-4)`
        - Interactive States: `var(--hover-bg-color)`, `var(--selected-bg-color)`
        - Semantic Colors: `var(--window-bg-color)`, `var(--window-fg-color)`, `var(--dim-color)` (for all muted/secondary text), `var(--accent-color)`, `var(--primary-color)`, `var(--warn-color)` (for all errors/danger), `var(--yellow)`, `var(--orange)`, `var(--purple)`, `var(--card-bg-color)`, `var(--border-color)`

14. **Async Task Spawning Standard (CRITICAL)**
    - **ALWAYS** use `crate::utils::spawn` (or `crate::utils::spawn_blocking`) and standard `tokio::task::JoinHandle` for asynchronous background task spawning across backend Rust code.
    - **DO NOT** use raw `tokio::spawn` directly in production code: calling `tokio::spawn` outside of Tokio worker threads (e.g. inside `setup` hooks, GUI thread event listeners, or OS callbacks) panics with `"there is no reactor running"`. `crate::utils::spawn` dynamically registers the Tokio runtime context on the calling thread and returns a native `tokio::task::JoinHandle`.
    - **DO NOT** use `tauri::async_runtime::spawn` or `tauri::async_runtime::JoinHandle`.

15. **Zero-Dependency Semantic Version Comparison (Rust)**
    - **DO NOT** add external crates (such as `semver`) to backend dependencies for version checking and comparisons.
    - **ALWAYS** use the built-in, lightweight version comparison functions (`is_version_newer`, `clean_app_version`) from `crate::utils::version` (`backend/core/src/utils/version.rs`).
    - **DO NOT** use raw lexicographical string comparison (`>` or `<`) on version strings, because alphabetical sorting misjudges multi-digit numbers (e.g. `"0.3.10" < "0.3.4"`). The built-in parser compares `major.minor.patch` numbers as integers and correctly respects pre-release tags (`beta.x`).
    - Whether an installed build may be replaced by a release is decided by `is_offered` (`services/updates/mod.rs`), not `is_version_newer` alone: on the stable channel a pre-release build can move to any stable release (`is_update_candidate`), so leaving the beta channel never waits for the next stable version. On the beta channel only a newer release is offered; an older stable one there would be a downgrade. That includes the packages the core installs (`dpkg -i`, `pacman -U` and `rpm -U --oldpackage` accept an older package; the server MSI is built with `allow_downgrades`, and the stable MSI being installed is the one that decides) and the DEB Tauri installs. Only newer versions are offered to the RPM Tauri installs (its `rpm -U` refuses an older package and takes no flags), to packages another source manages, and to Android (version codes cannot decrease).

16. **Default Profile Name (CRITICAL)**
    - **ALWAYS** use the shared `DEFAULT_PROFILE_NAME` constant from `src/app/shared/types/remote-config.ts` (re-exported from `@app/types`) when creating, selecting, or resolving a default profile in frontend code.
    - **DO NOT** hardcode `'Default'` or `'default'` as a default profile name, define local aliases, or duplicate the constant. For example, use `cfg?.app?.backendProfile || DEFAULT_PROFILE_NAME`.
    - Preserve explicitly stored profile names, including legacy lowercase names; use the constant only for the default fallback.

17. **Updater & Release Contracts (CRITICAL)**
    - Release asset names (`server-<os>-<arch>-<version>.zip`, `portable-…`, `android-…`, the Tauri AppImage name that `appimage-linux-<arch>` catalog entries point to, and the server packages `RClone.Manager.Server_<version>_<amd64|arm64>.deb`, `RClone.Manager.Server-<version>-1.<x86_64|aarch64>.rpm`, `RClone.Manager.Server-<version>-1-<x86_64|aarch64>.pkg.tar.zst`, `RClone.Manager.Server_<version>_<x64|arm64>-setup.exe` and `RClone.Manager.Server_<version>_<x64|arm64>_en-US.msi`) are a contract between the release workflows, `scripts/create-update-manifest.cjs`, the Rust updater, the AUR `PKGBUILD-server` (which repackages the Arch package) and the website's downloads parser (`rclone-manager-website/src/app/features/downloads/downloads.utils.ts` and its spec). Change them together.
    - For the 0.3.7 releases only, `release-server.yml` also uploads the DEB and RPM as `RClone.Manager.Headless_<version>_<amd64|arm64>.deb` and `RClone.Manager.Headless-<version>-1.<x86_64|aarch64>.rpm`: the Headless app 0.3.6 cannot install its DEB or RPM itself and announces only a release holding files under its own name. They are not in the catalog; remove the step after 0.3.7, and the website skips them.
    - Installed versions find their update through names they cannot change: the repository (`OWNER`/`REPO`), the tag prefixes `v` and `headless-v`, the catalog name `updater.json`, `schemaVersion: 1`, the entry key `<kind>-<target>` and the kind and target names (`linux-x86_64`, from Rust's `consts::OS`/`ARCH`). Never rename them; add a field or a kind instead. Dropping a kind's entry, or not publishing it in a release, silently leaves those installations where they are. The client downloads the release file named by the manifest's `asset`; `publish-custom-updater.cjs` fails when it is not a file of the release, so publish a release only after all its workflows succeeded.
    - Versions up to 0.3.7-beta.1 (0.3.6 and older included) reject any field they do not know in the catalog, an entry or a manifest, and then never update again. Keep the catalog to `schemaVersion`, `version` and `entries`, every entry to `manifest` and `signature`, and the manifests of the kinds those versions read (portable, server, android, appimage, deb, rpm, nsis, msi) to their current fields. Only a new kind's manifest may carry a new field.
    - `scripts/create-update-manifest.cjs` checks the release files before it signs them. The Rust updater (`backend/core/src/services/updates/manifest.rs`) only checks the signature, the checksum and that the signed version, kind and target are the ones it asked for, and from 0.3.7-beta.2 on it ignores fields it does not know and reads only its own entry: a field a later release adds must never stop an installed version from updating. Do not add checks to the updater for something the release workflows always produce (a file name, a format, a platform's package); installed versions cannot be fixed when such a check goes wrong.
    - The server replaced the RClone Manager Headless app (Tauri, 0.3.6 and older). `scripts/publish-custom-updater.cjs` writes the `headless-v` release's `latest.json` from the DEB, RPM, setup and MSI entries of the catalog, so those installs move to the server package of their own format; keep that file in every release. The `rclone-manager-server` DEB and RPM replace `r-clone-manager-headless` (conflicts, replaces and obsoletes in `backend/server/package/nfpm.yaml`), the MSI keeps the old app's UpgradeCode, and the setup removes the old installation (`installer.nsi`). The old app's names stay where installs look for them: the `headless-v` tag, the data folder `com.rclone.manager.headless`, the product's `mode`, `integration_key` and `flatpak_id`, and the `/usr/bin/rclone-manager-headless[-bin]` launcher links. On start the server moves the old app's start-at-login and Send To entries (`LEGACY_NAME`).
    - Never write command-line arguments, passwords or tokens to disk. The update helper receives the launch arguments through its environment.
    - Server updates are ZIP archives only; `tar.gz` is not used for releases.

18. **RC Console Knowledge Lists (CRITICAL)**
    - rclone publishes no schema, so the RC console keeps three hand-written lists: `READ_ONLY_COMMANDS` and `DANGEROUS_COMMANDS` in `src/app/shared/utils/rc/rc-console.util.ts`, and `REQUIRED_PARAMS` in `src/app/shared/utils/rc/rc-schema.util.ts`.
    - After `npm run sync:endpoints`, read its "RC console lists to review" output and update these lists for every call it names: a new call is read-only, dangerous or neither, and its required parameters are read from rclone's Go source (the handler returns an error when a key is missing), never guessed from the help text.
    - Whenever you edit one of these lists, or add a call that takes other calls (like `job/batch`), check it against rclone and keep a call out of `READ_ONLY_COMMANDS` if it can write. A call may not be in both lists. Update `rc-console.util.spec.ts` and `rc-schema.util.spec.ts` to match.
    - `scripts/update-endpoints.cjs` reads these two files with patterns (`new Set([...])` and `'path': ['a', 'b'],` lines); keep that shape, or update the script and `scripts/update-endpoints.test.cjs` together.

19. **No Pass-Through Layers or Speculative Abstraction (CRITICAL)**
    - A function, method, type alias or module earns its place only when it does at least one of these: hides a platform or target difference, is used from two or more places, or gives a name to a rule its body does not make obvious. Anything else is inlined or removed.
    - **DO NOT** write a function whose body only calls another function (`pub fn detect() -> Option<bool> { detect_platform_theme() }`), a `use … as …` alias that only renames, a wrapper that hands its arguments on unchanged, or a helper with one caller that names nothing. Each layer is one more place to read, and one more item that a feature or target combination can leave unused (see Rule 12).
    - A trait method the trait requires (for example a `Host` method) is not a pass-through, but its body belongs in the impl: do not add a second function and a `static` behind it that exist only for that method.
    - Before writing a helper or a type, search the codebase and the existing dependencies for one (`tokio_util::sync::CancellationToken` instead of a hand-written cancellation token, `crate::utils::spawn`, `generatePrefixedId`).
    - Do not build for needs that do not exist yet: no configurable lists, generic parameters, builder types or one-variant enums for a single current use.
    - Do not add a dependency or a dependency feature only for a test that CI never runs.

---

## CI & Automated Workflows ([.github/workflows/](.github/workflows/))

All changes proposed by AI agents must pass the checks enforced by our GitHub Actions workflows:

- **[.github/workflows/ci.yml](.github/workflows/ci.yml)**: Continuous Integration pipeline verifying TypeScript/Angular lints, Prettier formatting, and Rust Clippy compilation across all target features.
- **[.github/workflows/docker-build-push.yml](.github/workflows/docker-build-push.yml)**: Multi-architecture Docker container build for headless web-server deployment.
- **[.github/workflows/release-\*.yml](.github/workflows/)**: Cross-platform release workflows (Linux, Windows, macOS, Android, Portable, Headless).

---

## Build, Test & Lint Commands

The commands below mirror the exact validation checks executed in [.github/workflows/ci.yml](.github/workflows/ci.yml).

The root [justfile](justfile) runs the same commands: `just ci` runs everything below, and `just frontend`, `just rust`, `just clippy`, `just rust-test` or `just scripts` run one group (`just` lists them). It holds no logic of its own; when a command here changes, change the matching recipe too.

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

# Release metadata and update manifest tests
node --test scripts/create-update-manifest.test.cjs scripts/publish-custom-updater.test.cjs scripts/release-version.test.cjs
```

> **Frontend Build Rule (CRITICAL)**:
> After any frontend change, run `ng build` and verify the output contains **no warnings**.
> Warnings (e.g., unused imports, deprecated APIs, template binding issues) must be treated as build failures and fixed before declaring the task complete.

### 2. Backend (Rust / Tauri)

Rust lives in the `backend` Cargo workspace: `core` (shared), `server` (HTTP), and `desktop` (Tauri/mobile). The following commands run from the repository root.

> **Note on `LIBRCLONE_SKIP_LINK_CHECK`**:
> When `librclone.a` / Go toolchain is not compiled locally, set `export LIBRCLONE_SKIP_LINK_CHECK=1` so Clippy can type-check Rust without linking errors.

```bash
# 1. Clippy check - Desktop targets (with and without the tray, and portable)
for features in desktop desktop,tray portable; do
  cargo clippy --manifest-path backend/Cargo.toml -p rclone-manager --features "$features" --no-default-features -- -D warnings
done

# 2. Clippy check - Web Server target (with its tray, except on macOS)
mkdir -p dist/rclone-manager/browser
cargo clippy --manifest-path backend/Cargo.toml -p rclone-manager-server -- -D warnings

# 3. Clippy check - Mobile target
cargo clippy --manifest-path backend/Cargo.toml -p rclone-manager --features mobile --no-default-features -- -D warnings

# 4. Rust formatting check
cargo fmt --manifest-path backend/Cargo.toml --all -- --check

# 5. Run backend unit tests
cargo test --manifest-path backend/Cargo.toml -p rclone-manager-core --features desktop,tray-gtk,updater,notifications,autostart --lib
# The tray tests need the tray feature and the Tauri mock runtime; graphics tests mutate the
# environment, so run these single-threaded.
for features in desktop desktop,tray,tauri-test; do
  cargo test --manifest-path backend/Cargo.toml -p rclone-manager --features "$features" --no-default-features --lib -- --test-threads=1
done

# 6. Updater unit tests (they spawn processes and use file locks, so CI runs them single-threaded)
cargo test --manifest-path backend/Cargo.toml -p rclone-manager-core --features updater --lib services::updates -- --test-threads=1
```

Code behind `cfg(target_os = "android")` (or left out of it) compiles only for an Android target, which the commands above do not build. CI's **Android target** job checks it with the NDK; after touching such code, run the same with a local NDK (`rustup target add x86_64-linux-android`), and skip it when no NDK is installed:

```bash
NDK_BIN="$ANDROID_HOME/ndk/<version>/toolchains/llvm/prebuilt/linux-x86_64/bin"
export LIBRCLONE_SKIP_LINK_CHECK=1 PATH="$NDK_BIN:$PATH" \
  CC_x86_64_linux_android=x86_64-linux-android26-clang AR_x86_64_linux_android=llvm-ar \
  CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER=x86_64-linux-android26-clang
cargo clippy --manifest-path backend/Cargo.toml -p rclone-manager-core --target x86_64-linux-android --features mobile -- -D warnings
cargo clippy --manifest-path backend/Cargo.toml -p rclone-manager --target x86_64-linux-android --no-default-features --features mobile -- -D warnings
```

### 3. Packaging & Linux Metadata Validation

Validate Flatpak AppStream metadata **only if `backend/desktop/linux/flatpak.metainfo.xml` was edited and running on Linux** with `appstreamcli` available; otherwise skip.

```bash
# Validate Flatpak AppStream metainfo (runs only on Linux when flatpak.metainfo.xml is modified, skips otherwise)
if [ "$(uname)" = "Linux" ] && command -v appstreamcli &>/dev/null; then
  git diff --name-only HEAD | grep -q "flatpak.metainfo.xml" && appstreamcli validate backend/desktop/linux/flatpak.metainfo.xml || true
fi
```

### 4. Local Development

```bash
# Launch Tauri dev server
npm run tauri dev

# Feature-specific dev modes
npm run dev:portable
npm run dev:server
```

---

## Utility Scripts

- `npm run sync:endpoints`: Update endpoint definitions from rclone schemas, then list the RC console lists that need review (see rule 18).
- `npm run sync:providers`: Sync rclone provider configurations.
- `npm run sync:flags`: Sync rclone CLI flag definitions.
- `npm run audit:i18n`: Verify missing translation keys.
- `appstreamcli validate backend/desktop/linux/flatpak.metainfo.xml`: Validate Flatpak AppStream metadata (Linux only, when metadata is modified).
