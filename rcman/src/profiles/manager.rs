//! Profile manager implementation
//!
//! Handles profile lifecycle: create, switch, delete, rename, duplicate.

use crate::error::{Error, Result};
use crate::profiles::{DEFAULT_PROFILE, PROFILES_DIR, validate_profile_name};
use crate::utils::sync::RwLockExt;

use log::{debug, info};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

/// Type alias for cache invalidation callback
pub type InvalidateCallback = Arc<dyn Fn() + Send + Sync>;

// =============================================================================
// Profile Manifest
// =============================================================================

/// Profile manifest stored in `.profiles.json`
///
/// Tracks which profiles exist and which is currently active.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileManifest {
    /// Currently active profile name
    pub active: String,

    /// List of all profile names
    pub profiles: Vec<String>,
}

impl Default for ProfileManifest {
    fn default() -> Self {
        Self {
            active: DEFAULT_PROFILE.to_string(),
            profiles: vec![DEFAULT_PROFILE.to_string()],
        }
    }
}

impl ProfileManifest {
    /// Create a new manifest with a single default profile
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Check if a profile exists
    #[must_use]
    pub fn has_profile(&self, name: &str) -> bool {
        self.profiles.iter().any(|p| p == name)
    }

    /// Add a profile to the manifest
    pub fn add_profile(&mut self, name: String) {
        if !self.has_profile(&name) {
            self.profiles.push(name);
        }
    }

    /// Remove a profile from the manifest
    pub fn remove_profile(&mut self, name: &str) -> bool {
        if let Some(pos) = self.profiles.iter().position(|p| p == name) {
            self.profiles.remove(pos);
            true
        } else {
            false
        }
    }

    /// Rename a profile in the manifest
    pub fn rename_profile(&mut self, from: &str, to: String) -> bool {
        if let Some(pos) = self.profiles.iter().position(|p| p == from) {
            self.profiles[pos].clone_from(&to);
            if self.active == from {
                self.active = to;
            }
            true
        } else {
            false
        }
    }

    /// Set the active profile
    pub fn set_active(&mut self, name: &str) -> bool {
        if self.has_profile(name) {
            self.active = name.to_string();
            true
        } else {
            false
        }
    }
}

// =============================================================================
// Profile Event
// =============================================================================

/// Events emitted when profiles change
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileEvent {
    /// Profile was switched
    Switched {
        /// Previous active profile
        from: String,
        /// New active profile
        to: String,
    },
    /// New profile was created
    Created {
        /// Name of the created profile
        name: String,
    },
    /// Profile was deleted
    Deleted {
        /// Name of the deleted profile
        name: String,
    },
    /// Profile was renamed
    Renamed {
        /// Original name
        from: String,
        /// New name
        to: String,
    },
    /// Profile was duplicated
    Duplicated {
        /// Source profile
        source: String,
        /// New profile name
        target: String,
    },
}

// =============================================================================
// Profile Manager
// =============================================================================

use crate::storage::StorageBackend;

/// Type alias for profile event callback
pub type ProfileEventCallback = Arc<dyn Fn(ProfileEvent) + Send + Sync>;

/// Manages profiles for a specific target (settings or sub-settings)
///
/// The `ProfileManager` handles:
/// - Creating, deleting, renaming, and duplicating profiles
/// - Switching the active profile
/// - Persisting the profile manifest
/// - Emitting events on profile changes
pub struct ProfileManager<S: StorageBackend = crate::storage::JsonStorage> {
    /// Path to the manifest file (e.g., .profiles.json or .profiles.toml)
    manifest_path: PathBuf,

    /// Path to the profiles directory
    profiles_dir: PathBuf,

    /// Name of this profile target (for logging/errors)
    target_name: String,

    /// Storage backend for reading/writing manifest
    storage: S,

    /// Cached manifest (loaded on first access)
    manifest: RwLock<Option<ProfileManifest>>,

    /// Event callback
    on_event: RwLock<Option<ProfileEventCallback>>,

    /// Callback to invalidate caches when profile switches
    on_invalidate: RwLock<Option<InvalidateCallback>>,
}

