use crate::config::{SettingMetadata, SettingsSchema};
use crate::error::{Error, Result};
use crate::manager::core::SettingsManager;
use crate::storage::StorageBackend;
use crate::sub_settings::{SubSettings, SubSettingsConfig};
use crate::utils::sync::RwLockExt;

#[cfg(feature = "backup")]
use crate::backup::{BackupManager, ExternalConfigProvider};

use log::{debug, info};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

impl<S: StorageBackend + 'static, Schema: SettingsSchema> SettingsManager<S, Schema> {
    pub(crate) fn parse_setting_key(key: &str) -> Option<(&str, &str)> {
        let mut parts = key.split('.');
        let category = parts.next()?;
        let setting = parts.next()?;

        if parts.next().is_some() {
            return None;
        }

        Some((category, setting))
    }

    /// Helper to get a setting value, checking keyring if it's a secret (when feature is enabled).
    ///
    /// This centralizes the logic for retrieving values that may be stored in
    /// the keyring (for secrets) or in the file cache (for normal settings).
    fn get_value_with_secret_support(
        &self,
        key: &str,
        metadata: &SettingMetadata,
    ) -> Result<Option<(Value, bool)>> {
        if cfg!(any(feature = "keychain", feature = "encrypted-file")) && metadata.is_secret() {
            // Check env var override for secrets if enabled
            if self.config.env_overrides_secrets
                && let Some(env_value) = self.get_env_override(key)
            {
                return Ok(Some((env_value, true)));
            }

            // Try retrieving from keyring
            #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
            if let Ok(Some(secret_value)) = self.get_credential_with_profile(key) {
                return Ok(Some((Value::String(secret_value), false)));
            }

            // Secret not found, use default
            return Ok(Some((metadata.default.clone(), false)));
        }

        // Not a secret (or feature disabled) - check cache (with env override support)
        if let Some(env_value) = self.get_env_override(key) {
            return Ok(Some((env_value, true)));
        }

        let Some((category, setting_name)) = Self::parse_setting_key(key) else {
            return Ok(None);
        };

        Ok(self
            .settings_cache
            .get_value(category, setting_name, key)?
            .map(|v| (v, false)))
    }

    /// Check if a setting value is overridden by an environment variable
    ///
    /// Returns the parsed value if env var is set and successfully parsed.
    pub(crate) fn get_env_override(&self, key: &str) -> Option<Value> {
        self.env_handler.get_env_override(key)
    }

    /// Get all setting metadata with current values populated.
    ///
    /// Returns a `HashMap` of all settings with their metadata (type, label, default, current value).
    /// Useful for rendering settings UI.
    ///
    /// Returns metadata map with current values populated.
    /// Uses in-memory cache when available.
    ///
    /// # Errors
    ///
    /// Returns an error if:
    /// - Storage read fails
    /// - Data is corrupted
    pub fn metadata(&self) -> Result<HashMap<String, SettingMetadata>> {
        // Ensure cache is populated
        self.ensure_cache_populated()?;

        // Get metadata and populate values
        let mut metadata = (*self.schema_metadata).clone();

        for (key, option) in &mut metadata {
            if Self::parse_setting_key(key).is_some() {
                match self.get_value_with_secret_support(key, option) {
                    Ok(Some((value, env_overridden))) => {
                        option.value = Some(value);
                        if env_overridden {
                            option
                                .metadata
                                .insert("env_override".to_string(), Value::Bool(true));
                            debug!("Setting {key} overridden by env var");
                        }
                    }
                    Ok(None) => {
                        // Fallback to default if helper returns None
                        option.value = Some(option.default.clone());
                    }
                    Err(e) => {
                        debug!("Failed to read value for {key}: {e}");
                        option.value = Some(option.default.clone());
                    }
                }
            }
        }

        debug!("Settings loaded successfully");
        Ok(metadata)
    }

    /// Get a single setting value by key path.
    ///
    /// # Type Parameters
    ///
    /// * `T` - The type to deserialize the value into
    ///
    /// # Arguments
    ///
    /// * `key` - Setting key in "category.name" format (e.g., "general.restrict")
    ///
    /// # Errors
    ///
    /// Returns an error if:
    /// - The setting doesn't exist (and no default)
    /// - The value cannot be deserialized to type `T`
    /// - Storage read fails
    pub fn get<T>(&self, key: &str) -> Result<T>
    where
        T: serde::de::DeserializeOwned,
    {
        let value = self.get_value(key)?;
        serde_json::from_value(value).map_err(|e| Error::Parse(e.to_string()))
    }

    /// Get raw JSON value for a setting key.
    ///
    /// Returns the value from merged settings cache, or from keyring if it's a secret.
    ///
    /// # Arguments
    ///
    /// * `key` - Setting key in "category.name" format
    ///
    /// # Errors
    ///
    /// Returns an error if:
    /// - The setting key format is invalid
    /// - The setting doesn't exist
    /// - Storage read fails
    pub fn get_value(&self, key: &str) -> Result<Value> {
        let Some((category, setting_name)) = Self::parse_setting_key(key) else {
            return Err(Error::Config(
                "Key must be in format 'category.setting'".into(),
            ));
        };

        // Ensure cache is populated with schema defaults
        self.ensure_cache_populated()?;

        // Get metadata to check if this is a secret
        let setting_metadata = self
            .schema_metadata
            .get(key)
            .ok_or_else(|| Error::SettingNotFound(format!("{category}.{setting_name}")))?;

        // Use the helper that handles both secrets and regular settings.
        self.get_value_with_secret_support(key, setting_metadata)?
            .map(|(v, _)| v)
            .ok_or_else(|| Error::SettingNotFound(format!("{category}.{setting_name}")))
    }

    /// Get merged settings as raw JSON.
    ///
    /// # Errors
    ///
    /// Returns an error if settings cannot be read.
    pub fn get_all_data(&self) -> Result<Value> {
        self.ensure_cache_populated()?;
        self.settings_cache
            .get_or_compute_merged(|stored| Self::merge_with_defaults(stored))
    }

    /// Get merged settings struct with caching.
    ///
    /// # Errors
    ///
    /// Returns an error if settings cannot be read or parsed.
    pub fn get_all(&self) -> Result<Schema> {
        let merged = self.get_all_data()?;

        // Deserialize to concrete type
        serde_json::from_value(merged).map_err(|e| Error::Parse(e.to_string()))
    }

    /// Internal helper to merge stored settings with schema defaults.
    pub(crate) fn merge_with_defaults(stored: &Value) -> Result<Value> {
        let default = Schema::default();
        let mut merged = serde_json::to_value(&default)?;

        // Merge stored on top of defaults only if stored is an object
        if stored.is_object() {
            crate::utils::value::deep_merge(&mut merged, stored);
        }

        Ok(merged)
    }

    // =========================================================================
    // Sub-Settings Management
    // =========================================================================

    /// Register a sub-settings type for per-entity configuration.
    ///
    /// Sub-settings allow you to manage separate config files for each entity
    /// (e.g., one file per remote, per profile, etc.).
    ///
    /// # Errors
    ///
    /// Returns an error if the sub-settings handler cannot be initialized (e.g. invalid path).
    pub fn register_sub_settings(&self, config: SubSettingsConfig) -> Result<()> {
        let name = config.name.clone();

        #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
        let credentials = self.credentials.clone();

        let handler = Arc::new(SubSettings::new(
            &self.config.config_dir,
            config,
            self.storage.clone(),
            #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
            credentials,
        )?);

        let mut guard = self.sub_settings.write_recovered()?;
        guard.insert(name.clone(), handler.clone());

        #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
        self.migrate_sub_settings_secret_keys(&handler)?;

        info!("Registered sub-settings type: {name}");
        Ok(())
    }

    /// Get a registered sub-settings handler.
    ///
    /// Returns the handler for the specified sub-settings type, which can be used
    /// to read, write, and manage individual entries.
    ///
    /// # Arguments
    ///
    /// * `name` - The name of the sub-settings type to get
    ///
    /// # Errors
    ///
    /// Returns `Error::SubSettingsNotFound` if the sub-settings type is not registered.
    pub fn sub_settings(&self, name: &str) -> Result<Arc<SubSettings<S>>> {
        let guard = self.sub_settings.read_recovered()?;
        guard
            .get(name)
            .cloned()
            .ok_or_else(|| Error::SubSettingsNotRegistered(name.to_string()))
    }

    /// Check if a sub-settings type exists
    ///
    pub fn has_sub_settings(&self, name: &str) -> bool {
        match self.sub_settings.read_recovered() {
            Ok(guard) => guard.contains_key(name),
            Err(err) => {
                debug!("Failed to check sub-settings existence for {name}: {err}");
                false
            }
        }
    }

    /// List all registered sub-settings types
    pub fn sub_settings_types(&self) -> Vec<String> {
        match self.sub_settings.read_recovered() {
            Ok(guard) => guard.keys().cloned().collect(),
            Err(err) => {
                debug!("Failed to list sub-settings types: {err}");
                Vec::new()
            }
        }
    }

    /// List all entries in a sub-settings type (convenience method)
    ///
    /// This is a shorthand for `manager.sub_settings(name)?.list()?`
    ///
    /// # Arguments
    ///
    /// * `name` - The name of the sub-settings type to list
    ///
    /// # Errors
    ///
    /// Returns `Error::SubSettingsNotFound` if the type is not registered, or I/O errors from the handler.
    pub fn list_sub_settings(&self, name: &str) -> Result<Vec<String>> {
        let sub = self.sub_settings(name)?;
        sub.list()
    }

    // =========================================================================
    // Backup & External Configs
    // =========================================================================

    /// Register an external config provider for backups.
    ///
    /// This allows dynamic registration of external files to be included in backups.
    ///
    #[cfg(feature = "backup")]
    pub fn register_external_provider(&self, provider: Box<dyn ExternalConfigProvider>) {
        if let Ok(mut providers) = self.external_providers.write_recovered() {
            providers.push(provider);
        } else {
            debug!("Failed to register external config provider due to lock recovery error");
        }
    }

    /// Get the backup manager
    #[cfg(feature = "backup")]
    pub fn backup(&self) -> BackupManager<'_, S, Schema> {
        BackupManager::new(self)
    }

    /// Get all registered external configs
    ///
    /// Returns the external config files that were registered via
    /// `SettingsConfig::builder().with_external_config(...)`.
    #[cfg(feature = "backup")]
    pub fn external_configs(&self) -> &[crate::backup::ExternalConfig] {
        &self.config.external_configs
    }

    /// Get all export categories for backup UI
    ///
    /// Returns a list of all exportable categories:
    /// - Settings (main settings.json)
    /// - Sub-settings (each registered sub-settings type)
    /// - External configs (each registered external file)
    #[cfg(feature = "backup")]
    pub fn get_export_categories(&self) -> Vec<crate::backup::ExportCategory> {
        use crate::backup::{ExportCategory, ExportCategoryType};

        let mut categories = Vec::new();

        // Main settings
        categories.push(ExportCategory {
            id: "settings".to_string(),
            name: "Application Settings".to_string(),
            category_type: ExportCategoryType::Settings,
            optional: false,
            description: Some("Main application settings".to_string()),
        });

        // Sub-settings
        let sub_types = self.sub_settings_types();
        for sub_type in sub_types {
            categories.push(ExportCategory {
                id: sub_type.clone(),
                name: sub_type.clone(),
                category_type: ExportCategoryType::SubSettings,
                optional: false,
                description: None,
            });
        }

        // External configs
        for ext in &self.config.external_configs {
            categories.push(ExportCategory {
                id: ext.id.clone(),
                name: ext.display_name.clone(),
                category_type: ExportCategoryType::External,
                optional: ext.optional,
                description: ext.description.clone(),
            });
        }

        categories
    }
}
