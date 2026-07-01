//! SQLite storage backend
//!
//! Stores settings as a JSON-encoded value in a single-row table of a SQLite
//! database file. The `path` passed to [`StorageBackend::read`] /
//! [`StorageBackend::write`] is treated as the database file location, so the
//! existing `SettingsConfig` plumbing (which computes a settings file path from
//! `config_dir` + `settings_file`) works unchanged.
//!
//! # Design
//!
//! The [`StorageBackend`] trait is path-based and assumes a single opaque
//! blob per call. SQLite fits that abstraction cleanly by treating each path
//! as a database file and storing the serialized payload in a single row
//! keyed by a configurable name. This keeps the public API identical to the
//! file-based backends — callers still use
//! `SettingsManager::builder(...).with_storage::<SqliteStorage>()` — while
//! gaining SQLite's atomic commit, durability, and crash-safety guarantees.
//!
//! Values are JSON-encoded via [`serde_json`] so any type that works with the
//! JSON backend also works here. The table schema is:
//!
//! ```sql
//! CREATE TABLE rcman_settings (
//!     key  TEXT PRIMARY KEY NOT NULL,
//!     data TEXT NOT NULL
//! );
//! ```
//!
//! Both the table name and the row key can be customized via
//! [`SqliteStorage::with_table`] and [`SqliteStorage::with_key`] for callers
//! that want to share a single database file across multiple settings
//! namespaces.

use crate::error::{Error, Result};
use crate::storage::StorageBackend;
use crate::utils::security::{ensure_secure_dir, set_secure_file_permissions};
use rusqlite::Connection;
use serde::{Serialize, de::DeserializeOwned};
use std::path::Path;

/// Default table name used by [`SqliteStorage`].
pub const DEFAULT_TABLE: &str = "rcman_settings";

/// Default row key used by [`SqliteStorage`] for the main settings payload.
pub const DEFAULT_KEY: &str = "main";

/// SQLite storage backend.
///
/// See the [module docs](crate::storage::sqlite) for the design rationale and
/// schema.
///
/// # Example
///
/// ```rust,no_run
/// use rcman::{SettingsManager, SqliteStorage};
/// # use rcman::{SettingsSchema, SettingMetadata};
/// # use serde::{Serialize, Deserialize};
/// # use std::collections::HashMap;
/// # #[derive(Default, Serialize, Deserialize)] struct MySettings;
/// # impl SettingsSchema for MySettings {
/// #     fn get_metadata() -> HashMap<String, SettingMetadata> { HashMap::new() }
/// # }
///
/// let manager = SettingsManager::builder("my-app", "1.0.0")
///     .with_storage::<SqliteStorage>()
///     .build()
///     .unwrap();
/// ```
#[derive(Clone)]
pub struct SqliteStorage {
    table_name: String,
    key: String,
}

impl Default for SqliteStorage {
    fn default() -> Self {
        Self {
            table_name: DEFAULT_TABLE.to_string(),
            key: DEFAULT_KEY.to_string(),
        }
    }
}

impl SqliteStorage {
    /// Create a new SQLite storage backend with the default table name
    /// (`rcman_settings`) and row key (`main`).
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Use a custom table name.
    ///
    /// The name must be a valid SQLite identifier (matches
    /// `^[A-Za-z_][A-Za-z0-9_]*$`); otherwise this returns the input unchanged
    /// and logs a warning. Invalid names are rejected at first use with an
    /// [`Error::Config`].
    #[must_use]
    pub fn with_table(mut self, table: impl Into<String>) -> Self {
        let table = table.into();
        if is_valid_identifier(&table) {
            self.table_name = table;
        } else {
            log::warn!("rejected invalid SQLite table name {table:?}; keeping default");
        }
        self
    }

    /// Use a custom row key. Useful when sharing a single database file across
    /// multiple settings namespaces.
    #[must_use]
    pub fn with_key(mut self, key: impl Into<String>) -> Self {
        self.key = key.into();
        self
    }

    /// Open a connection to the database at `path`, creating parent
    /// directories with secure permissions first if needed.
    fn connect(&self, path: &Path) -> Result<Connection> {
        if !is_valid_identifier(&self.table_name) {
            return Err(Error::Config(format!(
                "invalid SQLite table name: {:?}",
                self.table_name
            )));
        }
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
            && !parent.exists()
        {
            ensure_secure_dir(parent)?;
        }
        Connection::open(path)
            .map_err(|e| Error::Config(format!("sqlite open {}: {e}", path.display())))
    }

    /// Idempotently create the settings table if it does not yet exist.
    fn ensure_schema(&self, conn: &Connection) -> Result<()> {
        // `table_name` is validated by `connect` before we get here, so we can
        // safely interpolate it. SQLite does not support parameterized
        // identifiers.
        let sql = format!(
            "CREATE TABLE IF NOT EXISTS {table} (
                key  TEXT PRIMARY KEY NOT NULL,
                data TEXT NOT NULL
            )",
            table = self.table_name
        );
        conn.execute(&sql, [])
            .map_err(|e| Error::Config(format!("sqlite create table: {e}")))?;
        Ok(())
    }
}

