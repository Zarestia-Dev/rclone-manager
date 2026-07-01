# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Fixed

- **macOS 10.14 Mojave dyld crash (`_kSecUseDataProtectionKeychain` not found)**:
    - **Root cause**: `keyring` v4 on macOS pulls in
      `apple-native-keyring-store` v1 → `security-framework` v3.x, which
      statically references `_kSecUseDataProtectionKeychain` (added in
      macOS 10.15 Catalina). dyld aborts the process at load time on
      macOS ≤ 10.14, before `main()` runs — no runtime catch possible.
    - **Fix**: On macOS, use `security-framework` v2.x directly (it only
      references symbols from macOS 10.7 Lion). On Linux/Windows, keep
      `keyring` v4.x (the issue is macOS-specific). The split is done
      via target-specific dependencies in `Cargo.toml` so `keyring` is
      not even in the macOS dependency graph.
    - See `MACOS_COMPAT.md` for why runtime detection can't fix this.
- `CredentialManager::clear()` now invalidates `tracked_secrets_cache`
  after removing keys.  Previously the cache retained stale entries,
  causing `get_tracked_secrets()` to report secrets that had been
  deleted.
- `EncryptedFileBackend::save_store()` now closes the temp file before
  renaming (fixes `SharingViolation` on Windows) and cleans up the temp
  file on rename failure (prevents stale `.tmp` accumulation).

### Added

- **Bidirectional Secret Migration with O(1) Startup Optimization**:
    - Automatically migrates settings between `settings.json` and credential storage when schema metadata transitions between secret and normal.
    - Implemented an optimized O(1) startup check using a profile-scoped `__rcman_secrets__` key inside the credential store.
    - Added a backward-compatible one-time fallback scan to dynamically upgrade existing configurations without breaking active secrets.
- **SQLITE Storage**: Added a new SQLITE storage backend for persistent storage of settings.

### Changed

- `keychain` feature now uses `security-framework` v2.x directly on macOS
  (instead of `keyring` v4 which pulls in `security-framework` v3.x).
  Linux/Windows still use `keyring` v4.x.

## [v0.1.9] - 2026-05-19

### Fixed

- Fixed an issue where the primary keyring backend was not working properly.

## [v0.1.8] - 2026-05-15

### Added

- Added native support for `serde_json::Value` fields in `SettingsSchema` macro generation. It creates a new `SettingType::Object` that safely bypasses strict schema validation constraints, allowing developers to embed untyped, dynamic JSON structures directly inside their schemas while automatically resolving to the appropriate table format in storage backends (e.g. TOML/JSON).

### Fixed

- Fixed an issue where the cannot export the subsettings secret keys.

## [v0.1.7] - 2026-04-12

### Added

- **Major Security Overhaul: Secure Runtime Credentials**
    - High-level **Developer Friendly API**: Added intent-based methods (`with_env_credentials`, `with_file_credentials`, `with_password_credentials`) to the builder for easier configuration.
    - Automatic **Fallback Path Management**: Fallback encrypted files are now automatically placed in the app's config directory if no path is provided.
    - Replaced build-time hardcoded keys with a runtime-resolved `SecretPasswordSource` (Environment, File, or Provided).
    - Implemented a **Three-Tier Security Hierarchy**:
        1. **OS Keychain**: Native persistent storage (Primary).
        2. **Encrypted File**: Argon2id + AES-256-GCM persistent storage (Fallback).
        3. **Volatile Memory**: Emergency non-persistent storage (Emergency).
    - **Sticky Fallback Mechanism**: Automatically and permanently switches to the fallback backend if the platform keychain is unavailable (e.g., in Docker/Headless), significantly improving performance by avoiding repeated platform timeouts.
    - **Security Diagnostics**: Added `is_primary_failed()` and `is_volatile_active()` getters to `CredentialManager` for app health monitoring.
    - **GUI Demo Enhancements**: Added an interactive "Security Configuration" panel to visualize resolution and fallback status in real-time.
- mobile platform support (Android/iOS) with secure credential storage via `keyring-core` and `apple-native` backends.
- **Type-Safe Setting Accessors via Derive Macro**
    - `#[derive(DeriveSettingsSchema)]` now generates typed snapshot accessors (for example `ui_theme()` and `set_ui_theme(...)`).
    - Derive now generates schema-specific manager extension traits (`<SchemaName>ManagerAccessors`) for type-safe manager interactions.
- Added `with_encrypted_fallback` and `with_credentials_source` builder methods for easier configuration.
- **Feature-Gated Hot Reload (MVP)**
    - New optional `hot-reload` feature flag with watcher runtime support based on `notify`.
    - Added `HotReloadConfig` and `HotReloadBackend` (`Auto` / `Poll`).
    - Added `HotReloadRuntime` and `HotReloadEvent` exports.