impl<S: StorageBackend> ProfileManager<S> {
    /// Create a new profile manager for a given base directory
    ///
    /// # Arguments
    ///
    /// * `base_dir` - The directory containing the profiles
    /// * `target_name` - Name of this profile target (e.g., "remotes", "settings")
    /// * `storage` - Storage backend to use for manifest
    pub fn new(base_dir: &Path, target_name: impl Into<String>, storage: S) -> Self {
        // Manifest filename depends on storage extension
        let filename = format!(".profiles.{}", storage.extension());

        Self {
            manifest_path: base_dir.join(filename),
            profiles_dir: base_dir.join(PROFILES_DIR),
            target_name: target_name.into(),
            storage,
            manifest: RwLock::new(None),
            on_event: RwLock::new(None),
            on_invalidate: RwLock::new(None),
        }
    }

    /// Initialize the profile manager, running migrations if enabled
    ///
    /// This is a helper to centralize initialization logic that was previously in `SettingsManager`.
    ///
    /// # Arguments
    ///
    /// * `config_dir` - The root configuration directory
    /// * `target_name` - The name of the target (e.g. "settings")
    /// * `storage` - Storage backend
    /// * `enabled` - Whether profiles are enabled
    /// * `migrator` - Migration strategy
    ///
    /// # Returns
    ///
    /// Returns a tuple of `(active_settings_dir, Option<ProfileManager>)`.
    /// If profiles are disabled, returns `(config_dir, None)`.
    ///
    /// # Errors
    ///
    /// Returns an error if:
    /// - Migration fails
    /// - Profile manager initialization fails
    /// - Active profile path cannot be resolved
    pub fn initialize(
        config_dir: &Path,
        target_name: &str,
        storage: S,
        enabled: bool,
        migrator: &crate::profiles::ProfileMigrator,
    ) -> Result<(PathBuf, Option<Self>)> {
        if enabled {
            // Run migration if needed
            // For main settings, we assume multi-file mode (false) and no specific extension (None)
            // as it manages a directory of settings.
            crate::profiles::migrate(config_dir, target_name, false, &storage, migrator)?;

            let pm = Self::new(config_dir, target_name, storage);
            // Use active path from manifest (defaults to "default")
            let active = pm.active_path()?;

            info!(
                "Profiles initialized for '{target_name}' (active: {})",
                active.display()
            );
            Ok((active, Some(pm)))
        } else {
            Ok((config_dir.to_path_buf(), None))
        }
    }

    /// Set the event callback
    ///
    /// # Arguments
    ///
    /// * `callback` - The callback function to be called when a profile event occurs
    pub fn set_on_event<F>(&self, callback: F)
    where
        F: Fn(ProfileEvent) + Send + Sync + 'static,
    {
        if let Ok(mut guard) = self.on_event.write_recovered() {
            *guard = Some(Arc::new(callback));
        } else {
            debug!(
                "Failed to register profile event callback for '{}' due to lock recovery error",
                self.target_name
            );
        }
    }

    /// Set the cache invalidation callback
    ///
    /// # Arguments
    ///
    /// * `callback` - The callback function to be called when a profile switch occurs
    pub fn set_on_invalidate<F>(&self, callback: F)
    where
        F: Fn() + Send + Sync + 'static,
    {
        if let Ok(mut guard) = self.on_invalidate.write_recovered() {
            *guard = Some(Arc::new(callback));
        } else {
            debug!(
                "Failed to register profile invalidation callback for '{}' due to lock recovery error",
                self.target_name
            );
        }
    }

    /// Emit a profile event
    fn emit_event(&self, event: ProfileEvent) {
        if let Ok(guard) = self.on_event.read_recovered() {
            if let Some(callback) = guard.as_ref() {
                callback(event);
            }
        } else {
            debug!(
                "Failed to emit profile event for '{}' due to lock recovery error",
                self.target_name
            );
        }
    }

    /// Invalidate caches
    fn invalidate_caches(&self) {
        if let Ok(guard) = self.on_invalidate.read_recovered() {
            if let Some(callback) = guard.as_ref() {
                callback();
            }
        } else {
            debug!(
                "Failed to run profile invalidation callback for '{}' due to lock recovery error",
                self.target_name
            );
        }
    }

    /// Invalidate the internal manifest cache
    ///
    /// This forces the manifest to be re-read from disk on the next access.
    pub fn invalidate_manifest(&self) {
        if let Ok(mut guard) = self.manifest.write_recovered() {
            *guard = None;
        } else {
            debug!(
                "Failed to invalidate profile manifest cache for '{}' due to lock recovery error",
                self.target_name
            );
        }
    }

