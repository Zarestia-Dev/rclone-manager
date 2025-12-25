//! Sub-settings management for per-entity configuration files

use crate::error::{Error, Result};
use crate::storage::StorageBackend;
use log::{debug, info, warn};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::RwLock;

/// Mode of storage for sub-settings
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SubSettingsMode {
    /// Store each entry in a separate file within a directory (default)
    #[default]
    MultiFile,
    /// Store all entries in a single JSON file
    SingleFile,
}

/// Configuration for a sub-settings type
#[derive(Clone)]
pub struct SubSettingsConfig {
    /// Name of this sub-settings type
    /// - Multi-file mode: used as directory name (e.g., "remotes" → config/remotes/)
    /// - Single-file mode: used as file name (e.g., "backends" → config/backends.json)
    pub name: String,

    /// File extension for entries (default: "json")
    pub extension: String,

    /// Optional migration function for schema changes
    pub migrator: Option<Arc<dyn Fn(Value) -> Value + Send + Sync>>,

    /// Storage mode (MultiFile or SingleFile)
    pub mode: SubSettingsMode,
}

impl Default for SubSettingsConfig {
    fn default() -> Self {
        Self {
            name: "items".into(),
            extension: "json".into(),
            migrator: None,
            mode: SubSettingsMode::MultiFile,
        }
    }
}

impl SubSettingsConfig {
    /// Create a new sub-settings config
    ///
    /// # Arguments
    /// * `name` - Name of this sub-settings type (used as directory or file name)
    ///
    /// By default, creates a directory with separate files for each entity.
    /// Use `.single_file()` to store all entities in one JSON file instead.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ..Default::default()
        }
    }

    /// Set a custom file extension
    pub fn with_extension(mut self, ext: impl Into<String>) -> Self {
        self.extension = ext.into();
        self
    }

    /// Set a migration function for schema changes (lazy migration)
    ///
    /// The migrator function is called automatically when loading an entry.
    /// If the function modifies the value, the migrated version is saved back.
    ///
    /// Use this to upgrade old data formats to new ones transparently.
    ///
    /// # Example
    ///
    /// ```rust
    /// use rcman::SubSettingsConfig;
    /// use serde_json::json;
    ///
    /// // Migrate old schema: add "version" field if missing
    /// let config = SubSettingsConfig::new("remotes")
    ///     .with_migrator(|mut value| {
    ///         if let Some(obj) = value.as_object_mut() {
    ///             if !obj.contains_key("version") {
    ///                 obj.insert("version".into(), json!(2));
    ///             }
    ///         }
    ///         value
    ///     });
    /// ```
    pub fn with_migrator<F>(mut self, migrator: F) -> Self
    where
        F: Fn(Value) -> Value + Send + Sync + 'static,
    {
        self.migrator = Some(Arc::new(migrator));
        self
    }

    /// Enable single-file mode
    ///
    /// Instead of creating a directory with separate files for each entity,
    /// all entities will be stored in one JSON file with entity names as keys.
    ///
    /// # Example
    ///
    /// ```rust
    /// use rcman::SubSettingsConfig;
    ///
    /// // Multi-file mode (default): creates remotes/gdrive.json, remotes/s3.json
    /// let config = SubSettingsConfig::new("remotes");
    ///
    /// // Single-file mode: creates backends.json containing {"gdrive": {...}, "s3": {...}}
    /// let config = SubSettingsConfig::new("backends").single_file();
    /// ```
    pub fn single_file(mut self) -> Self {
        self.mode = SubSettingsMode::SingleFile;
        self
    }
}

/// Handler for a single sub-settings type
pub struct SubSettings<S: StorageBackend> {
    /// Configuration
    config: SubSettingsConfig,

    /// Base directory for this sub-settings type
    base_dir: PathBuf,

    /// Storage backend
    storage: S,

    /// Mutex to serialize save operations (prevents race conditions)
    save_mutex: std::sync::Mutex<()>,

    /// Callback for change notifications
    #[allow(clippy::type_complexity)]
    on_change: RwLock<Option<Arc<dyn Fn(&str, SubSettingsAction) + Send + Sync>>>,
}

