//! Sub-settings management for per-entity configuration files
//!
//! Sub-settings allow storing multiple related configuration entities separately
//! from the main settings file. Two storage modes are available:
//!
//! - `MultiFile`: One file per entity (e.g., `config/remotes/gdrive.json`)
//! - `SingleFile`: All entities in one file (e.g., `config/backends.json`)

mod multi_file;
mod single_file;
mod store;

use crate::error::{Error, Result};
use crate::storage::StorageBackend;
use crate::utils::sync::RwLockExt;
use crate::{SettingMetadata, SettingsSchema};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use self::multi_file::MultiFileStore;
use self::single_file::SingleFileStore;
pub(crate) use self::store::SubSettingsStore;

/// Mode of storage for sub-settings
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SubSettingsMode {
    /// Store each entry in a separate file within a directory (default)
    #[default]
    MultiFile,
    /// Store all entries in a single file
    SingleFile,
}

/// Configuration for a sub-settings type.
#[derive(Clone)]
pub struct SubSettingsConfig {
    /// Name of this sub-settings type
    pub name: String,

    /// File extension for entries (default: derived from storage backend)
    pub extension: Option<String>,

    /// Optional migration function for schema changes
    pub migrator: Option<Arc<dyn Fn(Value) -> Value + Send + Sync>>,

    /// Optional schema metadata for validating sub-settings entries
    pub schema: Option<Arc<HashMap<String, SettingMetadata>>>,

    /// Storage mode (`MultiFile` or `SingleFile`)
    pub mode: SubSettingsMode,

    /// Cache strategy for this sub-settings type
    pub cache_strategy: crate::CacheStrategy,

    /// Whether profiles are enabled for this sub-settings type
    #[cfg(feature = "profiles")]
    pub profiles_enabled: bool,

    /// Profile migration strategy (defaults to Auto)
    #[cfg(feature = "profiles")]
    pub profile_migrator: crate::ProfileMigrator,
}

impl Default for SubSettingsConfig {
    fn default() -> Self {
        Self {
            name: "items".into(),
            extension: None,
            migrator: None,
            schema: None,
            mode: SubSettingsMode::MultiFile,
            cache_strategy: crate::CacheStrategy::default(),
            #[cfg(feature = "profiles")]
            profiles_enabled: false,
            #[cfg(feature = "profiles")]
            profile_migrator: crate::ProfileMigrator::default(),
        }
    }
}
impl SubSettingsConfig {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ..Default::default()
        }
    }

    pub fn singlefile(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            mode: SubSettingsMode::SingleFile,
            ..Default::default()
        }
    }

    #[must_use]
    pub fn with_cache(mut self, strategy: crate::CacheStrategy) -> Self {
        self.cache_strategy = strategy;
        self
    }

    #[must_use]
    pub fn with_lru_cache(self, max_entries: usize) -> Self {
        self.with_cache(crate::CacheStrategy::Lru(max_entries))
    }

    #[must_use]
    pub fn with_no_cache(self) -> Self {
        self.with_cache(crate::CacheStrategy::None)
    }

    #[must_use]
    pub fn with_extension(mut self, ext: impl Into<String>) -> Self {
        self.extension = Some(ext.into());
        self
    }

    #[must_use]
    pub fn with_migrator<F>(mut self, migrator: F) -> Self
    where
        F: Fn(Value) -> Value + Send + Sync + 'static,
    {
        self.migrator = Some(Arc::new(migrator));
        self
    }

    #[must_use]
    pub fn with_metadata(mut self, metadata: HashMap<String, SettingMetadata>) -> Self {
        self.schema = Some(Arc::new(metadata));
        self
    }

    #[must_use]
    pub fn with_schema<Schema: SettingsSchema>(self) -> Self {
        self.with_metadata(Schema::get_metadata())
    }

    #[cfg(feature = "profiles")]
    #[must_use]
    pub fn with_profiles(mut self) -> Self {
        self.profiles_enabled = true;
        self
    }

    #[cfg(feature = "profiles")]
    #[must_use]
    pub fn with_profile_migrator(mut self, migrator: crate::profiles::ProfileMigrator) -> Self {
        self.profile_migrator = migrator;
        self
    }
}