    /// Get the path to a specific profile's directory
    pub fn profile_path(&self, name: &str) -> PathBuf {
        self.profiles_dir.join(name)
    }

    /// Get the path to the active profile's directory
    ///
    /// # Returns
    ///
    /// Returns the path to the active profile's directory.
    ///
    /// # Errors
    ///
    /// Returns an error if the manifest cannot be read.
    pub fn active_path(&self) -> Result<PathBuf> {
        let active = self.active()?;
        Ok(self.profile_path(&active))
    }

    /// Ensure the manifest is loaded
    fn ensure_manifest(&self) -> Result<()> {
        {
            let guard = self.manifest.read_recovered()?;
            if guard.is_some() {
                return Ok(());
            }
        }

        let mut guard = self.manifest.write_recovered()?;
        if guard.is_some() {
            return Ok(());
        }

        // Try to load existing manifest
        let load_result = if self.manifest_path.exists() {
            // Normal case: load from current manifest path
            self.storage.read(&self.manifest_path).map(Some)
        } else {
            Ok(None)
        };

        match load_result {
            Ok(Some(manifest)) => {
                *guard = Some(manifest);
            }
            Ok(None) => {
                // Create default manifest
                *guard = Some(ProfileManifest::default());
            }
            Err(e) => return Err(e),
        }

        Ok(())
    }

    /// Save the manifest to disk
    fn save_manifest(&self) -> Result<()> {
        let manifest_clone = {
            let guard = self.manifest.read_recovered()?;
            let manifest = guard.as_ref().ok_or(Error::NotInitialized)?;
            manifest.clone()
        };
        // The read lock is now dropped, so concurrent operations are not blocked
        // while we wait for the (potentially slow) disk I/O to complete.

        self.storage.write(&self.manifest_path, &manifest_clone)?;

        debug!(
            "Saved profile manifest for '{}': active={}",
            self.target_name, manifest_clone.active
        );

        Ok(())
    }

    // =========================================================================
    // Public API
    // =========================================================================

    /// Get the currently active profile name
    ///
    /// # Returns
    ///
    /// Returns the name of the currently active profile.
    ///
    /// # Errors
    ///
    /// Returns an error if the manifest cannot be read.
    pub fn active(&self) -> Result<String> {
        self.ensure_manifest()?;
        let guard = self.manifest.read_recovered()?;
        Ok(guard.as_ref().ok_or(Error::NotInitialized)?.active.clone())
    }

    /// List all profile names
    ///
    /// # Returns
    ///
    /// Returns a vector of profile names.
    ///
    /// # Errors
    ///
    /// Returns an error if the manifest cannot be read.
    pub fn list(&self) -> Result<Vec<String>> {
        self.ensure_manifest()?;
        let guard = self.manifest.read_recovered()?;
        Ok(guard
            .as_ref()
            .ok_or(Error::NotInitialized)?
            .profiles
            .clone())
    }

    /// Check if a profile exists
    ///
    /// # Arguments
    ///
    /// * `name` - The name of the profile to check
    ///
    /// # Returns
    ///
    /// Returns `true` if the profile exists, `false` otherwise.
    ///
    /// # Errors
    ///
    /// Returns an error if the manifest cannot be read.
    pub fn exists(&self, name: &str) -> Result<bool> {
        self.ensure_manifest()?;
        let guard = self.manifest.read_recovered()?;
        Ok(guard
            .as_ref()
            .ok_or(Error::NotInitialized)?
            .has_profile(name))
    }

    /// Create a new profile
    ///
    /// Creates an empty profile directory and updates the manifest.
    ///
    /// # Arguments
    ///
    /// * `name` - The name of the profile to create
    ///
    /// # Errors
    ///
    /// Returns an error if the profile cannot be created.
    pub fn create(&self, name: &str) -> Result<()> {
        validate_profile_name(name)?;
        self.ensure_manifest()?;

        // Check if already exists
        {
            let guard = self.manifest.read_recovered()?;
            if guard
                .as_ref()
                .ok_or(Error::NotInitialized)?
                .has_profile(name)
            {
                return Err(Error::ProfileAlreadyExists(name.to_string()));
            }
        }

        // Create profile directory
        let profile_dir = self.profile_path(name);
        crate::utils::security::ensure_secure_dir(&profile_dir)?;

        // Update manifest
        {
            let mut guard = self.manifest.write_recovered()?;
            guard
                .as_mut()
                .ok_or(Error::NotInitialized)?
                .add_profile(name.to_string());
        }
        self.save_manifest()?;

        info!("Created profile '{}' for '{}'", name, self.target_name);
        self.emit_event(ProfileEvent::Created {
            name: name.to_string(),
        });

        Ok(())
    }