## [v0.1.6] - 2026-03-08

### Changed

- `strip_nulls` utility added and applied to settings loading to prevent legacy null values from clobbering defaults.
- Some performance improvements.

## [v0.1.5] - 2026-03-04

### Added

- YAML storage backend added.

### Changed

- `SubSettings` store creation is centralized to reduce duplication and keep profile switching logic consistent.
- `SingleFileStore::set()` now skips file writes when data is unchanged.
- `SettingsManager` now caches schema metadata and reuses it in metadata/get/save/reset paths.
- API docs and README now document callback emission semantics across `save_setting`, `reset_setting`, `reset_all`, and profile switches.
- Event watcher/validator examples now consistently use full setting keys (for example `ui.theme`, `network.port`) across docs and unit tests.
- README examples were refreshed to match current APIs (`SettingsManager`, `get_all`, `metadata`, `SubSettingsConfig::singlefile`, non-generic `save_setting`, and current env-source patterns).
- Module docs were aligned to current typed API terminology (`get_all()` wording in config builder docs).
- Added explicit deprecation comments for backup manifest external fields with a planned v0.2.0 breaking rename (`external_config_files` -> `external_configs`) after removing legacy ID-list format.
- New UI tests added in derive.
- Minimum Rust version updated to 1.88

### Fixed

- `set_field()` now only treats `SubSettingsEntryNotFound` as missing; other read/parse errors are propagated.
- `exists()` now follows `get_value()` semantics, including secret-backed entries.
- `delete()` no longer emits a `Deleted` callback for missing entries.
- Secret reset/removal now respects active profile scope for main settings with credentials.
- Removed panic path in manager settings-path resolution; lock errors now propagate as regular `Result` errors.
- Removed panic-style unwrap in merged cache retrieval; returns a regular error on unexpected initialization failure.
- Removed remaining runtime unwraps in credential fallback logging and profiled backup manifest single-item conversion.
- `CredentialManager::clear()` is now profile-scoped when a profile context is active, with regression tests.
- `ProfileManager` manifest access/update paths now return explicit `NotInitialized` errors instead of relying on unwrap assumptions.
- `SubSettings` single-file and multi-file stores now use recovered lock handling to avoid panic on poisoned locks.
- Docs generation formatting paths were updated to avoid panic-style unwraps for consistency.
- `SettingsManager` operations now log lock-recovery fallback paths in sub-settings/provider/cache-invalidation helpers, and stale panic notes were removed from related docs.
- Main settings callbacks are now consistent across save/reset flows: secret saves emit change events when values actually change, and `reset_all()` emits per-key default-reset events only for changed values.
- Main-profile switches now emit main-setting change callbacks for effective value diffs between profiles, and emit nothing for unchanged values.
- `EventManager` now logs lock-recovery fallback paths for listener/validator registration and notification operations, with regression coverage for poisoned-lock handling.
- `ProfileManager` callback and manifest-invalidation paths now use recovered locks with debug diagnostics, plus poisoned-lock regression coverage for callback flows.
- Main manager profile propagation now emits explicit diagnostics for non-profiled sub-settings skips and unexpected sub-settings profile-manager access failures.
- External config restore no longer depends on sub-settings restore filters; external configs are restored independently when present in backup.
- Backup manifests now include external config id→archive filename mapping to make external restore robust across differing source/target paths.
- `get_external_config_from_backup()` now resolves by external config id with filename fallbacks for compatibility.
- Backup now exports credential-only main secrets when `SecretBackupPolicy` allows inclusion, even if the settings file does not contain those keys.
- Profile backups now also export credential-only main secrets when allowed by `SecretBackupPolicy`, even if a profile settings file is otherwise absent.
- Restore now rehydrates included main-secret values back into credential storage (when enabled) and redacts those values in restored settings files.
- Backup manifest metadata now records the secret export policy used for backup creation.

### Tests

- Added focused sub-settings regressions for `set_field` error propagation, callback action semantics, delete-missing behavior, and secret-only existence handling.
- Added `single_file` unit tests to verify no-op writes are skipped.
- Added profile integration coverage for profile-scoped secret reset behavior.
- Added encrypted-file backup regressions for secret-policy export behavior and restore credential rehydration.
- Added encrypted-file profile backup regression covering profile-scoped secret rehydration from restore.

## [v0.1.3] - 2026-02-01

### Added

- **Pattern Constraint Support in Derive Macro**
    - `#[setting(pattern = "regex")]` attribute for compile-time regex validation
    - Automatic pattern constraint generation from derive macro
    - Full parity with manual schema builder (min, max, step, pattern, options, secret)
- Encrypted settings export support. Default is disabled.
- Windows file and directory security support (With ACL).
- Added reserved list for settings metadata.

### Changed

