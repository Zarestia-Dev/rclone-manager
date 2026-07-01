#[cfg(any(feature = "keychain", feature = "encrypted-file"))]
use crate::config::SettingMetadata;
use crate::config::SettingsSchema;
use crate::error::{Error, Result};
use crate::manager::cache::CachedSettings;
use crate::manager::core::SettingsManager;
use crate::storage::StorageBackend;
use crate::utils::sync::RwLockExt;

use log::debug;
use serde_json::{Value, json};

impl<S: StorageBackend + 'static, Schema: SettingsSchema> SettingsManager<S, Schema> {
    /// Resolve the active profile name, or `None` if profiles are disabled.
    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    fn active_profile_name(&self) -> Option<String> {
        #[cfg(feature = "profiles")]
        {
            self.profile_manager
                .as_ref()
                .and_then(|pm| pm.active().ok())
        }
        #[cfg(not(feature = "profiles"))]
        {
            None
        }
    }

    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    fn require_credentials(&self) -> Result<&crate::credentials::CredentialManager> {
        self.credentials
            .as_ref()
            .ok_or(Error::Credential("Credentials not enabled".to_string()))
    }

    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    fn save_secret_setting(
        &self,
        full_key: &str,
        value: &Value,
        metadata: &SettingMetadata,
    ) -> Result<()> {
        let default_value = metadata.default.clone();

        let old_value = if self.credentials.is_some() {
            match self.get_credential_with_profile(full_key) {
                Ok(Some(secret_value)) => Value::String(secret_value),
                Ok(None) => default_value.clone(),
                Err(err) => {
                    debug!("Failed to read current secret value for {full_key} before save: {err}");
                    default_value.clone()
                }
            }
        } else {
            default_value.clone()
        };

        if old_value == *value {
            debug!("Secret setting {full_key} unchanged, skipping save");
            return Ok(());
        }

        if *value == default_value {
            if self.credentials.is_some() {
                self.remove_credential_with_profile(full_key)?;
                let mut tracked = self.get_tracked_secrets()?;
                if tracked.remove(full_key) {
                    self.save_tracked_secrets(&tracked)?;
                }
            }
            debug!("Secret {full_key} set to default, removed from keychain");

            if old_value != *value {
                self.events.notify(full_key, &old_value, value);
            }

            return Ok(());
        }

        let value_str = match value {
            Value::String(s) => s.clone(),
            _ => value.to_string(),
        };
        self.store_credential_with_profile(full_key, &value_str)?;

        if self.credentials.is_some() {
            let mut tracked = self.get_tracked_secrets()?;
            if tracked.insert(full_key.to_string()) {
                self.save_tracked_secrets(&tracked)?;
            }
        }

        debug!("Secret setting {full_key} stored in keychain");

        if old_value != *value {
            self.events.notify(full_key, &old_value, value);
        }

        Ok(())
    }

    /// Get the current settings file path.
    ///
    /// If profiles are enabled, this points to the active profile's directory.
    pub(crate) fn settings_path(&self) -> Result<std::path::PathBuf> {
        let dir = self.settings_dir.read_recovered()?;
        Ok(dir.join(&self.config.settings_file))
    }

    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    pub(crate) fn get_credential_with_profile(&self, key: &str) -> Result<Option<String>> {
        let creds = self.require_credentials()?;
        let profile = self.active_profile_name();
        creds.get_with_profile(key, profile.as_deref())
    }

    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    pub(crate) fn store_credential_with_profile(&self, key: &str, value: &str) -> Result<()> {
        let creds = self.require_credentials()?;
        let profile = self.active_profile_name();
        creds.store_with_profile(key, value, profile.as_deref())
    }

    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    pub(crate) fn remove_credential_with_profile(&self, key: &str) -> Result<()> {
        let creds = self.require_credentials()?;
        let profile = self.active_profile_name();
        creds.remove_with_profile(key, profile.as_deref())
    }

    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    fn get_tracked_secrets(&self) -> Result<std::collections::HashSet<String>> {
        let creds = self.require_credentials()?;
        let profile = self.active_profile_name();
        {
            let cache_guard = creds
                .tracked_secrets_cache
                .read()
                .map_err(|_| Error::LockPoisoned)?;
            if let Some(cache) = cache_guard.get(&profile) {
                return Ok(cache.clone());
            }
        }

        let secrets =
            if let Some(value_str) = self.get_credential_with_profile("__rcman_secrets__")? {
                let list: Vec<String> = serde_json::from_str(&value_str).map_err(|e| {
                    Error::Credential(format!("Failed to parse tracked secrets list: {e}"))
                })?;
                let set: std::collections::HashSet<String> = list.into_iter().collect();
                let mut cache_guard = creds
                    .tracked_secrets_cache
                    .write()
                    .map_err(|_| Error::LockPoisoned)?;
                cache_guard.insert(profile, set.clone());
                set
            } else {
                // Set the is_upgraded flag to indicate we did a fallback scan
                self.is_upgraded
                    .store(true, std::sync::atomic::Ordering::Relaxed);

                // Backward-compatible one-time fallback scan:
                // Scan all keys in the schema metadata to check what is in credentials
                let mut initial_tracked = std::collections::HashSet::new();
                for full_key in self.schema_metadata.keys() {
                    if let Ok(Some(_)) = self.get_credential_with_profile(full_key) {
                        initial_tracked.insert(full_key.clone());
                    }
                }
                creds.save_tracked_secrets(&initial_tracked, profile.as_deref())?;
                initial_tracked
            };

        Ok(secrets)
    }

    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    fn save_tracked_secrets(&self, secrets: &std::collections::HashSet<String>) -> Result<()> {
        let creds = self.require_credentials()?;
        let profile = self.active_profile_name();
        creds.save_tracked_secrets(secrets, profile.as_deref())
    }

    /// Invalidate the settings cache.
    ///
    /// Call this if the settings file was modified externally.
    pub fn invalidate_cache(&self) {
        self.settings_cache.invalidate();

        #[cfg(feature = "profiles")]
        if let Some(pm) = &self.profile_manager {
            pm.invalidate_manifest();
        }

        if let Ok(sub_settings) = self.sub_settings.read_recovered() {
            for sub in sub_settings.values() {
                sub.invalidate_cache();
            }
        } else {
            debug!("Failed to invalidate sub-settings cache due to lock recovery error");
        }

        debug!("Settings cache invalidated");
    }

    /// Save a single setting value.
    ///
    /// Validates the value, updates the cache, and writes to disk.
    /// Secret settings (when credentials are enabled) are routed to the OS
    /// keychain instead. Values equal to the default are removed from storage.
    /// Unchanged values produce no I/O.
    ///
    /// # Errors
    ///
    /// Returns an error if:
    /// - Validation fails
    /// - Keyring storage or file writing fails
    /// - Serialization or parsing fails
    pub fn save_setting(&self, category: &str, key: &str, value: &Value) -> Result<()> {
        let path = self.settings_path()?;
        let full_key = format!("{category}.{key}");

        // Run user-registered validators
        self.events
            .validate(&full_key, value)
            .map_err(|msg| Error::InvalidSettingValue {
                key: full_key.clone(),
                reason: msg,
            })?;

        let metadata = &self.schema_metadata;

        // Route secret settings to the credential backend
        #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
        if let Some(setting_meta) = metadata.get(&full_key).filter(|m| m.is_secret()) {
            self.save_secret_setting(&full_key, value, setting_meta)?;
            return Ok(());
        }

        self.ensure_cache_populated()?;

        let _write_guard = self
            .settings_write_lock
            .lock()
            .map_err(|_| Error::Config("Settings write lock poisoned".into()))?;

        let mut stored = self
            .settings_cache
            .get_stored()?
            .unwrap_or_else(|| json!({}));

        // Validate against schema and get metadata
        let setting_meta = metadata
            .get(&full_key)
            .ok_or_else(|| Error::SettingNotFound(full_key.clone()))?;

        if let Err(e) = setting_meta.validate(value) {
            return Err(Error::Config(format!(
                "Validation failed for {full_key}: {e}"
            )));
        }

        let default_value = setting_meta.default.clone();

        let old_value = stored
            .get(category)
            .and_then(|cat| cat.get(key))
            .cloned()
            .unwrap_or_else(|| default_value.clone());

        if old_value == *value {
            debug!("Setting {full_key} unchanged, skipping save");
            return Ok(());
        }

        let stored_obj = stored
            .as_object_mut()
            .ok_or_else(|| Error::Parse("Settings root is not an object".into()))?;

        {
            let category_obj = stored_obj
                .entry(category.to_string())
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(|| Error::Parse(format!("Category {category} is not an object")))?;

            // If value equals default, remove it to keep the file minimal
            if *value == default_value {
                category_obj.remove(key);
                debug!("Setting {full_key} set to default, removed from store");
            } else {
                category_obj.insert(key.to_string(), value.clone());
            }
        } // category_obj borrow ends

        // Remove empty categories
        if stored_obj
            .get(category)
            .and_then(|v| v.as_object())
            .is_some_and(serde_json::Map::is_empty)
        {
            stored_obj.remove(category);
        }

        self.storage.write(&path, &stored)?;
        self.settings_cache.update_stored(stored)?;

        debug!("Setting {full_key} saved");
        self.events.notify(&full_key, &old_value, value);

        Ok(())
    }

    /// Reset a single setting to its schema default.
    ///
    /// # Errors
    ///
    /// Returns an error if the setting key is not found in the schema,
    /// or if saving the default value fails.
    pub fn reset_setting(&self, category: &str, key: &str) -> Result<Value> {
        let metadata_key = format!("{category}.{key}");
        let default_value = self
            .schema_metadata
            .get(&metadata_key)
            .map(|m| m.default.clone())
            .ok_or_else(|| Error::SettingNotFound(format!("{category}.{key}")))?;

        self.save_setting(category, key, &default_value)?;

        debug!("Setting {category}.{key} reset to default");
        Ok(default_value)
    }

    /// Reset all settings to defaults.
    ///
    /// # Errors
    ///
    /// Returns an error if writing to storage fails or credential clearing fails.
    pub fn reset_all(&self) -> Result<()> {
        let path = self.settings_path()?;

        self.ensure_cache_populated()?;

        let stored = self
            .settings_cache
            .get_stored()?
            .unwrap_or_else(|| json!({}));

        let mut changed_events = Vec::new();
        for (full_key, metadata) in self.schema_metadata.iter() {
            let mut key_parts = full_key.split('.');
            let (Some(category), Some(setting), None) =
                (key_parts.next(), key_parts.next(), key_parts.next())
            else {
                debug!("Skipping invalid schema key format during reset_all: {full_key}");
                continue;
            };

            let default_value = metadata.default.clone();

            #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
            let old_value = if metadata.is_secret() && self.credentials.is_some() {
                match self.get_credential_with_profile(full_key) {
                    Ok(Some(secret_value)) => Value::String(secret_value),
                    Ok(None) => default_value.clone(),
                    Err(err) => {
                        debug!(
                            "Failed to read secret value for {full_key} during reset_all: {err}"
                        );
                        default_value.clone()
                    }
                }
            } else {
                stored
                    .get(category)
                    .and_then(|cat| cat.get(setting))
                    .cloned()
                    .unwrap_or_else(|| default_value.clone())
            };

            #[cfg(not(any(feature = "keychain", feature = "encrypted-file")))]
            let old_value = stored
                .get(category)
                .and_then(|cat| cat.get(setting))
                .cloned()
                .unwrap_or_else(|| default_value.clone());

            if old_value != default_value {
                changed_events.push((full_key.clone(), old_value, default_value));
            }
        }

        // Write empty object
        self.storage.write(&path, &json!({}))?;

        #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
        if let Some(ref creds) = self.credentials {
            creds.clear()?;
            // Clear in-memory tracked secrets cache since all credentials are gone
            creds.clear_tracked_secrets_cache(self.active_profile_name().as_deref())?;
            debug!("All credentials cleared");
        }

        debug!("All settings reset to defaults");

        self.invalidate_cache();

        for (full_key, old_value, new_value) in changed_events {
            self.events.notify(&full_key, &old_value, &new_value);
        }

        Ok(())
    }

    /// Load settings from disk, applying migrations if needed.
    pub(crate) fn load_from_disk(&self) -> Result<CachedSettings> {
        let settings_path = self.settings_path()?;
        let mut value: Value = match self.storage.read(&settings_path) {
            Ok(v) => v,
            Err(Error::FileRead { .. } | Error::PathNotFound(_) | Error::Parse(_)) => {
                // Start empty if not found or corrupted/invalid JSON
                json!({})
            }
            Err(e) => return Err(e),
        };

        // Apply migrations
        if let Some(migrator) = &self.config.migrator {
            let original = value.clone();
            value = migrator(value);
            if value != original {
                debug!("Migrated settings file");
                self.storage.write(&settings_path, &value)?;
            }
        }

        // Strip null values: null in a settings file is a legacy artifact from
        // older code that used Option<T> fields (serialized as null when None).
        // rcman never writes null — it removes keys equal to the default instead.
        // Stripping here keeps deep_merge a pure function and prevents null from
        // clobbering schema defaults.
        crate::utils::value::strip_nulls(&mut value);

        Ok(CachedSettings {
            stored: value,
            merged: None,
            defaults: self.schema_defaults.clone(),
            generation: 0,
        })
    }

    /// Ensure the settings cache is populated.
    ///
    /// Thread-safe — `populate()` acquires a write lock internally and
    /// double-checks, so redundant calls are cheap.
    ///
    /// # Errors
    ///
    /// Returns an error if loading from disk or parsing fails.
    pub fn ensure_cache_populated(&self) -> Result<()> {
        self.settings_cache.populate(|| self.load_from_disk())
    }

    /// Migrate settings between the settings file and credential store if their secret schema status has changed.
    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    pub(crate) fn migrate_secret_keys(&self) -> Result<()> {
        if self.credentials.is_none() {
            return Ok(());
        }

        let _write_guard = self
            .settings_write_lock
            .lock()
            .map_err(|_| Error::Config("Settings write lock poisoned".into()))?;

        let path = self.settings_path()?;
        let mut stored: Value = match self.storage.read(&path) {
            Ok(v) => v,
            Err(_) => json!({}),
        };
        let mut file_modified = false;
        let mut list_modified = false;

        // Load the tracked secrets list
        let mut tracked_secrets = self.get_tracked_secrets()?;

        // 1. Migrate Normal -> Secret keys (based on active schema)
        self.migrate_normal_to_secret(
            &mut stored,
            &mut tracked_secrets,
            &mut file_modified,
            &mut list_modified,
        )?;

        // 2. Migrate Secret -> Normal keys (optimized: only check currently tracked secrets)
        self.migrate_secret_to_normal(
            &mut stored,
            &mut tracked_secrets,
            &mut file_modified,
            &mut list_modified,
        )?;

        if list_modified {
            self.save_tracked_secrets(&tracked_secrets)?;
        }

        if file_modified {
            // Remove empty categories
            if let Some(obj) = stored.as_object_mut() {
                obj.retain(|_, v| !v.as_object().is_some_and(serde_json::Map::is_empty));
            }
            self.storage.write(&path, &stored)?;
            self.settings_cache.update_stored(stored)?;
        }

        Ok(())
    }

    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    fn migrate_normal_to_secret(
        &self,
        stored: &mut Value,
        tracked_secrets: &mut std::collections::HashSet<String>,
        file_modified: &mut bool,
        list_modified: &mut bool,
    ) -> Result<()> {
        for (full_key, metadata) in self.schema_metadata.iter() {
            if metadata.is_secret() {
                let Some((category, key)) = Self::parse_setting_key(full_key) else {
                    continue;
                };

                if let Some(value) = stored.get(category).and_then(|c| c.get(key)).cloned() {
                    let value_str = match &value {
                        Value::String(s) => s.clone(),
                        _ => value.to_string(),
                    };
                    self.store_credential_with_profile(full_key, &value_str)?;

                    if let Some(cat_obj) = stored.get_mut(category).and_then(|c| c.as_object_mut())
                    {
                        cat_obj.remove(key);
                        *file_modified = true;

                        if tracked_secrets.insert(full_key.clone()) {
                            *list_modified = true;
                        }
                        log::info!(
                            "Migrated setting '{full_key}' to credential store (changed to secret)"
                        );
                    }
                }
            }
        }
        Ok(())
    }

    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    fn migrate_secret_to_normal(
        &self,
        stored: &mut Value,
        tracked_secrets: &mut std::collections::HashSet<String>,
        file_modified: &mut bool,
        list_modified: &mut bool,
    ) -> Result<()> {
        let mut keys_to_remove = Vec::new();
        for full_key in &*tracked_secrets {
            if full_key.starts_with("sub.") {
                continue;
            }
            let metadata = self.schema_metadata.get(full_key);
            let is_currently_secret = metadata.is_some_and(SettingMetadata::is_secret);

            if !is_currently_secret {
                if let Ok(Some(secret_value)) = self.get_credential_with_profile(full_key) {
                    if let Some(metadata) = metadata {
                        let Some((category, key)) = Self::parse_setting_key(full_key) else {
                            continue;
                        };
                        let value = Value::String(secret_value);
                        let default_value = &metadata.default;

                        // Only write to file if the value differs from default
                        if value != *default_value {
                            if !stored.is_object() {
                                *stored = json!({});
                            }
                            let cat_obj = stored
                                .as_object_mut()
                                .ok_or_else(|| {
                                    Error::Parse("Settings root is not an object".into())
                                })?
                                .entry(category.to_string())
                                .or_insert_with(|| json!({}))
                                .as_object_mut()
                                .ok_or_else(|| {
                                    Error::Parse(format!("Category {category} is not an object"))
                                })?;
                            cat_obj.insert(key.to_string(), value);
                            *file_modified = true;
                        }
                    }

                    // Always clean up from the credential store
                    self.remove_credential_with_profile(full_key)?;
                    log::info!(
                        "Migrated setting '{full_key}' to settings file (changed to non-secret)"
                    );
                }
                keys_to_remove.push(full_key.clone());
            }
        }

        if !keys_to_remove.is_empty() {
            for key in keys_to_remove {
                tracked_secrets.remove(&key);
            }
            *list_modified = true;
        }
        Ok(())
    }

    /// Migrate sub-settings secret keys between the sub-settings files and credential store if their secret schema status has changed.
    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    pub(crate) fn migrate_sub_settings_secret_keys(
        &self,
        sub: &crate::sub_settings::SubSettings<S>,
    ) -> Result<()> {
        if self.credentials.is_none() {
            return Ok(());
        }

        let Some(schema) = sub.config.schema.as_ref() else {
            return Ok(());
        };

        let secret_fields: Vec<_> = schema
            .iter()
            .filter(|(_, metadata)| metadata.is_secret())
            .collect();

        let _write_guard = self
            .settings_write_lock
            .lock()
            .map_err(|_| Error::Config("Settings write lock poisoned".into()))?;

        let creds = self
            .credentials
            .as_ref()
            .ok_or_else(|| Error::Credential("Credentials not enabled".to_string()))?;

        let profile = sub.active_secret_profile();
        let mut tracked_secrets = self.get_tracked_secrets()?;
        let mut list_modified = false;

        // One-time upgrade fallback scan for sub-settings if is_upgraded is true
        if self.is_upgraded.load(std::sync::atomic::Ordering::Relaxed)
            && let Ok(entries) = sub.list()
        {
            for entry_name in &entries {
                for (path, _) in schema.iter().filter(|(_, m)| m.is_secret()) {
                    let credential_key = sub.secret_credential_key(entry_name, path);
                    if let Ok(Some(_)) = creds.get_with_profile(&credential_key, profile.as_deref())
                        && tracked_secrets.insert(credential_key)
                    {
                        list_modified = true;
                    }
                }
            }
        }

        let store = sub.store.read_recovered()?;

        // Pass 1: Normal -> Secret (Migrate from file to credential store)
        if self.migrate_sub_settings_normal_to_secret(
            sub,
            &secret_fields,
            profile.as_deref(),
            &**store,
            &mut tracked_secrets,
        )? {
            list_modified = true;
        }

        // Pass 2: Secret -> Normal (Migrate from credential store to file)
        if self.migrate_sub_settings_secret_to_normal(
            sub,
            schema,
            profile.as_deref(),
            &**store,
            &mut tracked_secrets,
        )? {
            list_modified = true;
        }

        if list_modified {
            self.save_tracked_secrets(&tracked_secrets)?;
        }

        Ok(())
    }

    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    fn migrate_sub_settings_normal_to_secret(
        &self,
        sub: &crate::sub_settings::SubSettings<S>,
        secret_fields: &[(&String, &SettingMetadata)],
        profile: Option<&str>,
        store: &dyn crate::sub_settings::SubSettingsStore,
        tracked_secrets: &mut std::collections::HashSet<String>,
    ) -> Result<bool> {
        let creds = self.require_credentials()?;
        let mut list_modified = false;
        if !secret_fields.is_empty()
            && let Ok(entries) = sub.list()
        {
            for entry_name in &entries {
                if let Ok(mut value) = store.get(entry_name) {
                    let mut entry_modified = false;
                    for (path, metadata) in secret_fields {
                        if let Some(secret_value) =
                            crate::utils::value::remove_path(&mut value, path)
                        {
                            let credential_key = sub.secret_credential_key(entry_name, path);
                            if secret_value == metadata.default {
                                creds.remove_with_profile(&credential_key, profile)?;
                            } else {
                                let value_str = match secret_value {
                                    Value::String(s) => s,
                                    v => v.to_string(),
                                };
                                creds.store_with_profile(&credential_key, &value_str, profile)?;
                            }
                            if tracked_secrets.insert(credential_key.clone()) {
                                list_modified = true;
                            }
                            entry_modified = true;
                            log::info!(
                                "Migrated sub-setting key '{credential_key}' to credential store (changed to secret)"
                            );
                        }
                    }
                    if entry_modified {
                        store.set(entry_name, value)?;
                    }
                }
            }
        }
        Ok(list_modified)
    }

    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    fn migrate_sub_settings_secret_to_normal(
        &self,
        sub: &crate::sub_settings::SubSettings<S>,
        schema: &std::collections::HashMap<String, SettingMetadata>,
        profile: Option<&str>,
        store: &dyn crate::sub_settings::SubSettingsStore,
        tracked_secrets: &mut std::collections::HashSet<String>,
    ) -> Result<bool> {
        let creds = self.require_credentials()?;
        let prefix = format!("sub.{}.", sub.config.name);
        let mut keys_to_remove = Vec::new();
        let mut list_modified = false;
        for full_key in &*tracked_secrets {
            if !full_key.starts_with(&prefix) {
                continue;
            }
            let suffix = &full_key[prefix.len()..];
            let Some((entry_name, field_path)) = suffix.split_once('.') else {
                continue;
            };

            let metadata = schema.get(field_path);
            let is_currently_secret = metadata.is_some_and(SettingMetadata::is_secret);

            if !is_currently_secret {
                if let Ok(Some(secret_value)) = creds.get_with_profile(full_key, profile) {
                    if let Some(metadata) = metadata {
                        let value = Value::String(secret_value);
                        let default_value = &metadata.default;

                        if value != *default_value {
                            let mut entry_val = store.get(entry_name).unwrap_or_else(|_| json!({}));
                            if !entry_val.is_object() {
                                entry_val = json!({});
                            }
                            crate::utils::value::set_path(&mut entry_val, field_path, value);
                            store.set(entry_name, entry_val)?;
                        }
                    }
                    creds.remove_with_profile(full_key, profile)?;
                    log::info!(
                        "Migrated sub-setting key '{full_key}' to sub-settings file (changed to non-secret)"
                    );
                }
                keys_to_remove.push(full_key.clone());
            }
        }

        if !keys_to_remove.is_empty() {
            for key in keys_to_remove {
                tracked_secrets.remove(&key);
            }
            list_modified = true;
        }
        Ok(list_modified)
    }
}