    /// Switch to a different profile
    ///
    /// Updates the active profile in the manifest and invalidates caches.
    ///
    /// # Arguments
    ///
    /// * `name` - The name of the profile to switch to
    ///
    /// # Errors
    ///
    /// Returns an error if the profile cannot be switched.
    pub fn switch(&self, name: &str) -> Result<()> {
        self.ensure_manifest()?;

        let from = {
            let guard = self.manifest.read_recovered()?;
            let manifest = guard.as_ref().ok_or(Error::NotInitialized)?;
            if !manifest.has_profile(name) {
                return Err(Error::ProfileNotFound(name.to_string()));
            }
            manifest.active.clone()
        };

        if from == name {
            debug!("Profile '{name}' is already active");
            return Ok(());
        }

        // Update manifest
        {
            let mut guard = self.manifest.write_recovered()?;
            guard
                .as_mut()
                .ok_or(Error::NotInitialized)?
                .set_active(name);
        }
        self.save_manifest()?;

        info!(
            "Switched profile for '{}': {} -> {}",
            self.target_name, from, name
        );

        // Invalidate caches
        self.invalidate_caches();

        self.emit_event(ProfileEvent::Switched {
            from,
            to: name.to_string(),
        });

        Ok(())
    }

    /// Delete a profile
    ///
    /// Removes the profile directory and updates the manifest.
    /// Cannot delete the active profile or the last remaining profile.
    ///
    /// # Arguments
    ///
    /// * `name` - The name of the profile to delete
    ///
    /// # Errors
    ///
    /// Returns an error if the profile cannot be deleted.
    pub fn delete(&self, name: &str) -> Result<()> {
        self.ensure_manifest()?;

        {
            let guard = self.manifest.read_recovered()?;
            let manifest = guard.as_ref().ok_or(Error::NotInitialized)?;

            if !manifest.has_profile(name) {
                return Err(Error::ProfileNotFound(name.to_string()));
            }

            if manifest.active == name {
                return Err(Error::CannotDeleteActiveProfile(name.to_string()));
            }

            if manifest.profiles.len() <= 1 {
                return Err(Error::CannotDeleteLastProfile);
            }
        }

        // Delete profile directory
        let profile_dir = self.profile_path(name);
        if profile_dir.exists() {
            std::fs::remove_dir_all(&profile_dir).map_err(|e| Error::FileDelete {
                path: profile_dir.clone(),
                source: e,
            })?;
        }

        // Update manifest
        {
            let mut guard = self.manifest.write_recovered()?;
            guard
                .as_mut()
                .ok_or(Error::NotInitialized)?
                .remove_profile(name);
        }
        self.save_manifest()?;

        info!("Deleted profile '{}' from '{}'", name, self.target_name);
        self.emit_event(ProfileEvent::Deleted {
            name: name.to_string(),
        });

        Ok(())
    }

    /// Rename a profile
    ///
    /// # Arguments
    ///
    /// * `from` - The name of the profile to rename
    /// * `to` - The new name for the profile
    ///
    /// # Errors
    ///
    /// Returns an error if the profile cannot be renamed.
    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        validate_profile_name(to)?;
        self.ensure_manifest()?;

        {
            let guard = self.manifest.read_recovered()?;
            let manifest = guard.as_ref().ok_or(Error::NotInitialized)?;

            if !manifest.has_profile(from) {
                return Err(Error::ProfileNotFound(from.to_string()));
            }

            if manifest.has_profile(to) {
                return Err(Error::ProfileAlreadyExists(to.to_string()));
            }
        }

        // Rename directory
        let from_dir = self.profile_path(from);
        let to_dir = self.profile_path(to);

