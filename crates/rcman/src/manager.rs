//! Main settings manager module
//!
//! This module contains the [`SettingsManager`] struct which is the primary entry point
//! for managing application settings.

#[cfg(feature = "backup")]
use crate::backup::BackupManager;
use crate::config::SettingsConfig;
use crate::config::{SettingMetadata, SettingsSchema};
#[cfg(any(feature = "keychain", feature = "encrypted-file"))]
use crate::credentials::CredentialManager;
use crate::error::{Error, Result};
use crate::events::EventManager;
use crate::storage::StorageBackend;
use crate::sub_settings::{SubSettings, SubSettingsConfig};
use log::{debug, info};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::RwLock;

/// Main settings manager for loading, saving, and managing application settings.
///
/// The `SettingsManager` provides a complete solution for application configuration:
///
/// - **Load/Save Settings**: Read and write settings with schema validation
/// - **Sub-Settings**: Manage per-entity configuration files (e.g., per-remote configs)
/// - **Change Events**: Register callbacks for setting changes
/// - **Backup/Restore**: Create and restore encrypted backups
/// - **Caching**: In-memory caching for fast access
/// - **Secret Settings**: Automatic keychain storage for sensitive values
///
/// # Example
///
/// ```rust,no_run
/// use rcman::{SettingsManager, SettingsConfig};
///
/// // Create with builder
/// let config = SettingsConfig::builder("my-app", "1.0.0")
///     .config_dir("~/.config/my-app")
///     .with_credentials()  // Enable secret storage
///     .build();
///
/// let manager = SettingsManager::new(config).unwrap();
/// ```
///
/// # Type Parameters
///
/// * `S` - Storage backend implementation (defaults to [`JsonStorage`](crate::JsonStorage))
pub struct SettingsManager<S: StorageBackend + 'static = crate::storage::JsonStorage> {
    /// Configuration
    config: SettingsConfig<S>,

    /// Storage backend
    storage: S,

    /// Registered sub-settings handlers
    sub_settings: RwLock<HashMap<String, Arc<SubSettings<S>>>>,

    /// Event manager for change callbacks and validation
    events: Arc<EventManager>,

    /// In-memory cache of settings (populated on first load)
    settings_cache: RwLock<Option<Value>>,

    /// Cache of default values (key -> default) for quick lookup
    defaults_cache: RwLock<HashMap<String, Value>>,

    /// Mutex to serialize save operations (prevents race conditions)
    save_mutex: std::sync::Mutex<()>,

    /// Credential manager for secret settings (optional, requires keychain or encrypted-file feature)
    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    credentials: Option<CredentialManager>,
}

