use crate::config::SettingsSchema;
use crate::error::{Error, Result};
use crate::manager::core::SettingsManager;
use crate::storage::StorageBackend;
use crate::utils::sync::RwLockExt; // Import the trait for read_recovered/write_recovered
use log::{debug, warn};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

#[cfg(feature = "profiles")]
impl<S: StorageBackend + 'static, Schema: SettingsSchema> SettingsManager<S, Schema> {
    fn capture_effective_values_for_profile_events(&self) -> HashMap<String, Value> {
        let mut values = HashMap::new();

        for full_key in self.schema_metadata.keys() {
            match self.get_value(full_key) {
                Ok(value) => {
                    values.insert(full_key.clone(), value);
                }
                Err(err) => {
                    debug!(
                        "Skipping profile-switch event snapshot for '{full_key}' due to read error: {err}"
                    );
                }
            }
        }

        values
    }

    fn emit_profile_switch_setting_events(
        &self,
        before: &HashMap<String, Value>,
        after: &HashMap<String, Value>,
    ) {
        for (full_key, metadata) in self.schema_metadata.iter() {
            let old_value = before
                .get(full_key)
                .cloned()
                .unwrap_or_else(|| metadata.default.clone());
            let new_value = after
                .get(full_key)
                .cloned()
                .unwrap_or_else(|| metadata.default.clone());

            if old_value != new_value {
                self.events.notify(full_key, &old_value, &new_value);
            }
        }
    }

    /// Check if profiles are enabled for main settings
    pub fn is_profiles_enabled(&self) -> bool {
        self.profile_manager.is_some()
    }

    /// Get the profile manager for main settings
    ///
    /// Returns None if profiles are not enabled for main settings.
    pub fn profiles(&self) -> Option<&crate::profiles::ProfileManager<S>> {
        self.profile_manager.as_ref()
    }

    /// Switch to a different profile
    ///
    /// This switches the active profile for main settings and updates internal paths.
    /// All subsequent operations will use the new profile's settings.
    ///
    /// If change listeners are registered via `events().on_change(...)`, this emits
    /// callbacks for keys whose effective values differ between the previous and
    /// new active profile.
    ///
    /// # Arguments
    ///
    /// * `name` - The name of the profile to switch to
    ///
    /// # Errors
    ///
    /// Returns an error if:
    /// - Profiles are not enabled for this manager
    /// - The profile does not exist
    /// - The profile switch fails (e.g. IO error)
    pub fn switch_profile(&self, name: &str) -> Result<()> {
        let pm = self
            .profile_manager
            .as_ref()
            .ok_or(Error::ProfilesNotEnabled)?;

        let before_values = self.capture_effective_values_for_profile_events();

        // Step 1: Switch the profile in ProfileManager (this handles manifest updates)
        // This must be done first to ensure the profile exists and is valid
        pm.switch(name)?;

        // Step 2: Get the new path (without holding any locks)
        let new_path = pm.profile_path(name);

        // Step 3: Update settings_dir atomically
        {
            let mut settings_dir = self.settings_dir.write_recovered()?;
            *settings_dir = new_path;
        } // Lock released immediately

        // Step 4: Invalidate cache (after lock is released)
        self.invalidate_cache();

        // Clear in-memory tracked secrets cache so it will be reloaded for the new profile
        #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
        if let Some(ref creds) = self.credentials {
            creds.invalidate_tracked_secrets_cache()?;
        }

        // Step 4.5: Migrate secret keys for the new profile
        #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
        self.migrate_secret_keys()?;

        // Step 5: Propagate to sub-settings
        // Clone the Arc references to avoid holding the lock during profile switches
        let sub_settings_list: Vec<_> = {
            let sub_settings = self.sub_settings.read_recovered()?;
            sub_settings
                .iter()
                .map(|(key, sub)| (key.clone(), Arc::clone(sub)))
                .collect()
        }; // Lock released immediately

        // Now switch each sub-settings without holding the main lock
        for (key, sub) in sub_settings_list {
            match sub.switch_profile(name) {
                Ok(()) => {
                    debug!("Switched sub-settings '{key}' to profile '{name}'");
                    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
                    self.migrate_sub_settings_secret_keys(&sub)?;
                }
                Err(Error::ProfilesNotEnabled) => {
                    // Ignore sub-settings that don't support profiles.
                    // They continue to operate in their default mode.
                    debug!(
                        "Skipping sub-settings '{key}' profile switch because profiles are not enabled"
                    );
                }
                Err(e) => warn!("Failed to switch sub-settings '{key}' to profile '{name}': {e}"),
            }
        }

        let after_values = self.capture_effective_values_for_profile_events();
        self.emit_profile_switch_setting_events(&before_values, &after_values);

        Ok(())
    }

    /// Create a new profile for main settings
    ///
    /// # Arguments
    ///
    /// * `name` - The name of the profile to create
    ///
    /// # Errors
    ///
    /// Returns an error if:
    /// - Profiles are not enabled
    /// - The profile already exists
    /// - Creation fails (e.g. IO error)
    pub fn create_profile(&self, name: &str) -> Result<()> {
        let pm = self
            .profile_manager
            .as_ref()
            .ok_or(Error::ProfilesNotEnabled)?;
        pm.create(name)?;

        // Propagate to sub-settings
        let sub_settings = self.sub_settings.read_recovered()?;
        for (key, sub) in sub_settings.iter() {
            match sub.profiles() {
                Ok(pm) => match pm.create(name) {
                    Ok(()) => debug!("Created profile '{name}' in sub-settings '{key}'"),
                    Err(e) => {
                        warn!("Failed to create profile '{name}' in sub-settings '{key}': {e}");
                    }
                },
                Err(Error::ProfilesNotEnabled) => {
                    debug!(
                        "Skipping sub-settings '{key}' profile creation because profiles are not enabled"
                    );
                }
                Err(e) => {
                    warn!("Failed to access profile manager for sub-settings '{key}': {e}");
                }
            }
        }
        Ok(())
    }

    /// List all available profiles
    /// # Errors
    ///
    /// Returns an error if profiles are not enabled or reading the profile list fails.
    pub fn list_profiles(&self) -> Result<Vec<String>> {
        let pm = self
            .profile_manager
            .as_ref()
            .ok_or(Error::ProfilesNotEnabled)?;
        pm.list()
    }

    /// Get the active profile name
    /// # Errors
    ///
    /// Returns an error if profiles are not enabled or determining the active profile fails.
    pub fn active_profile(&self) -> Result<String> {
        let pm = self
            .profile_manager
            .as_ref()
            .ok_or(Error::ProfilesNotEnabled)?;
        pm.active()
    }
}