impl StorageBackend for SqliteStorage {
    fn extension(&self) -> &'static str {
        // Matches the convention used by the file-based backends: callers that
        // don't override the settings filename get `settings.db`.
        "db"
    }

    fn serialize<T: Serialize>(&self, data: &T) -> Result<String> {
        // Reuse JSON for the value encoding so any serde-compatible struct
        // works identically to the JSON backend.
        serde_json::to_string(data).map_err(Error::from)
    }

    fn deserialize<T: DeserializeOwned>(&self, content: &str) -> Result<T> {
        serde_json::from_str(content).map_err(Error::from)
    }

    fn read<T: DeserializeOwned>(&self, path: &Path) -> Result<T> {
        let conn = self.connect(path)?;
        self.ensure_schema(&conn)?;
        let sql = format!(
            "SELECT data FROM {table} WHERE key = ?1",
            table = self.table_name
        );
        let row_data: Option<String> = conn
            .query_row(&sql, rusqlite::params![self.key], |row| row.get(0))
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                _ => Err(e),
            })
            .map_err(|e| Error::Config(format!("sqlite query: {e}")))?;
        match row_data {
            Some(content) => self.deserialize(&content),
            None => Err(Error::FileRead {
                path: path.to_path_buf(),
                source: std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("no settings row for key {:?}", self.key),
                ),
            }),
        }
    }

    fn write<T: Serialize>(&self, path: &Path, data: &T) -> Result<()> {
        let content = self.serialize(data)?;
        let conn = self.connect(path)?;
        self.ensure_schema(&conn)?;
        let sql = format!(
            "INSERT INTO {table} (key, data) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET data = excluded.data",
            table = self.table_name
        );
        conn.execute(&sql, rusqlite::params![self.key, content])
            .map_err(|e| Error::Config(format!("sqlite upsert: {e}")))?;
        // Best-effort: tighten permissions on the database file to match the
        // file-based backends. Errors here are not fatal.
        let _ = set_secure_file_permissions(path);
        Ok(())
    }
}

/// Validate that `name` is a safe SQLite identifier.
///
/// We only allow ASCII letters, digits, and underscores, with a non-digit
/// first character. This matches SQLite's unquoted identifier rules and
/// prevents SQL injection via the table name (which must be interpolated
/// because SQLite does not accept parameterized identifiers).
fn is_valid_identifier(name: &str) -> bool {
    let mut bytes = name.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return false;
    }
    bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use tempfile::tempdir;

    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct TestData {
        name: String,
        value: i32,
        nested: Nested,
    }

    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Nested {
        flag: bool,
        items: Vec<String>,
    }

    fn sample() -> TestData {
        TestData {
            name: "alice".into(),
            value: 42,
            nested: Nested {
                flag: true,
                items: vec!["a".into(), "b".into()],
            },
        }
    }

    #[test]
    fn extension_is_db() {
        assert_eq!(SqliteStorage::new().extension(), "db");
    }

    #[test]
    fn roundtrip_default_settings() {
        let storage = SqliteStorage::new();
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.db");

        let data = sample();
        storage.write(&path, &data).unwrap();
        let loaded: TestData = storage.read(&path).unwrap();
        assert_eq!(data, loaded);
    }

    #[test]
    fn roundtrip_creates_parent_dirs() {
        let storage = SqliteStorage::new();
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("dir").join("settings.db");

        let data = sample();
        storage.write(&path, &data).unwrap();
        let loaded: TestData = storage.read(&path).unwrap();
        assert_eq!(data, loaded);
    }

    #[test]
    fn read_missing_path_errors() {
        let storage = SqliteStorage::new();
        let dir = tempdir().unwrap();
        let path = dir.path().join("missing.db");
        let result: Result<TestData> = storage.read(&path);
        assert!(result.is_err());
        match result.unwrap_err() {
            Error::FileRead { .. } => {}
            other => panic!("expected FileRead, got {other:?}"),
        }
    }

    #[test]
    fn write_overwrites_existing_row() {
        let storage = SqliteStorage::new();
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.db");

        let first = sample();
        storage.write(&path, &first).unwrap();

        let second = TestData {
            name: "bob".into(),
            value: 7,
            nested: Nested {
                flag: false,
                items: vec![],
            },
        };
        storage.write(&path, &second).unwrap();

        let loaded: TestData = storage.read(&path).unwrap();
        assert_eq!(loaded, second);
    }

    #[test]
    fn custom_table_and_key_share_database() {
        // Two storages with different keys can share the same db file.
        let dir = tempdir().unwrap();
        let path = dir.path().join("multi.db");

        let alpha = SqliteStorage::new().with_key("alpha");
        let beta = SqliteStorage::new().with_key("beta");

        alpha.write(&path, &sample()).unwrap();
        beta.write(
            &path,
            &TestData {
                name: "beta".into(),
                value: 99,
                nested: Nested {
                    flag: false,
                    items: vec!["z".into()],
                },
            },
        )
        .unwrap();

        let a: TestData = alpha.read(&path).unwrap();
        let b: TestData = beta.read(&path).unwrap();
        assert_eq!(a.name, "alice");
        assert_eq!(b.name, "beta");
    }

    #[test]
    fn invalid_table_name_is_rejected_at_use() {
        // The builder silently rejects the invalid name and keeps the default,
        // so this should still work.
        let storage = SqliteStorage::new().with_table("valid name with spaces");
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.db");
        // Should still succeed because the invalid name was rejected and the
        // default `rcman_settings` table is used instead.
        storage.write(&path, &sample()).unwrap();
        let loaded: TestData = storage.read(&path).unwrap();
        assert_eq!(loaded, sample());
    }

    #[test]
    fn identifier_validation() {
        assert!(is_valid_identifier("rcman_settings"));
        assert!(is_valid_identifier("_private"));
        assert!(is_valid_identifier("abc_123"));
        assert!(!is_valid_identifier(""));
        assert!(!is_valid_identifier("1leads_with_digit"));
        assert!(!is_valid_identifier("has space"));
        assert!(!is_valid_identifier("has;sql;injection"));
        assert!(!is_valid_identifier("quoted\"name"));
    }
}
