//! Profile management for rcman
//!
//! This module provides profile support for settings and sub-settings,
//! allowing multiple named configurations that can be switched at runtime.
//!
//! # Overview
//!
//! Profiles allow users to maintain multiple configurations (e.g., "work", "personal", "testing")
//! and switch between them dynamically. Profiles can be scoped to:
//!
//!
//! # When to Use Profiles
//!
//! Profiles add complexity to the storage structure and API interaction. They should be chosen deliberately.
//!
//! ## ✅ Good Use Cases
//!
//! - **Multi-tenant Applications**: Where different users/tenants need completely isolated configurations.
//! - **Environment Switching**: Dev/Staging/Prod environments that need to swap entirely different sets of remotes or settings.
//! - **Workspace Management**: Applications that support distinct workspaces (like VS Code profiles).
//!
//! ## ❌ Avoid If
//!
//! - **Simple Presets**: If you just want to save a few combinations of settings, use a "presets" list in your main settings instead.
//! - **Single User Apps**: If the app is for a single user, profiles often add confusion.
//! - **Small Configs**: If your total config is < 10 items, profiling is likely over-engineering.
//!
//! # Performance & Complexity Impact
//!
//! Enabling profiles changes the on-disk structure:
//!
//! - **Standard:** `config_dir/remotes.json` (simple, fast)
//! - **Profiled:** `config_dir/remotes/profiles/{profile_name}/...` + `.profiles.json` manifest
//!
//! This introduces:
//! - **Initialization Cost:** Migration logic must run on startup to move flat files into the default profile.
//! - **I/O Overhead:** Switching profiles invalidates in-memory caches and requires re-reading from disk.
//! - **API Complexity:** You must manage profile lifecycle (create/switch/delete).
//!
//! # Implementation Details
//!
//! Profile management leverages a `.profiles.{ext}` manifest file stored at the target directory root.
//! This manifest acts as the source of truth for tracking the `active` profile name and the list
//! of all existing profiles. When a profile is created or switched, operations are dynamically routed
//! to the nested `profiles/{profile_name}/` directory.
//!
//! To prevent blocking operations in highly concurrent environments (like web servers routing requests
//! by tenant profile), the `ProfileManager` caches the manifest in an `RwLock` and eagerly clones it
//! out of the lock before executing blocking disk I/O. Legacy data is transparently migrated into
//! the `.profiles` folder schema by `ProfileMigrator` seamlessly during boot.
//!
//! # Example
//!
//! ```rust,ignore
//! use rcman::{SettingsManager, SubSettingsConfig};
//!
//! // Enable profiles for remotes sub-settings
//! let manager = SettingsManager::builder("my-app", "1.0.0")
//!     .with_sub_settings(SubSettingsConfig::new("remotes").with_profiles())
//!     .build()?;
//!
//! // Manage profiles
//! let remotes = manager.sub_settings("remotes")?;
//! remotes.profiles()?.create("work")?;
//! remotes.profiles()?.switch("work")?;
//!
//! // CRUD now operates on "work" profile
//! remotes.set("company-drive", &json!({...}))?;
//! ```

mod manager;
mod migrator;

pub use manager::{ProfileEvent, ProfileManager, ProfileManifest};
pub use migrator::{ProfileMigrator, migrate, rollback_migration};

/// Default profile name used when migrating or initializing
pub const DEFAULT_PROFILE: &str = "default";

/// Directory name containing profile subdirectories
pub const PROFILES_DIR: &str = "profiles";

/// Validate a profile name
///
/// Valid names can contain spaces and most printable characters.
/// Names cannot be empty, start with a dot, or contain path separators.
///
/// # Errors
///
/// Returns an error if the name is invalid.
pub fn validate_profile_name(name: &str) -> crate::Result<()> {
    use crate::Error;

    if name.is_empty() {
        return Err(Error::InvalidProfileName(format!(
            "{name}: Profile name cannot be empty",
        )));
    }

    if name.starts_with('.') {
        return Err(Error::InvalidProfileName(format!(
            "{name}: Profile name cannot start with a dot",
        )));
    }

    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(Error::InvalidProfileName(format!(
            "{name}: Profile name cannot contain path separators",
        )));
    }

    // Only reject control characters and path-unsafe chars
    // Allows: letters, numbers, spaces, punctuation, unicode, etc.
    if name.chars().any(char::is_control) {
        return Err(Error::InvalidProfileName(format!(
            "{name}: Profile name cannot contain control characters"
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_profile_names() {
        assert!(validate_profile_name("default").is_ok());
        assert!(validate_profile_name("work").is_ok());
        assert!(validate_profile_name("my-profile").is_ok());
        assert!(validate_profile_name("profile_123").is_ok());
        assert!(validate_profile_name("Work").is_ok());
        assert!(validate_profile_name("PROD").is_ok());

        // Spaces and special characters are now allowed!
        assert!(validate_profile_name("Test 1").is_ok());
        assert!(validate_profile_name("My Backend!").is_ok());
        assert!(validate_profile_name("NAS #2").is_ok());
        assert!(validate_profile_name("Work (Personal)").is_ok());
        assert!(validate_profile_name("Backend @ Home").is_ok());
    }

    #[test]
    fn test_invalid_profile_names() {
        assert!(validate_profile_name("").is_err()); // Empty
        assert!(validate_profile_name(".hidden").is_err()); // Starts with dot
        assert!(validate_profile_name("path/to").is_err()); // Path separator
        assert!(validate_profile_name("path\\to").is_err()); // Path separator
        assert!(validate_profile_name("..").is_err()); // Path traversal
        assert!(validate_profile_name("has\nnewline").is_err()); // Control char
        assert!(validate_profile_name("has\ttab").is_err()); // Control char
    }
}