        if from_dir.exists() {
            std::fs::rename(&from_dir, &to_dir).map_err(|e| Error::FileWrite {
                path: std::path::PathBuf::from(format!(
                    "{} -> {}",
                    from_dir.display(),
                    to_dir.display()
                )),
                source: e,
            })?;
        } else {
            // Create the new directory if old didn't exist
            std::fs::create_dir_all(&to_dir).map_err(|e| Error::DirectoryCreate {
                path: to_dir.clone(),
                source: e,
            })?;
        }

        // Update manifest
        {
            let mut guard = self.manifest.write_recovered()?;
            guard
                .as_mut()
                .ok_or(Error::NotInitialized)?
                .rename_profile(from, to.to_string());
        }
        self.save_manifest()?;

        info!(
            "Renamed profile '{}' -> '{}' in '{}'",
            from, to, self.target_name
        );

        self.emit_event(ProfileEvent::Renamed {
            from: from.to_string(),
            to: to.to_string(),
        });

        Ok(())
    }

    /// Duplicate a profile
    ///
    /// Copies all contents from the source profile to a new profile.
    ///
    /// # Arguments
    ///
    /// * `source` - The name of the source profile
    /// * `target` - The name of the target profile
    ///
    /// # Errors
    ///
    /// Returns an error if the profile cannot be duplicated.
    pub fn duplicate(&self, source: &str, target: &str) -> Result<()> {
        validate_profile_name(target)?;
        self.ensure_manifest()?;

        {
            let guard = self.manifest.read_recovered()?;
            let manifest = guard.as_ref().ok_or(Error::NotInitialized)?;

            if !manifest.has_profile(source) {
                return Err(Error::ProfileNotFound(source.to_string()));
            }

            if manifest.has_profile(target) {
                return Err(Error::ProfileAlreadyExists(target.to_string()));
            }
        }

        let source_dir = self.profile_path(source);
        let target_dir = self.profile_path(target);

        // Copy directory contents
        if source_dir.exists() {
            copy_dir_recursive(&source_dir, &target_dir)?;
        } else {
            std::fs::create_dir_all(&target_dir).map_err(|e| Error::DirectoryCreate {
                path: target_dir.clone(),
                source: e,
            })?;
        }

        // Update manifest
        {
            let mut guard = self.manifest.write_recovered()?;
            guard
                .as_mut()
                .ok_or(Error::NotInitialized)?
                .add_profile(target.to_string());
        }
        self.save_manifest()?;

        info!(
            "Duplicated profile '{}' -> '{}' in '{}'",
            source, target, self.target_name
        );

        self.emit_event(ProfileEvent::Duplicated {
            source: source.to_string(),
            target: target.to_string(),
        });

        Ok(())
    }

    /// Rollback to flat structure (removes all profiles except active)
    ///
    /// # ⚠️ Warning
    ///
    /// This operation is **irreversible** and will:
    /// - Keep only the **active profile's** data
    /// - **Permanently delete** all other profiles
    /// - Remove the profile structure entirely
    ///
    /// # Example
    ///
    /// ```ignore
    /// use rcman::{SettingsManager, SubSettingsConfig};
    ///
    /// let manager = SettingsManager::builder("my-app", "1.0.0")
    ///     .with_sub_settings(SubSettingsConfig::new("remotes").with_profiles())
    ///     .build()?;
    ///
    /// let remotes = manager.sub_settings("remotes")?;
    ///
    /// // Remove profile support, keeping only active profile data
    /// remotes.profiles()?.rollback_to_flat()?;
    /// ```
    ///
    /// # Errors
    ///
    /// Returns an error if the rollback fails
    pub fn rollback_to_flat(&self) -> Result<()> {
        use crate::profiles::rollback_migration;

        // Need to construct the root_dir from profiles_dir parent
        let root_dir = self
            .profiles_dir
            .parent()
            .ok_or_else(|| Error::Config("Invalid profiles directory structure".to_string()))?;

        // Determine single_file_mode by checking if root_dir is a file path
        // In single file mode, root_dir is like "config/backends" (no extension)
        // In multi file mode, root_dir is like "config/remotes" (directory)
        let single_file_mode = root_dir.with_extension(self.storage.extension()).is_file();

        rollback_migration(root_dir, &self.target_name, single_file_mode, &self.storage)?;

        // Invalidate caches
        self.invalidate_caches();

        Ok(())
    }

    /// Initialize profiles with auto-migration from flat structure
    ///
    /// If files exist in the base directory but no manifest exists,
    /// moves them into a "default" profile.
    ///
    /// # Arguments
    ///
    /// * `detect_existing` - A function that returns `true` if there are existing files to migrate
    ///
    /// # Returns
    ///
    /// Returns `true` if migration was needed, `false` otherwise.
    ///
    /// # Errors
    ///
    /// Returns an error if the manifest cannot be read or saved.
    pub fn initialize_with_migration<F>(&self, detect_existing: F) -> Result<bool>
    where
        F: FnOnce() -> bool,
    {
        // If manifest exists, nothing to migrate
        if self.manifest_path.exists() {
            self.ensure_manifest()?;
            return Ok(false);
        }

        // Check if there are existing files to migrate
        if !detect_existing() {
            // No existing files, just initialize fresh
            self.ensure_manifest()?;

            // Create default profile directory
            let default_dir = self.profile_path(DEFAULT_PROFILE);
            if !default_dir.exists() {
                std::fs::create_dir_all(&default_dir).map_err(|e| Error::DirectoryCreate {
                    path: default_dir.clone(),
                    source: e,
                })?;
            }

            self.save_manifest()?;
            return Ok(false);
        }

        // Migration will be handled by the caller
        // Just initialize the manifest
        let mut guard = self.manifest.write_recovered()?;
        *guard = Some(ProfileManifest::default());
        drop(guard);

        // Create profiles directory
        if !self.profiles_dir.exists() {
            std::fs::create_dir_all(&self.profiles_dir).map_err(|e| Error::DirectoryCreate {
                path: self.profiles_dir.clone(),
                source: e,
            })?;
        }

        info!(
            "Initialized profiles for '{}', migration needed",
            self.target_name
        );

        Ok(true) // Migration needed
    }

    /// Mark migration as complete and save manifest
    ///
    /// # Errors
    ///
    /// Returns an error if the manifest cannot be saved.
    pub fn complete_migration(&self) -> Result<()> {
        self.save_manifest()?;
        info!("Profile migration complete for '{}'", self.target_name);
        Ok(())
    }

    /// Get the manifest (for advanced use cases)
    ///
    /// # Errors
    ///
    /// Returns an error if the manifest cannot be read.
    pub fn manifest(&self) -> Result<ProfileManifest> {
        self.ensure_manifest()?;
        let guard = self.manifest.read_recovered()?;
        Ok(guard.as_ref().ok_or(Error::NotInitialized)?.clone())
    }

    /// Get the profiles directory path
    pub fn profiles_dir(&self) -> &Path {
        &self.profiles_dir
    }
}