- **API Simplification - Removed Non-Validating Constructors**
    - REMOVED: `password()`, `color()`, `path()`, `file()`, `textarea()` constructors from `SettingMetadata`
    - These constructors provided no backend validation - use `text()` with `.meta_str("input_type", ...)` for UI hints
    - Updated constructor documentation to clarify validation behavior
- **SettingType Enum Cleanup**
    - REMOVED: `Password`, `Color`, `Path`, `File`, `Textarea` variants from `SettingType` enum
    - Simplified validation logic - removed dead pattern matches
    - Only kept types with actual backend validation: `Toggle`, `Text`, `Number`, `Select`, `Info`, `List`
- Some imports were changed to make the code more readable.

### Fixed

- Multiple Storage backends support fixed.

## [v0.1.2] - 2026-01-11

### Added

- Toml support for settings files
- New `TomlStorage` backend alongside existing `JsonStorage`

- **Lock Poisoning Recovery System**
    - sync.rs module with `RwLockExt` and `MutexExt` traits
    - Graceful handling of poisoned locks with `read_recovered()`, `write_recovered()`, `lock_recovered()`
    - Comprehensive tests for poison recovery scenarios

- **Atomic Cache Generation Counters**
    - `AtomicU64` generation counters in `SettingsManager` for race-free cache invalidation
    - Lock-free concurrent cache invalidation detection

- **Secure File Permissions (Unix)**
    - security.rs module with permission enforcement
    - `set_secure_file_permissions()` - 0o600 (owner read/write only)
    - `set_secure_dir_permissions()` - 0o700 (owner rwx only)
    - Applied in storage.rs, sub_settings.rs, and profile managers

- **Profile Support** (new `profiles` feature)
    - profiles module with `ProfileManager`, `ProfileMigrator`
    - Profile CRUD operations (create, switch, delete, rename, duplicate)
    - Auto-migration from flat structure to `profiles/default/`
    - Profile-scoped sub-settings and main settings
    - Profile event system with callbacks
    - profiles_usage.rs demonstrating profile workflows

- **Tests**
    - profile_backup_restore.rs - Profile backup/restore integration tests
    - profiles_test.rs - Comprehensive profile CRUD and switching tests
    - sync.rs unit tests for poison recovery

### Changed

- **Deadlock Prevention in Profile Switching**
    - Refactored `SettingsManager::switch_profile()` to release locks before next acquisition
    - No nested lock holdings across manager, settings_dir, and sub_settings

- **Performance Optimization in SubSettings**
    - Optimized `single_file_path()` and `entry_path()` with inline path construction
    - Eliminated intermediate `get_base_dir()` allocations
    - Direct lock access + path join in single operation

- **Enhanced Error Handling**
    - `SubSettings::new()` fails fast on migration errors with clear messages
    - Profile migrator properly propagates serialization errors (removed `unwrap()`)
    - Added `MigrationFn` type alias for cleaner signatures

- **Other Improvements**
    - Minimum Rust version updated to 1.85 and clippy.toml adjusted

### Fixed

- **File permissions security** - All configuration files/directories created with secure permissions (Unix)
- **Clippy warnings** - Fixed `type_complexity`, `derivable_impls`, unused variables
- **Edge case test** - Updated readonly directory test to properly verify permission enforcement

## [v0.1.1] - 2026-01-2

### Added

- **Efficient Settings Access API**
    - `get<T>(key)` - Single value access by key path (e.g., `manager.get::<bool>("general.restrict")`)
    - `get_value(key)` - Raw JSON value access by key path
    - `settings<T>()` - Merged settings struct with caching (replaces `load_startup`)
    - `merged_settings_cache` - Internal cache for merged settings to avoid repeated merge operations
- **Cache Efficiency Improvements**
    - In-place cache updates: `save_setting()` now updates merged cache in-place instead of invalidating
    - Lazy defaults cache: Only populated on first access, not overwritten on every `load_settings()` call
- **Sub-Settings Performance**
    - **SingleFile Mode**: Loads entire file into memory once. `get`, `list`, `exists` are now in-memory operations (instant).
    - **MultiFile Mode**: Lazily caches entries on access/write. Subsequent reads are instant.
    - Optimized `set` and `delete` to update cache immediately, avoiding read-after-write.
- **Documentation Improvements**
    - Enhanced `backup/archive.rs` module with comprehensive docs and format explanation
- **Testing Improvements**
    - Added derive macro integration tests (`tests/derive_macro_test.rs`) with 7 test cases
- **Lazy Migration System** for transparent schema upgrades
    - `with_migrator()` on `SettingsConfig` for main settings migration
    - `with_migrator()` on `SubSettingsConfig` for sub-settings migration
    - Automatic detection and persistence of migrated data
    - Supports both single-file and multi-file sub-settings modes
    - Example: Rename fields, add version numbers, restructure data transparently
