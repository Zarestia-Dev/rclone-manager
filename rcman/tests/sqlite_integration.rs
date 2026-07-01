//! SQLite storage integration tests
//!
//! Exercises the [`SqliteStorage`] backend through the full `SettingsManager`
//! stack: basic CRUD, sub-settings (multi-file and single-file modes), and
//! profile-aware reads/writes. The goal is to verify that the database backend
//! behaves identically to the file-based backends from the caller's
//! perspective.

#![cfg(feature = "sqlite")]

mod common;

use common::TestSettings;
use rcman::{SettingsConfig, SettingsManager, SqliteStorage, StorageBackend, SubSettingsConfig};
use serde_json::json;
use tempfile::TempDir;

// =============================================================================
// Basic CRUD via SettingsManager
// =============================================================================

#[test]
fn sqlite_settings_roundtrip() {
    let temp = TempDir::new().unwrap();
    let config = SettingsConfig::builder("sqlite-app", "1.0.0")
        .with_config_dir(temp.path())
        .with_schema::<TestSettings>()
        .with_storage::<SqliteStorage>()
        .build();

    let manager = SettingsManager::new(config).unwrap();

    // Defaults load successfully
    let _ = manager.get_all().unwrap();

    // Save a non-default setting
    manager
        .save_setting("ui", "theme", &json!("light"))
        .unwrap();
    manager
        .save_setting("ui", "font_size", &json!(18.0))
        .unwrap();

    // The on-disk file is a SQLite database
    let db_path = temp.path().join("settings.db");
    assert!(db_path.exists(), "expected database file at {db_path:?}");

    // SQLite magic header should be present
    let header = std::fs::read(&db_path).unwrap();
    assert!(
        header.starts_with(b"SQLite format 3\0"),
        "file is not a SQLite database"
    );

    // Reload into a fresh manager and verify
    let config2 = SettingsConfig::builder("sqlite-app", "1.0.0")
        .with_config_dir(temp.path())
        .with_schema::<TestSettings>()
        .with_storage::<SqliteStorage>()
        .build();
    let manager2 = SettingsManager::new(config2).unwrap();
    let settings = manager2.get_all().unwrap();
    assert_eq!(settings.ui.theme, "light");
    assert!((settings.ui.font_size - 18.0).abs() < f64::EPSILON);
}

#[test]
fn sqlite_reset_setting_removes_row_value() {
    let temp = TempDir::new().unwrap();
    let config = SettingsConfig::builder("sqlite-app", "1.0.0")
        .with_config_dir(temp.path())
        .with_schema::<TestSettings>()
        .with_storage::<SqliteStorage>()
        .build();
    let manager = SettingsManager::new(config).unwrap();

    manager
        .save_setting("ui", "theme", &json!("light"))
        .unwrap();
    manager.reset_setting("ui", "theme").unwrap();

    // After reset, the effective value should be the default.
    let settings = manager.get_all().unwrap();
    assert_eq!(settings.ui.theme, "dark");
}

// =============================================================================
// Sub-Settings (Multi-File Mode)
// =============================================================================

#[test]
fn sqlite_sub_settings_multi_file() {
    let temp = TempDir::new().unwrap();
    let config = SettingsConfig::builder("sqlite-app", "1.0.0")
        .with_config_dir(temp.path())
        .with_schema::<TestSettings>()
        .with_storage::<SqliteStorage>()
        .build();
    let manager = SettingsManager::new(config).unwrap();
    manager
        .register_sub_settings(SubSettingsConfig::new("remotes"))
        .unwrap();

    let remotes = manager.sub_settings("remotes").unwrap();
    remotes.set("gdrive", &json!({"type": "drive"})).unwrap();
    remotes.set("s3", &json!({"type": "s3"})).unwrap();

    // Each entry becomes its own SQLite file under remotes/
    let gdrive_path = temp.path().join("remotes").join("gdrive.db");
    let s3_path = temp.path().join("remotes").join("s3.db");
    assert!(gdrive_path.exists(), "missing {gdrive_path:?}");
    assert!(s3_path.exists(), "missing {s3_path:?}");

    // Reload and verify
    let config2 = SettingsConfig::builder("sqlite-app", "1.0.0")
        .with_config_dir(temp.path())
        .with_schema::<TestSettings>()
        .with_storage::<SqliteStorage>()
        .build();
    let manager2 = SettingsManager::new(config2).unwrap();
    manager2
        .register_sub_settings(SubSettingsConfig::new("remotes"))
        .unwrap();

    let remotes2 = manager2.sub_settings("remotes").unwrap();
    assert_eq!(remotes2.get_value("gdrive").unwrap()["type"], "drive");
    assert_eq!(remotes2.get_value("s3").unwrap()["type"], "s3");
    assert_eq!(remotes2.list().unwrap().len(), 2);
}

// =============================================================================
// Sub-Settings (Single-File Mode)
// =============================================================================

#[test]
fn sqlite_sub_settings_single_file() {
    let temp = TempDir::new().unwrap();
    let config = SettingsConfig::builder("sqlite-app", "1.0.0")
        .with_config_dir(temp.path())
        .with_schema::<TestSettings>()
        .with_storage::<SqliteStorage>()
        .build();
    let manager = SettingsManager::new(config).unwrap();
    manager
        .register_sub_settings(SubSettingsConfig::singlefile("backends"))
        .unwrap();

    let backends = manager.sub_settings("backends").unwrap();
    backends.set("fs", &json!({"path": "/tmp"})).unwrap();
    backends.set("s3", &json!({"bucket": "x"})).unwrap();

    // All entries live in a single `backends.db` file
    let db_path = temp.path().join("backends.db");
    assert!(db_path.exists(), "missing {db_path:?}");

    // Reload and verify
    let config2 = SettingsConfig::builder("sqlite-app", "1.0.0")
        .with_config_dir(temp.path())
        .with_schema::<TestSettings>()
        .with_storage::<SqliteStorage>()
        .build();
    let manager2 = SettingsManager::new(config2).unwrap();
    manager2
        .register_sub_settings(SubSettingsConfig::singlefile("backends"))
        .unwrap();

    let backends2 = manager2.sub_settings("backends").unwrap();
    assert_eq!(backends2.get_value("fs").unwrap()["path"], "/tmp");
    assert_eq!(backends2.get_value("s3").unwrap()["bucket"], "x");
    assert_eq!(backends2.list().unwrap().len(), 2);
}

// =============================================================================
// Direct StorageBackend usage (no SettingsManager)
// =============================================================================

#[test]
fn sqlite_backend_extension() {
    let storage = SqliteStorage::new();
    assert_eq!(storage.extension(), "db");
}

#[test]
fn sqlite_backend_custom_key_shares_database() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("shared.db");

    let alpha = SqliteStorage::new().with_key("alpha");
    let beta = SqliteStorage::new().with_key("beta");

    let payload_a = serde_json::json!({"who": "alpha", "n": 1});
    let payload_b = serde_json::json!({"who": "beta", "n": 2});

    alpha.write(&path, &payload_a).unwrap();
    beta.write(&path, &payload_b).unwrap();

    let a: serde_json::Value = alpha.read(&path).unwrap();
    let b: serde_json::Value = beta.read(&path).unwrap();
    assert_eq!(a["who"], "alpha");
    assert_eq!(b["who"], "beta");
}
