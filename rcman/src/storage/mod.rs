//! Storage backend trait and implementations
//!
//! Backends live behind the [`StorageBackend`] trait. Each backend serializes
//! a `Serialize` value to a string and persists it under a path. For the
//! file-based backends (`JsonStorage`, `TomlStorage`, `YamlStorage`) the path
//! is the settings file. For the database backend (`SqliteStorage`) the path
//! is the database file and the value is stored as a row in a table.
//!
//! Adding a new backend only requires implementing `extension`, `serialize`,
//! and `deserialize`; `read` and `write` have sensible defaults that work for
//! any single-file format. Backends that need richer storage (e.g. a database)
//! override `read` and `write` instead.

#[cfg(feature = "sqlite")]
mod sqlite;

use crate::error::{Error, Result};
use crate::utils::security::{ensure_secure_dir, set_secure_file_permissions};
use serde::{Serialize, de::DeserializeOwned};
use std::path::Path;

/// Trait for storage backend implementations
///
/// This allows swapping JSON for TOML, YAML, or other formats in the future.
pub trait StorageBackend: Clone + Send + Sync {
    /// File extension for this storage format (e.g., "json", "toml")
    ///
    /// # Returns
    ///
    /// * `&str` - File extension for this storage format
    fn extension(&self) -> &str;

    /// Serialize data to string
    ///
    /// # Arguments
    ///
    /// * `data` - Data to serialize
    ///
    /// # Returns
    ///
    /// * `Result<String>` - Serialized data
    ///
    /// # Errors
    ///
    /// * `Error::Io` - If the data cannot be serialized
    fn serialize<T: Serialize>(&self, data: &T) -> Result<String>;

    /// Deserialize data from string
    ///
    /// # Arguments
    ///
    /// * `content` - Data to deserialize
    ///
    /// # Returns
    ///
    /// * `Result<T>` - Deserialized data
    ///
    /// # Errors
    ///
    /// * `Error::Io` - If the data cannot be deserialized
    fn deserialize<T: DeserializeOwned>(&self, content: &str) -> Result<T>;

    /// Read and deserialize from file
    ///
    /// # Arguments
    ///
    /// * `path` - Path to file to read
    ///
    /// # Returns
    ///
    /// * `Result<T>` - Deserialized data
    ///
    /// # Errors
    ///
    /// * `Error::FileRead` - If the file cannot be read
    fn read<T: DeserializeOwned>(&self, path: &Path) -> Result<T> {
        let content = std::fs::read_to_string(path).map_err(|e| Error::FileRead {
            path: path.to_path_buf(),
            source: e,
        })?;
        self.deserialize(&content)
    }