// =============================================================================
// Helper Functions
// =============================================================================

/// Recursively copy a directory
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst).map_err(|e| Error::DirectoryCreate {
            path: dst.to_path_buf(),
            source: e,
        })?;
    }

    for entry in std::fs::read_dir(src).map_err(|e| Error::FileRead {
        path: src.to_path_buf(),
        source: e,
    })? {
        let entry = entry.map_err(|e| Error::FileRead {
            path: src.to_path_buf(),
            source: e,
        })?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path).map_err(|e| Error::FileWrite {
                path: dst_path.clone(),
                source: e,
            })?;
        }
    }

    Ok(())
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn create_test_manager() -> (
        tempfile::TempDir,
        ProfileManager<crate::storage::JsonStorage>,
    ) {
        let dir = tempdir().unwrap();
        let storage = crate::storage::JsonStorage::compact();
        let manager = ProfileManager::new(dir.path(), "test", storage);
        (dir, manager)
    }

    #[test]
    fn test_create_profile() {
        let (_dir, manager) = create_test_manager();

        manager.create("work").unwrap();

        let profiles = manager.list().unwrap();
        assert!(profiles.contains(&"default".to_string()));
        assert!(profiles.contains(&"work".to_string()));
    }

    #[test]
    fn test_switch_profile() {
        let (_dir, manager) = create_test_manager();

        manager.create("work").unwrap();
        manager.switch("work").unwrap();

        assert_eq!(manager.active().unwrap(), "work");
    }

    #[test]
    fn test_switch_nonexistent_profile() {
        let (_dir, manager) = create_test_manager();

        let result = manager.switch("nonexistent");
        assert!(matches!(result, Err(Error::ProfileNotFound(_))));
    }

    #[test]
    fn test_delete_profile() {
        let (_dir, manager) = create_test_manager();

        manager.create("work").unwrap();
        manager.delete("work").unwrap();

        let profiles = manager.list().unwrap();
        assert!(!profiles.contains(&"work".to_string()));
    }

    #[test]
    fn test_cannot_delete_active_profile() {
        let (_dir, manager) = create_test_manager();

        let result = manager.delete("default");
        assert!(matches!(result, Err(Error::CannotDeleteActiveProfile(_))));
    }

    #[test]
    fn test_cannot_delete_last_profile() {
        let (_dir, manager) = create_test_manager();

        manager.create("work").unwrap();
        manager.switch("work").unwrap();
        manager.delete("default").unwrap();

        // Now only "work" remains
        let result = manager.delete("work");
        assert!(matches!(result, Err(Error::CannotDeleteActiveProfile(_))));
    }

    #[test]
    fn test_rename_profile() {
        let (_dir, manager) = create_test_manager();

        manager.create("old").unwrap();
        manager.rename("old", "new").unwrap();

        let profiles = manager.list().unwrap();
        assert!(!profiles.contains(&"old".to_string()));
        assert!(profiles.contains(&"new".to_string()));
    }

    #[test]
    fn test_duplicate_profile() {
        let (dir, manager) = create_test_manager();

        manager.create("original").unwrap();

        // Create a file in the original profile
        let original_dir = dir.path().join("profiles").join("original");
        std::fs::write(original_dir.join("test.json"), r#"{"key": "value"}"#).unwrap();

        manager.duplicate("original", "copy").unwrap();

        // Verify copy has the file
        let copy_dir = dir.path().join("profiles").join("copy");
        assert!(copy_dir.join("test.json").exists());
    }

    #[test]
    fn test_profile_already_exists() {
        let (_dir, manager) = create_test_manager();

        manager.create("work").unwrap();
        let result = manager.create("work");
        assert!(matches!(result, Err(Error::ProfileAlreadyExists(_))));
    }

    #[test]
    fn test_event_callback() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let (_dir, manager) = create_test_manager();
        let counter = Arc::new(AtomicUsize::new(0));
        let counter_clone = counter.clone();

        manager.set_on_event(move |_event| {
            counter_clone.fetch_add(1, Ordering::SeqCst);
        });

        manager.create("work").unwrap();
        manager.switch("work").unwrap();
        manager.rename("work", "job").unwrap();

        assert_eq!(counter.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn test_callback_paths_recover_from_poisoned_locks() {
        use std::panic::{AssertUnwindSafe, catch_unwind};
        use std::sync::atomic::{AtomicUsize, Ordering};

        let (_dir, manager) = create_test_manager();

        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _guard = manager.on_event.write().unwrap();
            panic!("poison on_event lock");
        }));

        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _guard = manager.on_invalidate.write().unwrap();
            panic!("poison on_invalidate lock");
        }));

        let event_count = Arc::new(AtomicUsize::new(0));
        let event_count_clone = Arc::clone(&event_count);
        manager.set_on_event(move |_event| {
            event_count_clone.fetch_add(1, Ordering::SeqCst);
        });

        let invalidate_count = Arc::new(AtomicUsize::new(0));
        let invalidate_count_clone = Arc::clone(&invalidate_count);
        manager.set_on_invalidate(move || {
            invalidate_count_clone.fetch_add(1, Ordering::SeqCst);
        });

        manager.create("work").unwrap();
        manager.switch("work").unwrap();

        assert_eq!(event_count.load(Ordering::SeqCst), 2);
        assert_eq!(invalidate_count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_manifest_persistence() {
        let dir = tempdir().unwrap();

        // Create manager and add profile
        {
            let storage = crate::storage::JsonStorage::compact();
            let manager = ProfileManager::new(dir.path(), "test", storage);
            manager.create("persistent").unwrap();
        }

        // Create new manager instance
        {
            let storage = crate::storage::JsonStorage::compact();
            let manager = ProfileManager::new(dir.path(), "test", storage);
            let profiles = manager.list().unwrap();
            assert!(profiles.contains(&"persistent".to_string()));
        }
    }
}