/// Action type for change callbacks
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubSettingsAction {
    Created,
    Updated,
    Deleted,
}

impl<S: StorageBackend> SubSettings<S> {
    /// Create a new sub-settings handler
    pub fn new(config_dir: &std::path::Path, config: SubSettingsConfig, storage: S) -> Self {
        // In single-file mode, base_dir is the config dir (file will be {directory}.json)
        // In multi-file mode, base_dir is the directory (files will be {name}.json inside it)
        let base_dir = if matches!(config.mode, SubSettingsMode::SingleFile) {
            config_dir.to_path_buf()
        } else {
            config_dir.join(&config.name)
        };
        Self {
            config,
            base_dir,
            storage,
            save_mutex: std::sync::Mutex::new(()),
            on_change: RwLock::new(None),
        }
    }

    /// Get the single-file path (for single-file mode)
    fn single_file_path(&self) -> PathBuf {
        self.base_dir
            .join(format!("{}.{}", self.config.name, self.config.extension))
    }

    /// Get the file path for an entry (multi-file mode only)
    fn entry_path(&self, name: &str) -> PathBuf {
        if self.is_single_file() {
            // In single-file mode, all entries are in the single file
            self.single_file_path()
        } else {
            self.base_dir
                .join(format!("{}.{}", name, self.config.extension))
        }
    }

    /// Check if we're in single-file mode
    fn is_single_file(&self) -> bool {
        matches!(self.config.mode, SubSettingsMode::SingleFile)
    }

    /// Set a callback for change notifications
    pub fn set_on_change<F>(&self, callback: F)
    where
        F: Fn(&str, SubSettingsAction) + Send + Sync + 'static,
    {
        let mut guard = self.on_change.write().unwrap();
        *guard = Some(Arc::new(callback));
    }

    /// Notify about a change
    fn notify_change(&self, name: &str, action: SubSettingsAction) {
        let guard = self.on_change.read().unwrap();
        if let Some(callback) = guard.as_ref() {
            callback(name, action);
        }
    }

    /// Load an entry (returns raw JSON Value)
    pub fn get_value(&self, name: &str) -> Result<Value> {
        if self.is_single_file() {
            // Single-file mode: read from a key within the single file
            let path = self.single_file_path();

            // Check file presence strictly
            if let Err(e) = std::fs::metadata(&path) {
                if e.kind() == std::io::ErrorKind::NotFound {
                    return Err(Error::SubSettingsEntryNotFound {
                        settings_type: self.config.name.clone(),
                        name: name.to_string(),
                    });
                }
                return Err(Error::FileRead {
                    path: path.display().to_string(),
                    source: e,
                });
            }

            let file_data: Value = self.storage.read(&path)?;
            let obj = file_data.as_object().ok_or_else(|| {
                Error::InvalidBackup("Single-file sub-settings is not a JSON object".to_string())
            })?;

            let mut value =
                obj.get(name)
                    .cloned()
                    .ok_or_else(|| Error::SubSettingsEntryNotFound {
                        settings_type: self.config.name.clone(),
                        name: name.to_string(),
                    })?;

            // Apply migration if configured
            if let Some(migrator) = &self.config.migrator {
                let original = value.clone();
                value = migrator(value);

                // If migration changed the value, persist it
                if value != original {
                    debug!("Migrated sub-settings entry: {}", name);
                    let mut new_obj = obj.clone();
                    new_obj.insert(name.to_string(), value.clone());
                    self.storage.write(&path, &Value::Object(new_obj))?;
                }
            }

            Ok(value)
        } else {
            // Multi-file mode: read from individual file
            let path = self.entry_path(name);

            if let Err(e) = std::fs::metadata(&path) {
                if e.kind() == std::io::ErrorKind::NotFound {
                    return Err(Error::SubSettingsEntryNotFound {
                        settings_type: self.config.name.clone(),
                        name: name.to_string(),
                    });
                }
                return Err(Error::FileRead {
                    path: path.display().to_string(),
                    source: e,
                });
            }

            let mut value: Value = self.storage.read(&path)?;

            // Apply migration if configured
            if let Some(migrator) = &self.config.migrator {
                let original = value.clone();
                value = migrator(value);

                // If migration changed the value, persist it
                if value != original {
                    debug!("Migrated sub-settings entry: {}", name);
                    self.storage.write(&path, &value)?;
                }
            }

            Ok(value)
        }
    }