    /// Serialize and write to file
    ///
    /// Uses atomic write: writes to temp file then renames to prevent corruption.
    ///
    /// # Arguments
    ///
    /// * `path` - Path to file to write
    /// * `data` - Data to serialize and write
    ///
    /// # Returns
    ///
    /// * `Result<()>` - Success or error
    ///
    /// # Errors
    ///
    /// * `Error::FileWrite` - If the file cannot be written
    fn write<T: Serialize>(&self, path: &Path, data: &T) -> Result<()> {
        use std::io::Write;

        let content = self.serialize(data)?;

        // Ensure parent directory exists
        if let Some(parent) = path.parent()
            && !parent.exists()
        {
            ensure_secure_dir(parent)?;
        }

        // Atomic write: temp file + rename
        // Use .tmp suffix append to preserve original filename fully
        let file_name = path.file_name().ok_or_else(|| {
            Error::Config(format!(
                "Invalid path '{}': must have a filename",
                path.display()
            ))
        })?;
        let mut temp_filename = file_name.to_os_string();

        // Use nanoseconds timestamp for uniqueness to prevent collision in concurrent writes
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();

        temp_filename.push(format!(".{now}.tmp"));
        let temp_path = path.with_file_name(temp_filename);

        // Wrap fallible steps so we can clean up the temp file on failure
        let result = (|| -> Result<()> {
            let mut temp_file =
                std::fs::File::create(&temp_path).map_err(|e| Error::FileWrite {
                    path: temp_path.clone(),
                    source: e,
                })?;

            temp_file
                .write_all(content.as_bytes())
                .map_err(|e| Error::FileWrite {
                    path: temp_path.clone(),
                    source: e,
                })?;

            // Sync physically to disk to prevent data loss on hard crashes before rename
            temp_file.sync_all().map_err(|e| Error::FileWrite {
                path: temp_path.clone(),
                source: e,
            })?;

            // Set secure permissions on temp file before rename
            set_secure_file_permissions(&temp_path)?;

            // IMPORTANT: Drop the file handle before rename.
            // On Windows, a file cannot be renamed if it is open.
            drop(temp_file);

            // Atomic rename
            #[cfg(not(windows))]
            {
                std::fs::rename(&temp_path, path).map_err(|e| Error::FileWrite {
                    path: path.to_path_buf(),
                    source: e,
                })?;
            }

            #[cfg(windows)]
            {
                // On Windows, rename can fail with PermissionDenied if the file is being
                // indexed or scanned by anti-virus. Retry a few times with backoff.
                let mut retries = 0;
                let max_retries = 5;
                loop {
                    match std::fs::rename(&temp_path, path) {
                        Ok(_) => break,
                        Err(e)
                            if e.kind() == std::io::ErrorKind::PermissionDenied
                                && retries < max_retries =>
                        {
                            retries += 1;
                            std::thread::sleep(std::time::Duration::from_millis(10 * retries));
                            continue;
                        }
                        Err(e) => {
                            return Err(Error::FileWrite {
                                path: path.to_path_buf(),
                                source: e,
                            });
                        }
                    }
                }
            }

            // Ensure final file has secure permissions (in case rename didn't preserve)
            set_secure_file_permissions(path)?;

            Ok(())
        })();

        // Clean up orphaned temp file on failure
        if result.is_err() {
            let _ = std::fs::remove_file(&temp_path);
        }

        result
    }
}

// =============================================================================
// JSON Storage Implementation
// =============================================================================

/// JSON storage backend (default)
///
/// # Example
///
/// ```
/// use rcman::{JsonStorage, StorageBackend};
/// use serde::{Deserialize, Serialize};
///
/// #[derive(Serialize, Deserialize)]
/// struct Config { name: String }
///
/// let storage = JsonStorage::new();
/// let data = Config { name: "test".into() };
/// let json = storage.serialize(&data).unwrap();
/// assert!(json.contains("test"));
/// ```
#[derive(Clone)]
pub struct JsonStorage {
    /// Pretty print JSON output
    pretty: bool,
}

impl Default for JsonStorage {
    /// Default to pretty-printed JSON (matches `JsonStorage::new()`)
    fn default() -> Self {
        Self::new()
    }
}

impl JsonStorage {
    /// Create a new JSON storage backend with pretty printing enabled
    #[must_use]
    pub fn new() -> Self {
        Self { pretty: true }
    }

    /// Create a compact JSON storage (no pretty printing)
    #[must_use]
    pub fn compact() -> Self {
        Self { pretty: false }
    }

    /// Set whether to pretty print JSON output
    pub fn set_pretty(&mut self, pretty: bool) {
        self.pretty = pretty;
    }
}

impl StorageBackend for JsonStorage {
    fn extension(&self) -> &'static str {
        "json"
    }

    fn serialize<T: Serialize>(&self, data: &T) -> Result<String> {
        if self.pretty {
            serde_json::to_string_pretty(data).map_err(Error::from)
        } else {
            serde_json::to_string(data).map_err(Error::from)
        }
    }

    fn deserialize<T: DeserializeOwned>(&self, content: &str) -> Result<T> {
        serde_json::from_str(content).map_err(Error::from)
    }
}

// =============================================================================
// TOML Storage Implementation
// =============================================================================

/// TOML storage backend
///
/// Requires the `toml` feature.
#[cfg(feature = "toml")]
#[derive(Clone, Default)]
pub struct TomlStorage;

#[cfg(feature = "toml")]
impl TomlStorage {
    /// Create a new TOML storage backend
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

#[cfg(feature = "toml")]
impl StorageBackend for TomlStorage {
    fn extension(&self) -> &'static str {
        "toml"
    }

