# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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