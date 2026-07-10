//! Crate-wide string constants.
//!
//! Centralises the magic string literals that were previously duplicated
//! across many files (sub-settings names, event payload strings, backend
//! identifiers, profile names). Keeping these in one place means a typo
//! is caught at compile time and a rename touches one site instead of N.

// ── Backend identifiers ───────────────────────────────────────────────────

/// The reserved name for the always-present local backend.
///
/// This is the name stored in `Backend::name` for the in-process / locally
/// managed rclone instance. It's checked in dozens of places across the
/// codebase to special-case local-vs-remote behaviour, so it's a single
/// constant here.
pub const LOCAL_BACKEND_NAME: &str = "Local";

/// The settings profile name that backs [`LOCAL_BACKEND_NAME`].
///
/// `Local` uses `default` as its rcman sub-settings profile (because
/// `"Local"` isn't a valid profile name for the on-disk layout). Other
/// backends use their own name as the profile.
pub const LOCAL_BACKEND_PROFILE: &str = "default";

// ── rcman sub-settings section names ─────────────────────────────────────

/// Sub-settings section holding remote-specific configurations.
pub const SUB_REMOTES: &str = "remotes";
/// Sub-settings section holding rclone backend options (`options/get` blocks).
pub const SUB_BACKEND: &str = "backend";
/// Sub-settings section holding per-connection metadata (password, etc.).
pub const SUB_CONNECTIONS: &str = "connections";
/// Sub-settings section holding alert rules.
pub const SUB_ALERTS_RULES: &str = "alerts/rules";
/// Sub-settings section holding alert actions.
pub const SUB_ALERTS_ACTIONS: &str = "alerts/actions";

// ── SettingsChangeEvent wildcard ─────────────────────────────────────────

/// Wildcard used in `SettingsChangeEvent.category` / `.key` to indicate
/// "all categories" / "all keys" — e.g. emitted after a bulk reset.
pub const SETTINGS_WILDCARD: &str = "*";

// ── Tauri event payload strings ──────────────────────────────────────────

/// Payload sent with `MOUNT_STATE_CHANGED` / `SERVE_STATE_CHANGED` /
/// `REMOTE_CACHE_CHANGED` when the cache was refreshed. Replaces the
/// previously-duplicated `"cache_updated"` literal.
pub const CACHE_UPDATED: &str = "cache_updated";

/// Payload sent with `AUTOMATIONS_CACHE_CHANGED` after a bulk update.
pub const AUTOMATIONS_BULK_UPDATE: &str = "bulk_update";
/// Payload sent with `AUTOMATIONS_CACHE_CHANGED` after a single add.
pub const AUTOMATION_ADDED: &str = "automation_added";
/// Payload sent with `AUTOMATIONS_CACHE_CHANGED` after a single update.
pub const AUTOMATION_UPDATED: &str = "automation_updated";
/// Payload sent with `AUTOMATIONS_CACHE_CHANGED` after a single remove.
pub const AUTOMATION_REMOVED: &str = "automation_removed";
/// Payload sent with `AUTOMATIONS_CACHE_CHANGED` after clearing all.
pub const AUTOMATIONS_ALL_CLEARED: &str = "all_cleared";
/// Payload sent with `AUTOMATIONS_CACHE_CHANGED` after removing all
/// automations for a specific remote.
pub const AUTOMATIONS_REMOTE_REMOVED: &str = "remote_automations_removed";

// ── Filesystem permissions ───────────────────────────────────────────────

/// Unix file mode for executable files (`rwxr-xr-x`).
///
/// Used when writing scripts (send-to integrations, rclone binary install).
/// Replaces the previously-duplicated `0o755` literal in
/// `utils/rclone/util.rs` and `utils/app/send_to/linux.rs`.
#[cfg(unix)]
pub const EXEC_MODE: u32 = 0o755;