- **Enhanced External Config System** for flexible backup/restore
    - `ExportSource` enum: Export from `File`, `Command` output, or `Content` (in-memory)
    - `ImportTarget` enum: Restore to `File`, pipe to `Command`, use custom `Handler`, or `ReadOnly`
    - `from_command()` and `from_content()` constructors for `ExternalConfig`
    - Command-based exports (e.g., `rclone config dump`)
    - Custom restore handlers for complex logic
    - Read-only configs for diagnostics and logs
- **Polymorphic Backup Manifest** for sub-settings
    - `SubSettingsManifestEntry` enum: `SingleFile(String)` or `MultiFile(Vec<String>)`
    - Proper handling of single-file vs multi-file sub-settings in backups
    - `sub_settings_list()` helper method on `BackupContents`
- **Custom Backup Filenames**
    - `filename_suffix` option in `BackupOptions` for custom naming
    - Smart inference: single sub-setting exports use category name
    - Format: `{app}_{timestamp}_{suffix}.rcman`
- `File` setting type for file path selection (distinct from `Path`)
- `List` setting type for managing arrays of strings (`Vec<String>`)
    - Constructor: `SettingMetadata::list(label, default)` for creating list settings
    - Automatic support in derive macro for `Vec<String>` fields
    - Example usage in `examples/list_settings.rs`, `examples/basic_usage.rs`, and `examples/derive_usage.rs`
- Edge case testing for type validation, concurrent operations, and special values

**Development Infrastructure**

- GitHub Actions CI/CD pipeline enforcing fmt, clippy -D warnings, tests, and cargo-deny
- MSRV 1.70 declared with `rust-toolchain.toml` for consistent toolchain
- `clippy.toml` with MSRV-aware linting configuration
- `cargo-deny` setup for license compatibility, security advisories, and dependency auditing
- `justfile` with common development tasks (fmt, clippy, test, docs, deny)
- `.editorconfig` for consistent code formatting across editors
- Optional pre-commit git hook for automatic clippy checks
- Comprehensive `CONTRIBUTING.md` with development workflow guide

**Documentation**

- Comprehensive doctests for `JsonStorage`, `SettingMetadata`, and `SettingsManager`
- Module-level documentation improvements

### Changed

- **BREAKING**: Removed `load_startup<T>()` method - use `settings<T>()` instead
- `save_setting` now enforces strict schema validation (rejects undefined keys)
- Event system now recovers from poisoned locks (`unwrap_or_else(|e| e.into_inner())`) to avoid panics in multi-threaded environments
- All clippy warnings resolved across library, examples, and tests

### Fixed

- `reset_all` now correctly clears credentials from the secure backend
- Empty line formatting after `#[cfg]` attributes in examples
- Clippy warnings in test code (derivable impls, blocks in conditions)

## [0.1.0] - 2025-12-26

### Added

**Core Features**

- Settings management with JSON storage and in-memory caching
- Schema-based configuration with rich metadata for UI rendering
    - Type-specific constructors: `text()`, `number()`, `toggle()`, `select()`, `password()`, `color()`, `path()`, `info()`
    - Chainable setters: `description()`, `min()`, `max()`, `step()`, `category()`, `order()`, `advanced()`, `disabled()`, `secret()`
    - Pattern validation with regex and `pattern_error()` for custom messages
- Sub-settings for per-entity configuration files
    - Multi-file mode: `remotes/gdrive.json`, `remotes/s3.json`
    - Single-file mode: `backends.json` with all entities as keys
- Event system for change notifications and validation hooks

**Backup & Restore**

- Encrypted backups with ZIP format (AES-256)
- Granular backup selection: `include_sub_settings_items()`, `include_external()`
- `ExportCategory` and `ExportCategoryType` for UI category discovery
- `get_export_categories()` on `SettingsManager`
- Backup manifest with checksums, `analyze()` for pre-restore inspection
- External configuration registration via `with_external_config()`

**Credential Management**

- OS keychain integration (macOS Keychain, Windows Credential Manager, Linux Secret Service)
- Encrypted file fallback with Argon2id
- Mark settings with `.secret()` for automatic keychain storage

**Environment Variable Overrides**

- `with_env_prefix()` to enable env var overrides
- `env_overrides_secrets(true)` for Docker/CI environments
- Format: `{PREFIX}_{CATEGORY}_{KEY}` (e.g., `MYAPP_UI_THEME=dark`)
- Priority: Env Var > Stored Value > Default
- `env_override` flag in `SettingMetadata` for UI display

### Security

- Argon2id key derivation - State-of-the-art protection against GPU brute-force
- Atomic file writes (temp file + rename) to prevent corruption
- Mutex locks on save operations to prevent race conditions
- No secret values logged in any log statements
- Secrets removed from storage when set to default value