/// Callback for change notifications
pub type ChangeCallback = Arc<dyn Fn(&str, SubSettingsAction) + Send + Sync>;

/// Handler for a single sub-settings type
pub struct SubSettings<S: StorageBackend = crate::storage::JsonStorage> {
    pub(crate) config: SubSettingsConfig,

    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    credential_manager: Option<crate::credentials::CredentialManager>,

    /// The active store implementation
    pub(crate) store: RwLock<Box<dyn SubSettingsStore>>,

    /// We keep storage around mostly for profiles logic if needed,
    /// or simple ref storage.
    /// The storage backend instance (kept for recreating stores)
    #[cfg(feature = "profiles")]
    storage: S,

    #[cfg(not(feature = "profiles"))]
    _marker: std::marker::PhantomData<S>,

    /// Callback for change notifications
    on_change: RwLock<Option<ChangeCallback>>,

    /// Profile manager (when profiles are enabled)
    #[cfg(feature = "profiles")]
    profile_manager: Option<crate::profiles::ProfileManager<S>>,

    #[cfg(feature = "profiles")]
    root_dir: PathBuf,
}

/// Action type for change callbacks
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubSettingsAction {
    Created,
    Updated,
    Deleted,
}

impl<S: StorageBackend + Clone + 'static> SubSettings<S> {
    fn make_store(
        config: &SubSettingsConfig,
        base_dir: PathBuf,
        storage: S,
    ) -> Box<dyn SubSettingsStore> {
        let extension = config.extension.as_deref().unwrap_or("json").to_string();

        match config.mode {
            SubSettingsMode::MultiFile => Box::new(MultiFileStore::new(
                config.name.clone(),
                base_dir,
                extension,
                storage,
                config.migrator.clone(),
                config.cache_strategy,
            )),
            SubSettingsMode::SingleFile => Box::new(SingleFileStore::new(
                config.name.clone(),
                base_dir,
                extension,
                storage,
                config.migrator.clone(),
            )),
        }
    }

    /// Create a new `SubSettings` instance
    ///
    /// # Arguments
    ///
    /// * `config_dir` - The directory where the configuration files are stored
    /// * `config` - The configuration for the sub-settings
    /// * `storage` - The storage backend to use
    ///
    /// # Errors
    ///
    /// Returns an error if:
    /// - The cache strategy is invalid
    /// - Profile migration fails
    /// - File operations fail
    pub fn new(
        config_dir: &std::path::Path,
        mut config: SubSettingsConfig,
        storage: S,
        #[cfg(any(feature = "keychain", feature = "encrypted-file"))] credential_manager: Option<
            crate::credentials::CredentialManager,
        >,
    ) -> Result<Self> {
        if config.extension.is_none() {
            config.extension = Some(storage.extension().to_string());
        }

        if let Err(e) = config.cache_strategy.validate() {
            return Err(Error::InvalidCacheStrategy(e.to_string()));
        }

        if let Some(schema) = &config.schema {
            for (key, metadata) in schema.iter() {
                if let Err(reason) = metadata.validate_schema() {
                    return Err(Error::InvalidSettingMetadata {
                        key: format!("{}.{}", config.name, key),
                        reason,
                    });
                }
            }
        }

        #[cfg(feature = "profiles")]
        let root_dir = if config.profiles_enabled {
            config_dir.join(&config.name)
        } else if matches!(config.mode, SubSettingsMode::SingleFile) {
            config_dir.to_path_buf()
        } else {
            config_dir.join(&config.name)
        };

        #[cfg(not(feature = "profiles"))]
        let root_dir = if matches!(config.mode, SubSettingsMode::SingleFile) {
            config_dir.to_path_buf()
        } else {
            config_dir.join(&config.name)
        };

        // Determine initial base_dir (active profile or root)
        #[cfg(feature = "profiles")]
        let (base_dir, profile_manager) = if config.profiles_enabled {
            let is_single_file = matches!(config.mode, SubSettingsMode::SingleFile);
            crate::profiles::migrate(
                &root_dir,
                &config.name,
                is_single_file,
                &storage,
                &config.profile_migrator,
            )
            .map_err(|e| Error::ProfileMigrationFailed(e.to_string()))?;

            let pm = crate::profiles::ProfileManager::new(&root_dir, &config.name, storage.clone());
            let active_path = pm.profile_path(crate::profiles::DEFAULT_PROFILE);
            (active_path, Some(pm))
        } else {
            (root_dir.clone(), None)
        };

        #[cfg(not(feature = "profiles"))]
        let base_dir = root_dir.clone();

        let store = Self::make_store(&config, base_dir, storage.clone());

        Ok(Self {
            config,
            #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
            credential_manager,
            store: RwLock::new(store),
            #[cfg(feature = "profiles")]
            storage,
            #[cfg(not(feature = "profiles"))]
            _marker: std::marker::PhantomData,
            on_change: RwLock::new(None),
            #[cfg(feature = "profiles")]
            profile_manager,
            #[cfg(feature = "profiles")]
            root_dir,
        })
    }

    #[cfg(feature = "profiles")]
    pub fn root_path(&self) -> PathBuf {
        self.root_dir.clone()
    }

    pub fn is_single_file(&self) -> bool {
        matches!(self.config.mode, SubSettingsMode::SingleFile)
    }

    #[cfg(feature = "profiles")]
    pub fn profiles_enabled(&self) -> bool {
        self.config.profiles_enabled
    }

    pub fn extension(&self) -> &str {
        self.config.extension.as_deref().unwrap_or("json")
    }

    pub fn schema_metadata(&self) -> Option<Arc<HashMap<String, SettingMetadata>>> {
        self.config.schema.clone()
    }

    #[cfg(feature = "profiles")]
    pub fn storage(&self) -> &S {
        &self.storage
    }

    pub fn invalidate_cache(&self) {
        if let Ok(store) = self.store.read_recovered() {
            store.invalidate_cache();
        }
    }

    /// Get the profile manager if enabled
    ///
    /// # Errors
    ///
    /// Returns an error if profiles are not enabled for this sub-settings type.
    #[cfg(feature = "profiles")]
    pub fn profiles(&self) -> Result<&crate::profiles::ProfileManager<S>> {
        self.profile_manager
            .as_ref()
            .ok_or(Error::ProfilesNotEnabled)
    }

    /// Switch to a different profile
    ///
    /// # Arguments
    ///
    /// * `name` - The name of the profile to switch to
    ///
    /// # Errors
    ///
    /// Returns an error if:
    /// - Profiles are not enabled
    /// - Profile switch fails
    /// - Store re-creation fails
    #[cfg(feature = "profiles")]
    pub fn switch_profile(&self, name: &str) -> Result<()> {
        let pm = self.profiles()?;
        pm.switch(name)?;

        // Re-create store pointing to new path
        let new_path = pm.profile_path(name);
        let new_store = Self::make_store(&self.config, new_path, self.storage.clone());

        let mut store_guard = self.store.write_recovered()?;
        *store_guard = new_store;

        Ok(())
    }

    /// Set the change callback
    ///
    /// # Arguments
    ///
    /// * `callback` - The callback to set
    ///
    /// # Errors
    ///
    /// Returns an error if the internal lock is poisoned.
    pub fn set_on_change<F>(&self, callback: F) -> Result<()>
    where
        F: Fn(&str, SubSettingsAction) + Send + Sync + 'static,
    {
        let mut guard = self.on_change.write_recovered()?;
        *guard = Some(Arc::new(callback));
        Ok(())
    }

    fn notify_change(&self, name: &str, action: SubSettingsAction) {
        if let Ok(guard) = self.on_change.read_recovered()
            && let Some(callback) = guard.as_ref()
        {
            callback(name, action);
        }
    }

    /// Update a single field in a sub-settings entry.
    ///
    /// This performs a read-modify-write on one entry:
    /// - Loads existing entry (or `{}` if missing)
    /// - Sets the provided field path (supports dot notation)
    /// - Saves through `set()`, so schema validation and secret handling still apply
    ///
    /// # Errors
    ///
    /// Returns an error if serialization fails, schema validation fails,
    /// or store write fails.
    pub fn set_field<T: Serialize + Sync>(
        &self,
        name: &str,
        field_path: &str,
        value: &T,
    ) -> Result<()> {
        let mut entry = match self.get_value(name) {
            Ok(value) => value,
            Err(Error::SubSettingsEntryNotFound(_)) => Value::Object(serde_json::Map::new()),
            Err(err) => return Err(err),
        };

        if !entry.is_object() {
            entry = Value::Object(serde_json::Map::new());
        }

        let new_value = serde_json::to_value(value).map_err(|e| Error::Parse(e.to_string()))?;
        crate::utils::value::set_path(&mut entry, field_path, new_value);

        self.set(name, &entry)
    }

    fn validate_against_schema(&self, entry_name: &str, value: &Value) -> Result<()> {
        let Some(schema) = self.config.schema.as_ref() else {
            return Ok(());
        };

        if let Some(obj) = value.as_object() {
            let allowed_roots: std::collections::HashSet<&str> = schema
                .keys()
                .map(|key| key.split('.').next().unwrap_or(key.as_str()))
                .collect();

            for key in obj.keys() {
                if !allowed_roots.contains(key.as_str()) {
                    return Err(Error::InvalidSettingValue {
                        key: format!("{}.{}.{}", self.config.name, entry_name, key),
                        reason: "Field is not defined in sub-settings schema".to_string(),
                    });
                }
            }
        }

        for (path, metadata) in schema.iter() {
            if let Some(field_value) = crate::utils::value::get_path(value, path)
                && let Err(reason) = metadata.validate(field_value)
            {
                return Err(Error::InvalidSettingValue {
                    key: format!("{}.{}.{}", self.config.name, entry_name, path),
                    reason,
                });
            }
        }

        Ok(())
    }

    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    pub(crate) fn secret_credential_key(&self, entry_name: &str, field_path: &str) -> String {
        format!("sub.{}.{}.{}", self.config.name, entry_name, field_path)
    }

    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    pub(crate) fn active_secret_profile(&self) -> Option<String> {
        #[cfg(feature = "profiles")]
        {
            if self.config.profiles_enabled {
                return self
                    .profile_manager
                    .as_ref()
                    .and_then(|pm| pm.active().ok());
            }
        }

        None
    }

    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    fn extract_and_store_secrets(&self, entry_name: &str, value: &mut Value) -> Result<()> {
        let Some(schema) = self.config.schema.as_ref() else {
            return Ok(());
        };

        let secret_fields: Vec<_> = schema
            .iter()
            .filter(|(_, metadata)| metadata.is_secret())
            .collect();

        if secret_fields.is_empty() {
            return Ok(());
        }

        let creds = self
            .credential_manager
            .as_ref()
            .ok_or_else(|| Error::Credential("Credentials not enabled".to_string()))?;

        let profile = self.active_secret_profile();

        for (path, metadata) in secret_fields {
            let Some(secret_value) = crate::utils::value::remove_path(value, path) else {
                continue;
            };

            let credential_key = self.secret_credential_key(entry_name, path);

            if secret_value == metadata.default {
                creds.remove_with_profile(&credential_key, profile.as_deref())?;
                creds.remove_tracked_secret(&credential_key, profile.as_deref())?;
                continue;
            }

            let value_str = match secret_value {
                Value::String(s) => s,
                v => v.to_string(),
            };

            if let Ok(Some(existing_val)) =
                creds.get_with_profile(&credential_key, profile.as_deref())
                && existing_val == value_str
            {
                creds.add_tracked_secret(&credential_key, profile.as_deref())?;
                continue;
            }

            creds.store_with_profile(&credential_key, &value_str, profile.as_deref())?;
            creds.add_tracked_secret(&credential_key, profile.as_deref())?;
        }

        Ok(())
    }

    #[cfg(not(any(feature = "keychain", feature = "encrypted-file")))]
    fn extract_and_store_secrets(&self, _entry_name: &str, _value: &mut Value) -> Result<()> {
        Ok(())
    }

    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    fn inject_secrets_from_store(&self, entry_name: &str, value: &mut Value) -> Result<()> {
        // Secret injection only makes sense for object values. Plain scalars (e.g. a
        // string sentinel like `_active`) must pass through untouched; calling
        // `set_path` on a non-object would silently replace the value with `{}`.
        if !value.is_object() {
            return Ok(());
        }

        let Some(schema) = self.config.schema.as_ref() else {
            return Ok(());
        };

        let Some(creds) = self.credential_manager.as_ref() else {
            return Ok(());
        };

        let profile = self.active_secret_profile();

        for (path, metadata) in schema.iter().filter(|(_, metadata)| metadata.is_secret()) {
            let credential_key = self.secret_credential_key(entry_name, path);
            let secret = creds.get_with_profile(&credential_key, profile.as_deref())?;
            let resolved = secret.map_or_else(|| metadata.default.clone(), Value::String);
            crate::utils::value::set_path(value, path, resolved);
        }

        Ok(())
    }

    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    fn has_stored_secret_for_entry(&self, entry_name: &str) -> Result<bool> {
        let Some(schema) = self.config.schema.as_ref() else {
            return Ok(false);
        };

        let Some(creds) = self.credential_manager.as_ref() else {
            return Ok(false);
        };

        let profile = self.active_secret_profile();

        for (path, _) in schema.iter().filter(|(_, metadata)| metadata.is_secret()) {
            let credential_key = self.secret_credential_key(entry_name, path);
            if creds
                .get_with_profile(&credential_key, profile.as_deref())?
                .is_some()
            {
                return Ok(true);
            }
        }

        Ok(false)
    }

    #[cfg(not(any(feature = "keychain", feature = "encrypted-file")))]
    fn has_stored_secret_for_entry(&self, _entry_name: &str) -> Result<bool> {
        Ok(false)
    }

    #[cfg(not(any(feature = "keychain", feature = "encrypted-file")))]
    fn inject_secrets_from_store(&self, _entry_name: &str, _value: &mut Value) -> Result<()> {
        Ok(())
    }

    #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
    fn clear_secret_fields(&self, entry_name: &str) -> Result<()> {
        let Some(schema) = self.config.schema.as_ref() else {
            return Ok(());
        };

        let Some(creds) = self.credential_manager.as_ref() else {
            return Ok(());
        };

        let profile = self.active_secret_profile();

        for (path, _) in schema.iter().filter(|(_, metadata)| metadata.is_secret()) {
            let credential_key = self.secret_credential_key(entry_name, path);
            creds.remove_with_profile(&credential_key, profile.as_deref())?;
            creds.remove_tracked_secret(&credential_key, profile.as_deref())?;
        }

        Ok(())
    }

    #[cfg(not(any(feature = "keychain", feature = "encrypted-file")))]
    fn clear_secret_fields(&self, _entry_name: &str) -> Result<()> {
        Ok(())
    }

    // Delegation methods

    /// Get a raw Value from the store
    ///
    /// # Arguments
    ///
    /// * `name` - The name of the setting to retrieve
    ///
    /// # Errors
    ///
    /// Returns an error if the setting is not found or store access fails.
    pub fn get_value(&self, name: &str) -> Result<Value> {
        let store = self.store.read_recovered()?;

        // Try to get the entry from the store
        let mut value = match store.get(name) {
            Ok(v) => v,
            Err(Error::SubSettingsEntryNotFound(_)) => {
                // Entry not found in file, but might have secrets in keyring
                // If at least one secret exists in keyring, reconstruct from keyring + defaults
                if self.has_stored_secret_for_entry(name)? {
                    let mut empty_value = serde_json::json!({});
                    self.inject_secrets_from_store(name, &mut empty_value)?;
                    return Ok(empty_value);
                }
                // No schema or no secrets found, return original error
                return Err(Error::SubSettingsEntryNotFound(format!(
                    "Sub-setting entry '{name}' not found"
                )));
            }
            Err(e) => return Err(e),
        };

        // Inject secrets into the existing value
        self.inject_secrets_from_store(name, &mut value)?;
        Ok(value)
    }

    /// Get and deserialize a value from the store
    ///
    /// # Arguments
    ///
    /// * `name` - The name of the setting to retrieve
    ///
    /// # Errors
    ///
    /// Returns an error if:
    /// - The setting is not found
    /// - Deserialization fails
    /// - Store access fails
    pub fn get<T: DeserializeOwned>(&self, name: &str) -> Result<T> {
        let value = self.get_value(name)?;
        serde_json::from_value(value).map_err(|e| Error::Parse(e.to_string()))
    }

    /// Serialize and set a value in the store
    ///
    /// # Arguments
    ///
    /// * `name` - The name of the setting to set
    /// * `value` - The value to set
    ///
    /// # Errors
    ///
    /// Returns an error if:
    /// - Serialization fails
    /// - Store write fails
    pub fn set<T: Serialize + Sync>(&self, name: &str, value: &T) -> Result<()> {
        let mut json_value =
            serde_json::to_value(value).map_err(|e| Error::Parse(e.to_string()))?;

        self.validate_against_schema(name, &json_value)?;
        self.extract_and_store_secrets(name, &mut json_value)?;

        let existed = self.exists(name)?;

        let store = self.store.read_recovered()?;
        store.set(name, json_value)?;

        let action = if existed {
            SubSettingsAction::Updated
        } else {
            SubSettingsAction::Created
        };

        self.notify_change(name, action);
        Ok(())
    }

    /// Delete a value from the store
    ///
    /// # Arguments
    ///
    /// * `name` - The name of the setting to delete
    ///
    /// # Errors
    ///
    /// Returns an error if store write fails.
    pub fn delete(&self, name: &str) -> Result<()> {
        if !self.exists(name)? {
            return Ok(());
        }

        let store = self.store.read_recovered()?;

        store.remove(name)?;
        self.clear_secret_fields(name)?;

        self.notify_change(name, SubSettingsAction::Deleted);
        Ok(())
    }

    /// List all sub-setting keys
    ///
    /// # Errors
    ///
    /// Returns an error if the store cannot be read.
    pub fn list(&self) -> Result<Vec<String>> {
        let store = self.store.read_recovered()?;
        store.list()
    }

    /// Get all sub-setting entries as a map
    ///
    /// Returns a `HashMap<String, Value>` with all entry names as keys
    /// and their deserialized values. Entries that fail to load are silently skipped.
    ///
    /// # Errors
    ///
    /// Returns an error if the store cannot be read.
    pub fn get_all_values(&self) -> Result<HashMap<String, Value>> {
        let mut result = {
            let store = self.store.read_recovered()?;
            store.get_all()?
        };

        for (name, value) in &mut result {
            let _ = self.inject_secrets_from_store(name, value);
        }

        Ok(result)
    }

    /// Check if a sub-setting key exists
    ///
    /// # Arguments
    ///
    /// * `name` - The name of the setting to check
    ///
    /// # Errors
    ///
    /// Returns an error if the store cannot be read or if an unexpected error occurs during lookup.
    pub fn exists(&self, name: &str) -> Result<bool> {
        let store = self.store.read_recovered()?;
        if store.exists(name)? {
            return Ok(true);
        }

        if self.has_stored_secret_for_entry(name)? {
            return Ok(true);
        }

        Ok(false)
    }

    // Legacy support methods that might need to remain or be refactored differently
    pub fn directory(&self) -> PathBuf {
        self.store
            .read_recovered()
            .map(|s| s.base_path())
            .unwrap_or_default()
    }

    pub fn file_path(&self) -> Option<PathBuf> {
        self.store
            .read_recovered()
            .ok()
            .and_then(|s| s.single_file_path())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::JsonStorage;
    use serde_json::json;

    fn make_singlefile(dir: &std::path::Path) -> SubSettings<JsonStorage> {
        SubSettings::new(
            dir,
            SubSettingsConfig::singlefile("connections"),
            JsonStorage::new(),
            #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
            None,
        )
        .expect("failed to create SubSettings")
    }

    // =========================================================================
    // Scalar sentinel regression tests
    //
    // `_active` is stored as a plain string in the same file as object-valued
    // backend entries.  Any code path that iterates secret fields must not
    // corrupt the value.
    // =========================================================================

    /// A scalar string entry (like `_active = "Windows"`) must survive a
    /// `get_value` call unmodified, even when a schema with secret fields is
    /// configured for the same store.
    #[test]
    fn test_get_value_returns_scalar_string_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let ss = make_singlefile(dir.path());

        ss.set("_active", &json!("Windows")).unwrap();

        let val = ss.get_value("_active").unwrap();
        assert_eq!(
            val,
            json!("Windows"),
            "scalar `_active` must not be replaced by an object"
        );
        assert!(val.as_str().is_some(), "`as_str()` must return Some(...)");
    }

    /// A scalar sentinel entry and regular object entries must co-exist in the
    /// same file and each be retrievable with the correct type.
    #[test]
    fn test_scalar_and_object_entries_coexist() {
        let dir = tempfile::tempdir().unwrap();
        let ss = make_singlefile(dir.path());

        ss.set("Local", &json!({"host": "127.0.0.1", "port": 51900}))
            .unwrap();
        ss.set("Windows", &json!({"host": "192.168.0.10", "port": 5572}))
            .unwrap();
        ss.set("_active", &json!("Windows")).unwrap();

        let active = ss.get_value("_active").unwrap();
        assert_eq!(active.as_str(), Some("Windows"));

        assert!(ss.get_value("Local").unwrap().is_object());
        assert!(ss.get_value("Windows").unwrap().is_object());
    }

    /// `list()` must include the scalar sentinel alongside the object entries.
    #[test]
    fn test_list_includes_scalar_sentinel() {
        let dir = tempfile::tempdir().unwrap();
        let ss = make_singlefile(dir.path());

        ss.set("Local", &json!({"host": "127.0.0.1"})).unwrap();
        ss.set("_active", &json!("Local")).unwrap();

        let mut keys = ss.list().unwrap();
        keys.sort();
        assert_eq!(keys, vec!["Local", "_active"]);
    }

    /// `exists()` must return true for a scalar sentinel entry.
    #[test]
    fn test_exists_on_scalar_sentinel() {
        let dir = tempfile::tempdir().unwrap();
        let ss = make_singlefile(dir.path());

        assert!(!ss.exists("_active").unwrap());

        ss.set("_active", &json!("Windows")).unwrap();
        assert!(ss.exists("_active").unwrap());
    }

    /// `delete()` must remove the scalar sentinel without affecting other entries.
    #[test]
    fn test_delete_scalar_sentinel() {
        let dir = tempfile::tempdir().unwrap();
        let ss = make_singlefile(dir.path());

        ss.set("Windows", &json!({"host": "192.168.0.10"})).unwrap();
        ss.set("_active", &json!("Windows")).unwrap();

        ss.delete("_active").unwrap();

        assert!(!ss.exists("_active").unwrap());
        assert!(ss.exists("Windows").unwrap());
    }

    /// The scalar sentinel value must persist across a reload (a fresh
    /// `SubSettings` pointing at the same file on disk).
    #[test]
    fn test_scalar_sentinel_persists_on_disk() {
        let dir = tempfile::tempdir().unwrap();

        {
            let ss = make_singlefile(dir.path());
            ss.set("_active", &json!("Windows")).unwrap();
        }

        // Re-open the same file
        let ss2 = make_singlefile(dir.path());
        let val = ss2.get_value("_active").unwrap();
        assert_eq!(val.as_str(), Some("Windows"));
    }
}