    fn serialize<T: Serialize>(&self, data: &T) -> Result<String> {
        toml::to_string(data).map_err(|e| Error::Parse(e.to_string()))
    }

    fn deserialize<T: DeserializeOwned>(&self, content: &str) -> Result<T> {
        toml::from_str(content).map_err(|e| Error::Parse(e.to_string()))
    }
}

// =============================================================================
// YAML Storage Implementation
// =============================================================================

/// YAML storage backend
///
/// Requires the `yaml` feature.
#[cfg(feature = "yaml")]
#[derive(Clone, Default)]
pub struct YamlStorage;

#[cfg(feature = "yaml")]
impl YamlStorage {
    /// Create a new YAML storage backend
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

#[cfg(feature = "yaml")]
impl StorageBackend for YamlStorage {
    fn extension(&self) -> &'static str {
        "yaml"
    }

    fn serialize<T: Serialize>(&self, data: &T) -> Result<String> {
        serde_yaml::to_string(data).map_err(|e| Error::Parse(e.to_string()))
    }

    fn deserialize<T: DeserializeOwned>(&self, content: &str) -> Result<T> {
        serde_yaml::from_str(content).map_err(|e| Error::Parse(e.to_string()))
    }
}

// =============================================================================
// SQLite Storage Implementation
// =============================================================================

/// SQLite storage backend
///
/// Requires the `sqlite` feature.
#[cfg(feature = "sqlite")]
pub use sqlite::SqliteStorage;

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use tempfile::tempdir;

    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct TestData {
        name: String,
        value: i32,
    }

    #[test]
    fn test_json_serialize_pretty() {
        let storage = JsonStorage::new();
        let data = TestData {
            name: "test".into(),
            value: 42,
        };

        let json = storage.serialize(&data).unwrap();
        assert!(json.contains('\n')); // Pretty printed
        assert!(json.contains("\"name\": \"test\""));
    }

    #[test]
    fn test_json_serialize_compact() {
        let storage = JsonStorage::compact();
        let data = TestData {
            name: "test".into(),
            value: 42,
        };

        let json = storage.serialize(&data).unwrap();
        assert!(!json.contains('\n')); // Compact
    }

    #[test]
    fn test_json_roundtrip_sync() {
        let storage = JsonStorage::new();
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.json");

        let data = TestData {
            name: "hello".into(),
            value: 123,
        };

        storage.write(&path, &data).unwrap();
        let loaded: TestData = storage.read(&path).unwrap();

        assert_eq!(data, loaded);
    }

    #[test]
    fn test_json_roundtrip_async() {
        let storage = JsonStorage::new();
        let dir = tempdir().unwrap();
        let path = dir.path().join("subdir/test.json");

        let data = TestData {
            name: "async test".into(),
            value: 999,
        };

        storage.write(&path, &data).unwrap();
        let loaded: TestData = storage.read(&path).unwrap();

        assert_eq!(data, loaded);
    }

    #[test]
    fn test_read_nonexistent_file() {
        let storage = JsonStorage::new();
        let result: Result<TestData> = storage.read(Path::new("/nonexistent/file.json"));

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), Error::FileRead { .. }));
    }

    #[test]
    #[cfg(feature = "toml")]
    fn test_toml_roundtrip() {
        let storage = TomlStorage::new();
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.toml");

        let data = TestData {
            name: "toml_test".into(),
            value: 99,
        };

        storage.write(&path, &data).unwrap();
        let loaded: TestData = storage.read(&path).unwrap();

        assert_eq!(data, loaded);

        // Verify content is actually TOML
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("name = \"toml_test\""));
        assert!(content.contains("value = 99"));
    }

    #[test]
    #[cfg(feature = "yaml")]
    fn test_yaml_roundtrip() {
        let storage = super::YamlStorage::new();
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.yaml");

        let data = TestData {
            name: "yaml_test".into(),
            value: 99,
        };

        storage.write(&path, &data).unwrap();
        let loaded: TestData = storage.read(&path).unwrap();

        assert_eq!(data, loaded);

        // Verify content is actually YAML
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("name: yaml_test"));
        assert!(content.contains("value: 99"));
    }
}