    /// Load a typed entry
    pub fn get<T: DeserializeOwned>(&self, name: &str) -> Result<T> {
        let value = self.get_value(name)?;
        serde_json::from_value(value).map_err(|e| Error::Parse(e.to_string()))
    }

    /// Save an entry
    pub fn set<T: Serialize + Sync>(&self, name: &str, value: &T) -> Result<()> {
        // Acquire save mutex to prevent race conditions (especially for single-file mode)
        let _save_guard = self.save_mutex.lock().unwrap();

        let json_value = serde_json::to_value(value).map_err(|e| Error::Parse(e.to_string()))?;

        let exists: bool;

        if self.is_single_file() {
            // Single-file mode: update key in the single file
            let path = self.single_file_path();

            // Read existing data or create empty object
            let mut file_data = match std::fs::metadata(&path) {
                Ok(_) => self.storage.read::<Value>(&path)?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    Value::Object(serde_json::Map::new())
                }
                Err(e) => {
                    return Err(Error::FileRead {
                        path: path.display().to_string(),
                        source: e,
                    })
                }
            };

            let obj = file_data.as_object_mut().ok_or_else(|| {
                Error::InvalidBackup("Single-file sub-settings is not a JSON object".to_string())
            })?;

            exists = obj.contains_key(name);
            obj.insert(name.to_string(), json_value);

            // Ensure base directory exists
            if !self.base_dir.exists() {
                std::fs::create_dir_all(&self.base_dir).map_err(|e| Error::DirectoryCreate {
                    path: self.base_dir.display().to_string(),
                    source: e,
                })?;
            }

            self.storage.write(&path, &file_data)?;
        } else {
            // Multi-file mode: write to individual file
            let path = self.entry_path(name);
            exists = match std::fs::metadata(&path) {
                Ok(_) => true,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
                Err(e) => {
                    return Err(Error::FileRead {
                        path: path.display().to_string(),
                        source: e,
                    })
                }
            };

            // Ensure directory exists
            std::fs::create_dir_all(&self.base_dir).map_err(|e| Error::DirectoryCreate {
                path: self.base_dir.display().to_string(),
                source: e,
            })?;

            self.storage.write(&path, &json_value)?;
        }

        let action = if exists {
            SubSettingsAction::Updated
        } else {
            SubSettingsAction::Created
        };

        info!(
            "✅ Sub-settings '{}' {} in {}",
            name,
            match action {
                SubSettingsAction::Created => "created",
                SubSettingsAction::Updated => "updated",
                SubSettingsAction::Deleted => "deleted",
            },
            self.config.name
        );