impl<S: StorageBackend + 'static> SettingsManager<S> {
    /// Create a new settings manager with the given configuration.
    ///
    /// This will create the config directory if it doesn't exist.
    ///
    /// # Arguments
    ///
    /// * `config` - Configuration specifying paths, app info, and storage backend
    ///
    /// # Errors
    ///
    /// Returns an error if the config directory cannot be created.
    ///
    /// # Example
    ///
    /// ```rust,no_run
    /// use rcman::{SettingsManager, SettingsConfig};
    ///
    /// let config = SettingsConfig::builder("my-app", "1.0.0").build();
    /// let manager = SettingsManager::new(config)?;
    /// # Ok::<(), rcman::Error>(())
    /// ```
    pub fn new(config: SettingsConfig<S>) -> Result<Self> {
        // Ensure config directory exists
        if !config.config_dir.exists() {
            std::fs::create_dir_all(&config.config_dir).map_err(|e| Error::DirectoryCreate {
                path: config.config_dir.display().to_string(),
                source: e,
            })?;
        }

        let storage = config.storage.clone();

        // Initialize credential manager if enabled and feature is available
        #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
        let credentials = if config.enable_credentials {
            info!("🔐 Credential management enabled for secret settings");
            Some(CredentialManager::new(&config.app_name))
        } else {
            None
        };

        info!(
            "📦 Initialized rcman SettingsManager at: {:?}",
            config.config_dir
        );

        Ok(Self {
            config,
            storage,
            sub_settings: RwLock::new(HashMap::new()),
            events: Arc::new(EventManager::new()),
            settings_cache: RwLock::new(None),
            defaults_cache: RwLock::new(HashMap::new()),
            save_mutex: std::sync::Mutex::new(()),
            #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
            credentials,
        })
    }

    /// Get the configuration
    pub fn config(&self) -> &SettingsConfig<S> {
        &self.config
    }

    /// Get the environment variable name for a setting key
    ///
    /// Returns None if env var overrides are disabled.
    /// Format: {PREFIX}_{CATEGORY}_{KEY} (all uppercase)
    ///
    /// Example: with prefix "MYAPP" and key "ui.theme" -> "MYAPP_UI_THEME"
    #[inline]
    fn get_env_var_name(&self, key: &str) -> Option<String> {
        self.config.env_prefix.as_ref().map(|prefix| {
            let env_key = key.replace('.', "_").to_uppercase();
            format!("{}_{}", prefix.to_uppercase(), env_key)
        })
    }

    /// Check if a setting value is overridden by an environment variable
    ///
    /// Returns the parsed value if env var is set and successfully parsed.
    fn get_env_override(&self, key: &str) -> Option<Value> {
        let env_var_name = self.get_env_var_name(key)?;
        std::env::var(&env_var_name).ok().map(|env_value| {
            // Try to parse as JSON first, fallback to string
            serde_json::from_str(&env_value).unwrap_or_else(|_| {
                // If not valid JSON, treat as string
                // But also try to parse booleans and numbers
                if env_value.eq_ignore_ascii_case("true") {
                    Value::Bool(true)
                } else if env_value.eq_ignore_ascii_case("false") {
                    Value::Bool(false)
                } else if let Ok(n) = env_value.parse::<i64>() {
                    Value::Number(n.into())
                } else if let Ok(n) = env_value.parse::<f64>() {
                    serde_json::Number::from_f64(n)
                        .map(Value::Number)
                        .unwrap_or_else(|| Value::String(env_value.clone()))
                } else {
                    Value::String(env_value)
                }
            })
        })
    }

    /// Get the event manager for registering change listeners and validators
    ///
    /// # Example
    /// ```ignore
    /// // Watch all changes
    /// manager.events().on_change(|key, old, new| {
    ///     println!("Changed {}: {:?} -> {:?}", key, old, new);
    /// });
    ///
    /// // Watch specific key
    /// manager.events().watch("theme", |key, old, new| {
    ///     apply_theme(new);
    /// });
    ///
    /// // Add validator
    /// manager.events().add_validator("port", |v| {
    ///     if v.as_i64().map(|n| n > 0 && n <= 65535).unwrap_or(false) {
    ///         Ok(())
    ///     } else {
    ///         Err("Invalid port".into())
    ///     }
    /// });
    /// ```
    pub fn events(&self) -> &Arc<EventManager> {
        &self.events
    }

    /// Get reference to credential manager (if configured)
    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    pub fn credentials(&self) -> Option<&crate::credentials::CredentialManager> {
        self.credentials.as_ref()
    }

    /// Invalidate the settings cache
    ///
    /// Call this if the settings file was modified externally.
    pub fn invalidate_cache(&self) {
        let mut cache = self.settings_cache.write().unwrap();
        *cache = None;
        debug!("🗑️ Settings cache invalidated");
    }

    /// Load settings synchronously (for startup initialization).
    ///
    /// This merges stored settings with defaults from the schema and populates
    /// the in-memory cache.
    ///
    /// # Type Parameters
    ///
    /// * `T` - Your settings struct that implements [`SettingsSchema`]
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// let settings: MySettings = manager.load_startup::<MySettings>()?;
    /// ```
    pub fn load_startup<T: SettingsSchema>(&self) -> Result<T> {
        let path = self.config.settings_path();

        // Load stored settings or use empty object
        // Load stored settings or use empty object
        let stored: Value = match self.storage.read(&path) {
            Ok(v) => v,
            Err(Error::FileRead { source, .. })
                if source.kind() == std::io::ErrorKind::NotFound =>
            {
                json!({})
            }
            Err(e) => return Err(e),
        };

        // Populate cache
        // Use try_write to avoid blocking - if locked, skip cache update
        if let Ok(mut cache) = self.settings_cache.try_write() {
            *cache = Some(stored.clone());
            debug!("📦 Settings cache populated");
        }

        // Get defaults
        let default = T::default();
        let mut merged = serde_json::to_value(&default)?;

        // Merge stored on top of defaults
        if let (Some(merged_obj), Some(stored_obj)) = (merged.as_object_mut(), stored.as_object()) {
            for (category, values) in stored_obj {
                if let Some(merged_cat) = merged_obj.get_mut(category) {
                    if let (Some(merged_cat_obj), Some(values_obj)) =
                        (merged_cat.as_object_mut(), values.as_object())
                    {
                        for (key, val) in values_obj {
                            merged_cat_obj.insert(key.clone(), val.clone());
                        }
                    }
                }
            }
        }

        serde_json::from_value(merged).map_err(|e| Error::Parse(e.to_string()))
    }

    /// Load settings with metadata (for UI)
    ///
    /// Returns metadata map with current values populated.
    /// Uses in-memory cache when available.
    pub fn load_settings<T: SettingsSchema>(&self) -> Result<HashMap<String, SettingMetadata>> {
        // Try to use cache first
        let stored: Value = {
            let cache = self.settings_cache.read().unwrap();
            if let Some(cached) = cache.as_ref() {
                debug!("📦 Using cached settings");
                cached.clone()
            } else {
                drop(cache); // Release read lock before acquiring write lock

                // Cache miss - load from disk
                let path = self.config.settings_path();
                let from_disk: Value = match self.storage.read(&path) {
                    Ok(v) => v,
                    Err(Error::FileRead { source, .. })
                        if source.kind() == std::io::ErrorKind::NotFound =>
                    {
                        json!({})
                    }
                    Err(e) => return Err(e),
                };

                // Populate cache
                let mut cache = self.settings_cache.write().unwrap();
                *cache = Some(from_disk.clone());
                debug!("📦 Settings cache populated from disk");

                from_disk
            }
        };

        // Get metadata and populate values + cache defaults
        let mut metadata = T::get_metadata();
        let mut defaults_to_cache = HashMap::new();

        for (key, option) in metadata.iter_mut() {
            let parts: Vec<&str> = key.split('.').collect();
            if parts.len() == 2 {
                let category = parts[0];
                let setting_name = parts[1];

                // Cache the default value
                defaults_to_cache.insert(key.clone(), option.default.clone());

                // Handle secret settings - fetch from credential manager
                #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
                if option.secret {
                    // Check env var override for secrets if enabled
                    if self.config.env_overrides_secrets {
                        if let Some(env_value) = self.get_env_override(key) {
                            option.value = Some(env_value);
                            option.env_override = true;
                            debug!("🌍 Secret {} overridden by env var", key);
                            continue;
                        }
                    }

                    if let Some(ref creds) = self.credentials {
                        if let Ok(Some(secret_value)) = creds.get(key) {
                            option.value = Some(Value::String(secret_value));
                            continue;
                        }
                    }
                    // Secret not found in keychain, use default
                    option.value = Some(option.default.clone());
                    continue;
                }

                // Priority: env var override > stored value > default
                // Check for environment variable override first
                if let Some(env_value) = self.get_env_override(key) {
                    option.value = Some(env_value);
                    option.env_override = true; // Mark as env-overridden for UI
                    debug!("🌍 Setting {} overridden by env var", key);
                    continue;
                }

                // Get effective value (stored or default)
                let effective_value = stored
                    .get(category)
                    .and_then(|cat| cat.get(setting_name))
                    .cloned()
                    .unwrap_or_else(|| option.default.clone());

                option.value = Some(effective_value);
            }
        }

        // Store defaults in cache
        {
            let mut defaults = self.defaults_cache.write().unwrap();
            *defaults = defaults_to_cache;
            debug!(
                "📦 Defaults cache populated with {} entries",
                defaults.len()
            );
        }

        info!("✅ Settings loaded successfully");
        Ok(metadata)
    }

    /// Save a single setting value.
    ///
    /// This method validates the value, updates the cache, and writes to disk.
    /// If the setting is marked as `secret: true` and credentials are enabled,
    /// the value will be stored in the OS keychain instead of the settings file.
    /// If the value equals the default, it will be removed from storage.
    /// If the value is unchanged, no I/O occurs.
    ///
    /// # Arguments
    ///
    /// * `category` - Category name (e.g., "ui", "general")
    /// * `key` - Setting key within the category (e.g., "theme", "language")
    /// * `value` - New value as JSON
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// manager.save_setting::<MySettings>("ui", "theme", json!("dark"))?;
    /// ```
    pub fn save_setting<T: SettingsSchema>(
        &self,
        category: &str,
        key: &str,
        value: Value,
    ) -> Result<()> {
        // Acquire save mutex to prevent race conditions
        let _save_guard = self.save_mutex.lock().unwrap();

        let path = self.config.settings_path();
        let full_key = format!("{}.{}", category, key);

        // Validate the value before saving
        self.events
            .validate(&full_key, &value)
            .map_err(|msg| Error::InvalidSettingValue {
                category: category.to_string(),
                key: key.to_string(),
                reason: msg,
            })?;

        // Get metadata for this schema (needed for secret checking and validation)
        // Note: For performance-critical apps with many settings, consider implementing
        // a caching layer in your SettingsSchema implementation
        let metadata = T::get_metadata();

        // Handle secret settings separately
        #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
        if metadata.get(&full_key).map(|m| m.secret).unwrap_or(false) {
            if let Some(ref creds) = self.credentials {
                // Get default value from metadata
                let default_value = metadata
                    .get(&full_key)
                    .map(|m| m.default.clone())
                    .unwrap_or(Value::Null);

                // If value equals default, remove from keychain (keep storage minimal)
                if value == default_value {
                    creds.remove(&full_key)?;
                    info!(
                        "🔄 Secret {} set to default, removed from keychain",
                        full_key
                    );
                    return Ok(());
                }

                let value_str = match &value {
                    Value::String(s) => s.clone(),
                    _ => value.to_string(),
                };
                creds.store(&full_key, &value_str)?;
                info!("🔐 Secret setting {} stored in keychain", full_key);
                return Ok(());
            }
            debug!(
                "⚠️ Setting {} is secret but credentials not enabled, storing in file",
                full_key
            );
        }

        // Load current settings from cache or disk
        let mut stored: Value = {
            let cache = self.settings_cache.read().unwrap();
            if let Some(cached) = cache.as_ref() {
                cached.clone()
            } else {
                drop(cache);
                match self.storage.read(&path) {
                    Ok(v) => v,
                    Err(Error::FileRead { source, .. })
                        if source.kind() == std::io::ErrorKind::NotFound =>
                    {
                        json!({})
                    }
                    Err(e) => return Err(e),
                }
            }
        };

        // Get default value from cache (or fallback to metadata)
        let metadata_key = format!("{}.{}", category, key);

        // We need metadata for validation, so fetch it directly
        let validator = metadata.get(&metadata_key);
        let default_value = validator.map(|m| m.default.clone()).unwrap_or(Value::Null);

        // Validate value
        if let Some(m) = validator {
            if let Err(e) = m.validate(&value) {
                return Err(Error::Config(format!(
                    "Validation failed for {}.{}: {}",
                    category, key, e
                )));
            }
        }

        // Get old value for change notification
        let old_value = stored
            .get(category)
            .and_then(|cat| cat.get(key))
            .cloned()
            .unwrap_or_else(|| default_value.clone());

        // Skip if value unchanged
        if old_value == value {
            debug!("⏭️ Setting {}.{} unchanged, skipping save", category, key);
            return Ok(());
        }

        // Ensure stored is an object
        let stored_obj = stored
            .as_object_mut()
            .ok_or_else(|| Error::Parse("Settings root is not an object".into()))?;

        // Ensure category exists
        if !stored_obj.contains_key(category) {
            stored_obj.insert(category.to_string(), json!({}));
        }

        let category_obj = stored_obj
            .get_mut(category)
            .and_then(|v| v.as_object_mut())
            .ok_or_else(|| Error::Parse(format!("Category {} is not an object", category)))?;

        // If value equals default, remove it (keep settings file minimal)
        if value == default_value {
            category_obj.remove(key);
            debug!(
                "🔄 Setting {}.{} set to default, removed from store",
                category, key
            );
        } else {
            category_obj.insert(key.to_string(), value.clone());
            debug!("📝 Saved setting {}.{}", category, key);
        }

        // Remove empty categories
        if category_obj.is_empty() {
            stored_obj.remove(category);
        }

        // Save to file
        self.storage.write(&path, &stored)?;

        // Update cache
        {
            let mut cache = self.settings_cache.write().unwrap();
            *cache = Some(stored);
        }

        info!("✅ Setting {}.{} saved", category, key);

        // Notify change listeners
        self.events.notify(&full_key, &old_value, &value);

        Ok(())
    }

    /// Reset a single setting to default
    pub fn reset_setting<T: SettingsSchema>(&self, category: &str, key: &str) -> Result<Value> {
        let metadata_key = format!("{}.{}", category, key);
        let default_value = T::get_metadata()
            .get(&metadata_key)
            .map(|m| m.default.clone())
            .ok_or_else(|| Error::SettingNotFound {
                category: category.to_string(),
                key: key.to_string(),
            })?;

        self.save_setting::<T>(category, key, default_value.clone())?;

        info!("✅ Setting {}.{} reset to default", category, key);
        Ok(default_value)
    }

    /// Reset all settings to defaults
    pub fn reset_all(&self) -> Result<()> {
        let path = self.config.settings_path();

        // Write empty object
        self.storage.write(&path, &json!({}))?;

        info!("✅ All settings reset to defaults");
        Ok(())
    }

    // =========================================================================
    // Sub-Settings Management
    // =========================================================================

    /// Register a sub-settings type for per-entity configuration.
    ///
    /// Sub-settings allow you to manage separate config files for each entity
    /// (e.g., one file per remote, per profile, etc.).
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// manager.register_sub_settings(SubSettingsConfig::new("remotes"));
    /// manager.register_sub_settings(SubSettingsConfig::new("profiles"));
    /// ```
    pub fn register_sub_settings(&self, config: SubSettingsConfig) {
        let name = config.name.clone();
        let handler = Arc::new(SubSettings::new(
            &self.config.config_dir,
            config,
            self.storage.clone(),
        ));

        let mut guard = self.sub_settings.write().unwrap();
        guard.insert(name.clone(), handler);

        info!("📁 Registered sub-settings type: {}", name);
    }

    /// Get a registered sub-settings handler.
    ///
    /// Returns the handler for the specified sub-settings type, which can be used
    /// to read, write, and manage individual entries.
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// let remotes = manager.sub_settings("remotes")?;
    /// remotes.set("gdrive", &json!({"type": "drive"}))?;
    /// let config = remotes.get_value("gdrive")?;
    /// ```
    pub fn sub_settings(&self, name: &str) -> Result<Arc<SubSettings<S>>> {
        let guard = self.sub_settings.read().unwrap();
        guard
            .get(name)
            .cloned()
            .ok_or_else(|| Error::SubSettingsNotRegistered(name.to_string()))
    }

    /// Check if a sub-settings type is registered
    pub fn has_sub_settings(&self, name: &str) -> bool {
        let guard = self.sub_settings.read().unwrap();
        guard.contains_key(name)
    }

    /// Get all registered sub-settings types
    pub fn sub_settings_types(&self) -> Vec<String> {
        let guard = self.sub_settings.read().unwrap();
        guard.keys().cloned().collect()
    }

    /// List all entries in a sub-settings type (convenience method)
    ///
    /// This is a shorthand for `manager.sub_settings(name)?.list()?`
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// // Instead of:
    /// let items = manager.sub_settings("remotes")?.list()?;
    ///
    /// // Use:
    /// let items = manager.list_sub_settings("remotes")?;
    /// ```
    pub fn list_sub_settings(&self, name: &str) -> Result<Vec<String>> {
        let sub = self.sub_settings(name)?;
        sub.list()
    }

    // =========================================================================
    // Backup Manager Access
    // =========================================================================

    /// Get the backup manager
    #[cfg(feature = "backup")]
    pub fn backup(&self) -> BackupManager<'_, S> {
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
    ///
    /// # Example
    /// ```rust,ignore
    /// let categories = manager.get_export_categories();
    /// for cat in categories {
    ///     println!("{}: {:?}", cat.name, cat.category_type);
    /// }
    /// ```
    #[cfg(feature = "backup")]
    pub fn get_export_categories(&self) -> Vec<crate::backup::ExportCategory> {
        use crate::backup::{ExportCategory, ExportCategoryType};

        let mut categories = Vec::new();

        // 1. Main settings
        categories.push(ExportCategory {
            id: "settings".to_string(),
            name: "Application Settings".to_string(),
            category_type: ExportCategoryType::Settings,
            optional: false,
            description: Some("Main application settings".to_string()),
        });

        // 2. Sub-settings
        let sub_types = self.sub_settings_types();
        for sub_type in sub_types {
            categories.push(ExportCategory {
                id: sub_type.clone(),
                name: sub_type.clone(), // Could be enhanced with display names
                category_type: ExportCategoryType::SubSettings,
                optional: false,
                description: None,
            });
        }

        // 3. External configs
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

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SettingsConfig;
    use crate::config::{SettingMetadata, SettingType, SettingsSchema};
    use crate::storage::JsonStorage;
    use serde::{Deserialize, Serialize};
    use tempfile::tempdir;

    #[derive(Debug, Default, Serialize, Deserialize)]
    struct TestSettings {
        general: GeneralSettings,
    }

    #[derive(Debug, Serialize, Deserialize)]
    struct GeneralSettings {
        language: String,
        dark_mode: bool,
    }

    impl Default for GeneralSettings {
        fn default() -> Self {
            Self {
                language: "en".into(),
                dark_mode: false,
            }
        }
    }

    impl SettingsSchema for TestSettings {
        fn get_metadata() -> HashMap<String, SettingMetadata> {
            let mut map = HashMap::new();
            map.insert(
                "general.language".into(),
                SettingMetadata {
                    setting_type: SettingType::Select,
                    default: json!("en"),
                    label: "Language".into(),
                    ..Default::default()
                },
            );
            map.insert(
                "general.dark_mode".into(),
                SettingMetadata {
                    setting_type: SettingType::Toggle,
                    default: json!(false),
                    label: "Dark Mode".into(),
                    ..Default::default()
                },
            );
            map
        }
    }

    #[test]
    fn test_load_startup_defaults() {
        let dir = tempdir().unwrap();
        let config = SettingsConfig {
            config_dir: dir.path().to_path_buf(),
            settings_file: "settings.json".into(),
            app_name: "test".into(),
            app_version: "1.0.0".into(),
            storage: JsonStorage::new(),
            enable_credentials: false,
            external_configs: Vec::new(),
            env_prefix: None,
            env_overrides_secrets: false,
        };

        let manager = SettingsManager::new(config).unwrap();
        let settings: TestSettings = manager.load_startup().unwrap();

        assert_eq!(settings.general.language, "en");
        assert!(!settings.general.dark_mode);
    }

    #[test]
    fn test_load_startup_with_stored() {
        let dir = tempdir().unwrap();

        // Write some stored settings
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"general": {"language": "tr"}}"#,
        )
        .unwrap();

        let config = SettingsConfig {
            config_dir: dir.path().to_path_buf(),
            settings_file: "settings.json".into(),
            app_name: "test".into(),
            app_version: "1.0.0".into(),
            storage: JsonStorage::new(),
            enable_credentials: false,
            external_configs: Vec::new(),
            env_prefix: None,
            env_overrides_secrets: false,
        };

        let manager = SettingsManager::new(config).unwrap();
        let settings: TestSettings = manager.load_startup().unwrap();

        // Stored value should override default
        assert_eq!(settings.general.language, "tr");
        // Non-stored value should use default
        assert!(!settings.general.dark_mode);
    }

    #[test]
    fn test_save_and_load_setting() {
        let dir = tempdir().unwrap();
        let config = SettingsConfig {
            config_dir: dir.path().to_path_buf(),
            settings_file: "settings.json".into(),
            app_name: "test".into(),
            app_version: "1.0.0".into(),
            storage: JsonStorage::new(),
            enable_credentials: false,
            external_configs: Vec::new(),
            env_prefix: None,
            env_overrides_secrets: false,
        };

        let manager = SettingsManager::new(config).unwrap();

        // Save a setting
        manager
            .save_setting::<TestSettings>("general", "language", json!("de"))
            .unwrap();

        // Load settings
        let metadata = manager.load_settings::<TestSettings>().unwrap();
        let lang = metadata.get("general.language").unwrap();

        assert_eq!(lang.value, Some(json!("de")));
    }

    #[test]
    fn test_reset_setting() {
        let dir = tempdir().unwrap();
        let config = SettingsConfig {
            config_dir: dir.path().to_path_buf(),
            settings_file: "settings.json".into(),
            app_name: "test".into(),
            app_version: "1.0.0".into(),
            storage: JsonStorage::new(),
            enable_credentials: false,
            external_configs: Vec::new(),
            env_prefix: None,
            env_overrides_secrets: false,
        };

        let manager = SettingsManager::new(config).unwrap();

        // Save a non-default value
        manager
            .save_setting::<TestSettings>("general", "dark_mode", json!(true))
            .unwrap();

        // Reset it
        let default = manager
            .reset_setting::<TestSettings>("general", "dark_mode")
            .unwrap();

        assert_eq!(default, json!(false));
    }

    #[test]
    fn test_sub_settings_registration() {
        let dir = tempdir().unwrap();
        let config = SettingsConfig {
            config_dir: dir.path().to_path_buf(),
            settings_file: "settings.json".into(),
            app_name: "test".into(),
            app_version: "1.0.0".into(),
            storage: JsonStorage::new(),
            enable_credentials: false,
            external_configs: Vec::new(),
            env_prefix: None,
            env_overrides_secrets: false,
        };

        let manager = SettingsManager::new(config).unwrap();

        // Register sub-settings
        manager.register_sub_settings(SubSettingsConfig::new("remotes"));

        assert!(manager.has_sub_settings("remotes"));
        assert!(!manager.has_sub_settings("nonexistent"));

        // Use sub-settings
        let remotes = manager.sub_settings("remotes").unwrap();
        remotes.set("gdrive", &json!({"type": "drive"})).unwrap();

        let loaded = remotes.get_value("gdrive").unwrap();
        assert_eq!(loaded["type"], json!("drive"));
    }

    #[test]
    fn test_env_var_override() {
        let dir = tempdir().unwrap();
        let config = SettingsConfig {
            config_dir: dir.path().to_path_buf(),
            settings_file: "settings.json".into(),
            app_name: "test".into(),
            app_version: "1.0.0".into(),
            storage: JsonStorage::new(),
            enable_credentials: false,
            env_prefix: Some("RCMAN_TEST".to_string()),
            env_overrides_secrets: false,
            external_configs: Vec::new(),
        };

        let manager = SettingsManager::new(config).unwrap();

        // Set an environment variable for testing
        std::env::set_var("RCMAN_TEST_GENERAL_LANGUAGE", "fr");

        // Load settings - should get value from env var
        let metadata = manager.load_settings::<TestSettings>().unwrap();
        let lang = metadata.get("general.language").unwrap();

        // Value should be from env var, not default
        assert_eq!(lang.value, Some(json!("fr")));
        // Should be marked as env override
        assert!(
            lang.env_override,
            "Setting should be marked as env-overridden"
        );

        // Clean up
        std::env::remove_var("RCMAN_TEST_GENERAL_LANGUAGE");
    }

    #[test]
    fn test_env_var_priority_over_stored() {
        let dir = tempdir().unwrap();

        // First, store a value in the settings file
        let stored = json!({
            "general": {
                "language": "de"
            }
        });
        std::fs::write(
            dir.path().join("settings.json"),
            serde_json::to_string_pretty(&stored).unwrap(),
        )
        .unwrap();

        let config = SettingsConfig {
            config_dir: dir.path().to_path_buf(),
            settings_file: "settings.json".into(),
            app_name: "test".into(),
            app_version: "1.0.0".into(),
            storage: JsonStorage::new(),
            enable_credentials: false,
            env_prefix: Some("RCMAN_TEST2".to_string()),
            env_overrides_secrets: false,
            external_configs: Vec::new(),
        };

        let manager = SettingsManager::new(config).unwrap();

        // Set env var - should take priority over stored value
        std::env::set_var("RCMAN_TEST2_GENERAL_LANGUAGE", "es");

        let metadata = manager.load_settings::<TestSettings>().unwrap();
        let lang = metadata.get("general.language").unwrap();

        // Env var should win over stored value
        assert_eq!(lang.value, Some(json!("es")));
        assert!(lang.env_override);

        std::env::remove_var("RCMAN_TEST2_GENERAL_LANGUAGE");
    }

    #[test]
    fn test_env_var_type_parsing() {
        let dir = tempdir().unwrap();
        let config = SettingsConfig {
            config_dir: dir.path().to_path_buf(),
            settings_file: "settings.json".into(),
            app_name: "test".into(),
            app_version: "1.0.0".into(),
            storage: JsonStorage::new(),
            enable_credentials: false,
            env_prefix: Some("RCMAN_TEST3".to_string()),
            env_overrides_secrets: false,
            external_configs: Vec::new(),
        };

        let manager = SettingsManager::new(config).unwrap();

        // Test boolean parsing
        std::env::set_var("RCMAN_TEST3_GENERAL_DARK_MODE", "true");

        let metadata = manager.load_settings::<TestSettings>().unwrap();
        let dark_mode = metadata.get("general.dark_mode").unwrap();

        // Should parse "true" as boolean true
        assert_eq!(dark_mode.value, Some(json!(true)));

        std::env::remove_var("RCMAN_TEST3_GENERAL_DARK_MODE");
    }
}