        self.notify_change(name, action);
        Ok(())
    }

    /// Delete an entry
    pub fn delete(&self, name: &str) -> Result<()> {
        // Acquire save mutex to prevent race conditions (especially for single-file mode)
        let _save_guard = self.save_mutex.lock().unwrap();

        if self.is_single_file() {
            // Single-file mode: remove key from the single file
            let path = self.single_file_path();

            if let Err(e) = std::fs::metadata(&path) {
                if e.kind() == std::io::ErrorKind::NotFound {
                    warn!(
                        "⚠️ Sub-settings file '{}' not found, nothing to delete",
                        self.config.name
                    );
                    return Ok(());
                }
                return Err(Error::FileRead {
                    path: path.display().to_string(),
                    source: e,
                });
            }

            let mut file_data: Value = self.storage.read(&path)?;
            let obj = file_data.as_object_mut().ok_or_else(|| {
                Error::InvalidBackup("Single-file sub-settings is not a JSON object".to_string())
            })?;

            if obj.remove(name).is_none() {
                warn!(
                    "⚠️ Sub-settings entry '{}' not found in {}, nothing to delete",
                    name, self.config.name
                );
                return Ok(());
            }

            self.storage.write(&path, &file_data)?;
        } else {
            // Multi-file mode: delete individual file
            let path = self.entry_path(name);

            if let Err(e) = std::fs::metadata(&path) {
                if e.kind() == std::io::ErrorKind::NotFound {
                    warn!(
                        "⚠️ Sub-settings entry '{}' not found in {}, nothing to delete",
                        name, self.config.name
                    );
                    return Ok(());
                }
                return Err(Error::FileRead {
                    path: path.display().to_string(),
                    source: e,
                });
            }

            std::fs::remove_file(&path).map_err(|e| Error::FileDelete {
                path: path.display().to_string(),
                source: e,
            })?;
        }

        info!(
            "✅ Sub-settings '{}' deleted from {}",
            name, self.config.name
        );
        self.notify_change(name, SubSettingsAction::Deleted);
        Ok(())
    }

    /// List all entries
    pub fn list(&self) -> Result<Vec<String>> {
        if self.is_single_file() {
            // Single-file mode: return keys from the single file
            let path = self.single_file_path();

            // Check file presence strictly
            if let Err(e) = std::fs::metadata(&path) {
                if e.kind() == std::io::ErrorKind::NotFound {
                    return Ok(Vec::new());
                }
                return Err(Error::FileRead {
                    path: path.display().to_string(),
                    source: e,
                });
            }

            let file_data: Value = self.storage.read(&path)?;
            let obj = file_data.as_object().ok_or_else(|| {
                Error::InvalidBackup("Single-file sub-settings is not a JSON object".to_string())
            })?;

            let mut entries: Vec<String> = obj.keys().cloned().collect();
            entries.sort();
            Ok(entries)
        } else {
            // Multi-file mode: list files in directory
            if let Err(e) = std::fs::metadata(&self.base_dir) {
                if e.kind() == std::io::ErrorKind::NotFound {
                    return Ok(Vec::new());
                }
                return Err(Error::FileRead {
                    path: self.base_dir.display().to_string(),
                    source: e,
                });
            }

            let mut entries = Vec::new();
            let ext = format!(".{}", self.config.extension);

            let read_dir = std::fs::read_dir(&self.base_dir).map_err(|e| Error::FileRead {
                path: self.base_dir.display().to_string(),
                source: e,
            })?;

            for entry in read_dir {
                let entry = entry.map_err(|e| Error::FileRead {
                    path: self.base_dir.display().to_string(),
                    source: e,
                })?;
                let file_name = entry.file_name();
                let name = file_name.to_string_lossy();

                if name.ends_with(&ext) {
                    let entry_name = name.trim_end_matches(&ext).to_string();
                    entries.push(entry_name);
                }
            }

            entries.sort();
            Ok(entries)
        }
    }

    /// Check if an entry exists
    ///
    /// Returns `Ok(true)` if exists, `Ok(false)` if not found.
    /// Returns `Err` for I/O errors (e.g., permission denied).
    pub fn exists(&self, name: &str) -> Result<bool> {
        if self.is_single_file() {
            // Single-file mode: check if key exists in the file
            let path = self.single_file_path();

            // Check file presence strictly
            match std::fs::metadata(&path) {
                Ok(_) => {
                    // File exists, check content
                    let file_data: Value = self.storage.read(&path)?;
                    Ok(file_data
                        .as_object()
                        .map(|obj| obj.contains_key(name))
                        .unwrap_or(false))
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(e) => Err(Error::FileRead {
                    path: path.display().to_string(),
                    source: e,
                }),
            }
        } else {
            // Multi-file mode: check if file exists
            let path = self.entry_path(name);
            match std::fs::metadata(&path) {
                Ok(_) => Ok(true),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(e) => Err(Error::FileRead {
                    path: path.display().to_string(),
                    source: e,
                }),
            }
        }
    }

    /// Get the directory path for this sub-settings type
    /// In single-file mode, this is the directory containing the single file
    pub fn directory(&self) -> &PathBuf {
        &self.base_dir
    }

    /// Get the single file path (only applicable in single-file mode)
    /// Returns the path to the JSON file containing all entities
    pub fn file_path(&self) -> Option<PathBuf> {
        if self.is_single_file() {
            Some(self.single_file_path())
        } else {
            None
        }
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::JsonStorage;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn test_sub_settings_crud() {
        let dir = tempdir().unwrap();
        let config = SubSettingsConfig::new("remotes");
        let storage = JsonStorage::new();
        let sub = SubSettings::new(dir.path(), config, storage);

        // Initially empty
        let list = sub.list().unwrap();
        assert!(list.is_empty());

        // Save an entry
        let data = json!({"type": "drive", "path": "/mount/gdrive"});
        sub.set("gdrive", &data).unwrap();

        // Verify it exists
        assert!(sub.exists("gdrive").unwrap());

        // Load it back
        let loaded = sub.get_value("gdrive").unwrap();
        assert_eq!(loaded, data);

        // List should show it
        let list = sub.list().unwrap();
        assert_eq!(list, vec!["gdrive"]);

        // Delete it
        sub.delete("gdrive").unwrap();
        assert!(!sub.exists("gdrive").unwrap());
    }

    #[test]
    fn test_sub_settings_migration() {
        let dir = tempdir().unwrap();

        // Create config with migrator that adds a field
        let config = SubSettingsConfig::new("items").with_migrator(|mut v| {
            if let Some(obj) = v.as_object_mut() {
                if !obj.contains_key("version") {
                    obj.insert("version".into(), json!(2));
                }
            }
            v
        });

        let storage = JsonStorage::new();
        let sub = SubSettings::new(dir.path(), config, storage);

        // Save old format (without version)
        let old_data = json!({"name": "test"});
        sub.set("item1", &old_data).unwrap();

        // Load should apply migration
        let loaded = sub.get_value("item1").unwrap();
        assert_eq!(loaded["version"], json!(2));
        assert_eq!(loaded["name"], json!("test"));
    }

    #[test]
    fn test_sub_settings_not_found() {
        let dir = tempdir().unwrap();
        let config = SubSettingsConfig::new("items");
        let storage = JsonStorage::new();
        let sub = SubSettings::new(dir.path(), config, storage);

        let result = sub.get_value("nonexistent");
        assert!(matches!(
            result,
            Err(Error::SubSettingsEntryNotFound { .. })
        ));
    }

    #[test]
    fn test_sub_settings_single_file_mode() {
        let dir = tempdir().unwrap();

        // Create single-file config
        let config = SubSettingsConfig::new("backends").single_file();
        let storage = JsonStorage::new();
        let sub = SubSettings::new(dir.path(), config, storage);

        // Test create
        sub.set("gdrive", &json!({"type": "drive", "client_id": "123"}))
            .unwrap();
        sub.set("s3", &json!({"type": "s3", "region": "us-east-1"}))
            .unwrap();

        // Verify single file was created (not a directory)
        let file_path = dir.path().join("backends.json");
        assert!(file_path.exists());
        assert!(file_path.is_file());

        // Test list
        let list = sub.list().unwrap();
        assert_eq!(list, vec!["gdrive", "s3"]);

        // Test get
        let gdrive = sub.get::<serde_json::Value>("gdrive").unwrap();
        assert_eq!(gdrive["type"], json!("drive"));
        assert_eq!(gdrive["client_id"], json!("123"));

        // Test update
        sub.set("gdrive", &json!({"type": "drive", "client_id": "456"}))
            .unwrap();
        let gdrive = sub.get::<serde_json::Value>("gdrive").unwrap();
        assert_eq!(gdrive["client_id"], json!("456"));

        // Test exists
        assert!(sub.exists("gdrive").unwrap());
        assert!(sub.exists("s3").unwrap());
        assert!(!sub.exists("dropbox").unwrap());

        // Test delete
        sub.delete("s3").unwrap();
        let list = sub.list().unwrap();
        assert_eq!(list, vec!["gdrive"]);
        assert!(!sub.exists("s3").unwrap());

        // Test file_path()
        assert!(sub.file_path().is_some());
        assert_eq!(sub.file_path().unwrap(), file_path);
    }
}
