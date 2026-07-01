//! Profiles Feature Integration Tests
//!
//! Tests for profile management in sub-settings including:
//! - Profile CRUD operations
//! - Profile switching and cache invalidation
//! - Multi-file and single-file mode with profiles
//! - Profile events
//! - Profile-scoped backup & restore (requires `backup` feature)

#![cfg(feature = "profiles")]

mod common;

use rcman::{SettingsConfig, SettingsManager, SubSettingsConfig};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

#[cfg(feature = "backup")]
use rcman::{BackupOptions, RestoreOptions, SettingsConfigBuilder};
#[cfg(feature = "backup")]
use std::fs;
#[cfg(feature = "backup")]
use tempfile::tempdir;

#[cfg(all(feature = "encrypted-file", not(feature = "keychain")))]
use rcman::{SettingMetadata, SettingsSchema, settings};
#[cfg(all(feature = "encrypted-file", not(feature = "keychain")))]
use serde::{Deserialize, Serialize};
#[cfg(all(feature = "encrypted-file", not(feature = "keychain")))]
use std::collections::HashMap;

// =============================================================================
// Profile CRUD Operations
// =============================================================================

#[test]
fn test_create_profile() {
    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_sub_settings(SubSettingsConfig::new("remotes").with_profiles())
        .build()
        .unwrap();

    let remotes = manager.sub_settings("remotes").unwrap();
    let profiles = remotes.profiles().unwrap();

    // Create a new profile
    profiles.create("work").unwrap();

    // Verify it exists
    let list = profiles.list().unwrap();
    assert!(list.contains(&"default".to_string()));
    assert!(list.contains(&"work".to_string()));
}

#[test]
fn test_switch_profile() {
    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_sub_settings(SubSettingsConfig::new("remotes").with_profiles())
        .build()
        .unwrap();

    let remotes = manager.sub_settings("remotes").unwrap();
    let profiles = remotes.profiles().unwrap();

    profiles.create("work").unwrap();
    profiles.switch("work").unwrap();

    assert_eq!(profiles.active().unwrap(), "work");
}

#[test]
fn test_seamless_profile_switching() {
    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_sub_settings(SubSettingsConfig::new("remotes").with_profiles())
        .build()
        .unwrap();

    let remotes = manager.sub_settings("remotes").unwrap();

    // Add data to default profile
    remotes
        .set("personal-gdrive", &json!({"type": "drive"}))
        .unwrap();
    assert!(remotes.exists("personal-gdrive").unwrap());

    // Create work profile and switch to it using the convenience method
    remotes.profiles().unwrap().create("work").unwrap();
    remotes.switch_profile("work").unwrap();

    // In work profile, personal-gdrive should not exist (different directory)
    assert!(!remotes.exists("personal-gdrive").unwrap());

    // Add work-specific data
    remotes
        .set("company-drive", &json!({"type": "sharepoint"}))
        .unwrap();
    assert!(remotes.exists("company-drive").unwrap());

    // Switch back to default
    remotes.switch_profile("default").unwrap();

    // Back in default, personal-gdrive exists, company-drive does not
    assert!(remotes.exists("personal-gdrive").unwrap());
    assert!(!remotes.exists("company-drive").unwrap());
}

#[test]
fn test_delete_profile() {
    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_sub_settings(SubSettingsConfig::new("remotes").with_profiles())
        .build()
        .unwrap();

    let remotes = manager.sub_settings("remotes").unwrap();
    let profiles = remotes.profiles().unwrap();

    profiles.create("temp").unwrap();
    assert!(profiles.exists("temp").unwrap());

    profiles.delete("temp").unwrap();
    assert!(!profiles.exists("temp").unwrap());
}

#[test]
fn test_cannot_delete_active_profile() {
    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_sub_settings(SubSettingsConfig::new("remotes").with_profiles())
        .build()
        .unwrap();

    let remotes = manager.sub_settings("remotes").unwrap();
    let profiles = remotes.profiles().unwrap();

    // default is active, can't delete it
    let result = profiles.delete("default");
    assert!(result.is_err());
}

#[test]
fn test_rename_profile() {
    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_sub_settings(SubSettingsConfig::new("remotes").with_profiles())
        .build()
        .unwrap();

    let remotes = manager.sub_settings("remotes").unwrap();
    let profiles = remotes.profiles().unwrap();

    profiles.create("old-name").unwrap();
    profiles.rename("old-name", "new-name").unwrap();

    let list = profiles.list().unwrap();
    assert!(!list.contains(&"old-name".to_string()));
    assert!(list.contains(&"new-name".to_string()));
}

#[test]
fn test_duplicate_profile() {
    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_sub_settings(SubSettingsConfig::new("remotes").with_profiles())
        .build()
        .unwrap();

    let remotes = manager.sub_settings("remotes").unwrap();

    // Add some data to default profile
    remotes.set("gdrive", &json!({"type": "drive"})).unwrap();

    let profiles = remotes.profiles().unwrap();
    profiles.duplicate("default", "backup").unwrap();

    // Verify both profiles exist
    let list = profiles.list().unwrap();
    assert!(list.contains(&"default".to_string()));
    assert!(list.contains(&"backup".to_string()));

    // Verify the backup profile has the data
    let backup_dir = temp_dir
        .path()
        .join("remotes")
        .join("profiles")
        .join("backup");
    assert!(backup_dir.join("gdrive.json").exists());
}

// =============================================================================
// Profile Events
// =============================================================================

#[test]
fn test_profile_events() {
    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_sub_settings(SubSettingsConfig::new("remotes").with_profiles())
        .build()
        .unwrap();

    let remotes = manager.sub_settings("remotes").unwrap();
    let profiles = remotes.profiles().unwrap();

    let events = Arc::new(Mutex::new(Vec::new()));
    let events_clone = events.clone();

    profiles.set_on_event(move |event| {
        events_clone.lock().unwrap().push(format!("{event:?}"));
    });

    profiles.create("work").unwrap();
    profiles.switch("work").unwrap();
    profiles.rename("work", "job").unwrap();

    let recorded = events.lock().unwrap();
    assert_eq!(recorded.len(), 3);
}

// =============================================================================
// Profiles Not Enabled
// =============================================================================

#[test]
fn test_profiles_not_enabled_error() {
    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_sub_settings(SubSettingsConfig::new("remotes")) // No .with_profiles()
        .build()
        .unwrap();

    let remotes = manager.sub_settings("remotes").unwrap();
    let result = remotes.profiles();

    assert!(result.is_err());
}

// =============================================================================
// Profile Directory Structure
// =============================================================================

#[test]
fn test_profile_directory_structure() {
    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_sub_settings(SubSettingsConfig::new("remotes").with_profiles())
        .build()
        .unwrap();

    let remotes = manager.sub_settings("remotes").unwrap();

    // Add data to default profile
    remotes.set("gdrive", &json!({"type": "drive"})).unwrap();

    // Create and switch to work profile
    let profiles = remotes.profiles().unwrap();
    profiles.create("work").unwrap();

    // Verify directory structure
    let remotes_dir = temp_dir.path().join("remotes");
    assert!(remotes_dir.join(".profiles.json").exists());
    assert!(remotes_dir.join("profiles").join("default").is_dir());
    assert!(remotes_dir.join("profiles").join("work").is_dir());
    assert!(
        remotes_dir
            .join("profiles")
            .join("default")
            .join("gdrive.json")
            .exists()
    );
}

// =============================================================================
// Single-File Mode with Profiles
// =============================================================================

#[test]
fn test_single_file_mode_with_profiles() {
    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_sub_settings(SubSettingsConfig::singlefile("backends").with_profiles())
        .build()
        .unwrap();

    let backends = manager.sub_settings("backends").unwrap();

    // Add data
    backends
        .set("local", &json!({"host": "localhost"}))
        .unwrap();

    let profiles = backends.profiles().unwrap();
    profiles.create("work").unwrap();

    // Verify single file in profile directory
    let backends_dir = temp_dir.path().join("backends");
    assert!(backends_dir.join(".profiles.json").exists());
    assert!(
        backends_dir
            .join("profiles")
            .join("default")
            .join("backends.json")
            .exists()
    );
}

#[test]
fn test_single_file_profile_migration() {
    let temp_dir = TempDir::new().unwrap();
    let backends_file = temp_dir.path().join("backends.json");

    // 1. Setup Legacy Flat Structure
    std::fs::write(&backends_file, r#"{ "local": { "type": "local" } }"#).unwrap();

    // 2. Initialize Manager with Profiles Enabled for this single-file sub-setting
    let _manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_sub_settings(SubSettingsConfig::singlefile("backends").with_profiles())
        .build()
        .unwrap();

    // 3. Verify Migration
    // The original file should be gone (or rather, moved)
    assert!(
        !backends_file.exists(),
        "Legacy file should have been moved"
    );

    // The single-file container directory should exist
    let backends_dir = temp_dir.path().join("backends");
    assert!(backends_dir.is_dir());

    // Manifest should exist
    assert!(backends_dir.join(".profiles.json").exists());

    // The file should be inside the default profile
    let migrated_file = backends_dir
        .join("profiles")
        .join("default")
        .join("backends.json");

    assert!(
        migrated_file.exists(),
        "File should be migrated to default profile"
    );

    // Check content
    let content = std::fs::read_to_string(migrated_file).unwrap();
    assert!(content.contains("local"));
}

// =============================================================================
// Main Settings Profiles
// =============================================================================

#[test]
fn test_main_settings_profiles() {
    use rcman::{SettingMetadata, SettingsSchema};
    use serde::{Deserialize, Serialize};
    use std::collections::HashMap;

    #[derive(Serialize, Deserialize, Default)]
    struct TestSettings {
        #[serde(default)]
        general: GeneralSettings,
    }

    #[derive(Serialize, Deserialize)]
    struct GeneralSettings {
        #[serde(default = "default_theme")]
        theme: String,
    }

    fn default_theme() -> String {
        "light".to_string()
    }

    impl Default for GeneralSettings {
        fn default() -> Self {
            Self {
                theme: default_theme(),
            }
        }
    }

    impl SettingsSchema for TestSettings {
        fn get_metadata() -> HashMap<String, SettingMetadata> {
            let mut map = HashMap::new();
            map.insert(
                "general.theme".to_string(),
                SettingMetadata::text("light").meta_str("label", "Theme"),
            );
            map
        }
    }

    let temp_dir = TempDir::new().unwrap();

    let config = SettingsConfig::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_schema::<TestSettings>()
        .with_profiles() // Enable profiles for main settings
        .build();
    let manager = SettingsManager::new(config).unwrap();

    // Verify profiles are enabled
    assert!(manager.is_profiles_enabled());

    // Check default profile
    assert_eq!(manager.active_profile().unwrap(), "default");

    // Save setting in default profile
    manager
        .save_setting("general", "theme", &json!("dark"))
        .unwrap();

    // Create and switch to work profile
    manager.create_profile("work").unwrap();
    manager.switch_profile("work").unwrap();

    assert_eq!(manager.active_profile().unwrap(), "work");

    // Work profile should have default theme (light)
    let settings: TestSettings = manager.get_all().unwrap();
    assert_eq!(settings.general.theme, "light");

    // Save a different theme in work profile
    manager
        .save_setting("general", "theme", &json!("ocean"))
        .unwrap();

    // Switch back to default - should have dark theme
    manager.switch_profile("default").unwrap();
    let settings: TestSettings = manager.get_all().unwrap();
    assert_eq!(settings.general.theme, "dark");

    // Switch to work - should have ocean theme
    manager.switch_profile("work").unwrap();
    let settings: TestSettings = manager.get_all().unwrap();
    assert_eq!(settings.general.theme, "ocean");
}

#[test]
fn test_main_profile_switch_emits_changed_setting_callbacks() {
    use rcman::{SettingMetadata, SettingsSchema};
    use serde::{Deserialize, Serialize};
    use std::collections::HashMap;

    #[derive(Default, Serialize, Deserialize)]
    struct TestSettings {
        general: GeneralSettings,
    }

    #[derive(Default, Serialize, Deserialize)]
    struct GeneralSettings {
        theme: String,
    }

    impl SettingsSchema for TestSettings {
        fn get_metadata() -> HashMap<String, SettingMetadata> {
            let mut map = HashMap::new();
            map.insert(
                "general.theme".to_string(),
                SettingMetadata::text("light").meta_str("label", "Theme"),
            );
            map
        }
    }

    let temp_dir = TempDir::new().unwrap();

    let config = SettingsConfig::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_schema::<TestSettings>()
        .with_profiles()
        .build();
    let manager = SettingsManager::new(config).unwrap();

    manager
        .save_setting("general", "theme", &json!("dark"))
        .unwrap();
    manager.create_profile("work").unwrap();
    manager.switch_profile("work").unwrap();
    manager
        .save_setting("general", "theme", &json!("ocean"))
        .unwrap();

    let events = Arc::new(Mutex::new(Vec::new()));
    let events_clone = Arc::clone(&events);
    manager.events().on_change(move |key, old, new| {
        events_clone
            .lock()
            .unwrap()
            .push((key.to_string(), old.clone(), new.clone()));
    });

    manager.switch_profile("default").unwrap();
    manager.switch_profile("work").unwrap();

    let recorded = events.lock().unwrap();
    assert_eq!(recorded.len(), 2);
    assert!(recorded.iter().any(|(key, old, new)| key == "general.theme"
        && *old == json!("ocean")
        && *new == json!("dark")));
    assert!(recorded.iter().any(|(key, old, new)| key == "general.theme"
        && *old == json!("dark")
        && *new == json!("ocean")));
}

#[test]
fn test_main_profile_switch_without_value_change_emits_no_callbacks() {
    use rcman::{SettingMetadata, SettingsSchema};
    use serde::{Deserialize, Serialize};
    use std::collections::HashMap;

    #[derive(Default, Serialize, Deserialize)]
    struct TestSettings {
        general: GeneralSettings,
    }

    #[derive(Default, Serialize, Deserialize)]
    struct GeneralSettings {
        theme: String,
    }

    impl SettingsSchema for TestSettings {
        fn get_metadata() -> HashMap<String, SettingMetadata> {
            let mut map = HashMap::new();
            map.insert(
                "general.theme".to_string(),
                SettingMetadata::text("light").meta_str("label", "Theme"),
            );
            map
        }
    }

    let temp_dir = TempDir::new().unwrap();

    let config = SettingsConfig::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_schema::<TestSettings>()
        .with_profiles()
        .build();
    let manager = SettingsManager::new(config).unwrap();

    manager.create_profile("work").unwrap();

    let callback_count = Arc::new(Mutex::new(0usize));
    let callback_count_clone = Arc::clone(&callback_count);
    manager.events().on_change(move |_key, _old, _new| {
        let mut guard = callback_count_clone.lock().unwrap();
        *guard += 1;
    });

    manager.switch_profile("work").unwrap();
    manager.switch_profile("default").unwrap();

    assert_eq!(*callback_count.lock().unwrap(), 0);
}

#[test]
fn test_main_settings_profiles_directory_structure() {
    use rcman::{SettingMetadata, SettingsSchema};
    use serde::{Deserialize, Serialize};
    use std::collections::HashMap;

    #[derive(Default, Serialize, Deserialize)]
    struct TestSettings {
        ui: UiSettings,
    }

    #[derive(Default, Serialize, Deserialize)]
    struct UiSettings {
        theme: String,
    }

    impl SettingsSchema for TestSettings {
        fn get_metadata() -> HashMap<String, SettingMetadata> {
            let mut map = HashMap::new();
            map.insert(
                "ui.theme".to_string(),
                SettingMetadata::text("light").meta_str("label", "Theme"),
            );
            map
        }
    }

    let temp_dir = TempDir::new().unwrap();

    let config = SettingsConfig::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_schema::<TestSettings>()
        .with_profiles()
        .build();
    let manager = SettingsManager::new(config).unwrap();

    // Save something to create the default profile directory
    manager.save_setting("ui", "theme", &json!("dark")).unwrap();

    manager.create_profile("work").unwrap();

    // Check directory structure
    // .profiles.json should exist at config root
    assert!(
        temp_dir.path().join(".profiles.json").exists(),
        ".profiles.json should exist"
    );

    // profiles/ directory should exist
    let profiles_dir = temp_dir.path().join("profiles");
    assert!(profiles_dir.exists(), "profiles/ directory should exist");

    // work profile dir exists because we created it
    assert!(
        profiles_dir.join("work").exists(),
        "work profile directory should exist"
    );

    // default profile dir should exist after saving
    assert!(
        profiles_dir.join("default").exists(),
        "default profile directory should exist after saving"
    );
    assert!(
        profiles_dir.join("default").join("settings.json").exists(),
        "settings.json should exist in default profile"
    );
}

#[test]
fn test_main_profile_propagation_with_mixed_sub_settings() {
    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_profiles()
        .with_sub_settings(SubSettingsConfig::new("remotes").with_profiles())
        .with_sub_settings(SubSettingsConfig::new("shared"))
        .build()
        .unwrap();

    manager.create_profile("work").unwrap();
    manager.switch_profile("work").unwrap();

    let remotes = manager.sub_settings("remotes").unwrap();
    assert_eq!(remotes.profiles().unwrap().active().unwrap(), "work");

    let shared = manager.sub_settings("shared").unwrap();
    assert!(matches!(
        shared.profiles(),
        Err(rcman::Error::ProfilesNotEnabled)
    ));
}

#[cfg(any(feature = "keychain", feature = "encrypted-file"))]
#[test]
#[cfg_attr(
    feature = "keychain",
    ignore = "Requires Secret Service daemon (not available in CI)"
)]
fn test_secret_reset_is_profile_scoped() {
    use rcman::{SettingMetadata, SettingsSchema};
    use serde::{Deserialize, Serialize};
    use std::collections::HashMap;

    #[derive(Default, Serialize, Deserialize)]
    struct TestSettings {
        api: ApiSettings,
    }

    #[derive(Default, Serialize, Deserialize)]
    struct ApiSettings {
        key: String,
    }

    impl SettingsSchema for TestSettings {
        fn get_metadata() -> HashMap<String, SettingMetadata> {
            let mut map = HashMap::new();
            map.insert(
                "api.key".to_string(),
                SettingMetadata::text("")
                    .meta_str("label", "API Key")
                    .secret(),
            );
            map
        }
    }

    let temp_dir = TempDir::new().unwrap();

    let config = SettingsConfig::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_schema::<TestSettings>()
        .with_profiles()
        .with_credentials()
        .build();
    let manager = SettingsManager::new(config).unwrap();

    manager
        .save_setting("api", "key", &json!("default-secret"))
        .unwrap();

    manager.create_profile("work").unwrap();
    manager.switch_profile("work").unwrap();
    manager
        .save_setting("api", "key", &json!("work-secret"))
        .unwrap();
    manager.reset_setting("api", "key").unwrap();

    let work_metadata = manager.metadata().unwrap();
    assert_eq!(work_metadata.get("api.key").unwrap().value, Some(json!("")));

    manager.switch_profile("default").unwrap();
    let default_metadata = manager.metadata().unwrap();
    assert_eq!(
        default_metadata.get("api.key").unwrap().value,
        Some(json!("default-secret"))
    );
}

// =============================================================================
// Profile-Scoped Backup & Restore
// (Migrated from the former `profile_backup_restore.rs` integration test.)
// =============================================================================

#[cfg(feature = "backup")]
#[test]
fn test_profile_backup_restore_full() {
    let temp = tempdir().unwrap();
    let config_dir = temp.path().join("config");
    fs::create_dir_all(&config_dir).unwrap();

    // 1. Setup Manager with Profiles Enabled
    let config = SettingsConfigBuilder::new("test-app", "1.0.0")
        .with_config_dir(&config_dir)
        .with_profiles()
        .build();

    let manager = SettingsManager::new(config).unwrap();
    manager
        .register_sub_settings(SubSettingsConfig::new("items").with_profiles())
        .unwrap();

    // 2. Create profiles
    if !manager.profiles().unwrap().exists("default").unwrap() {
        manager.create_profile("default").unwrap();
    }

    // Create 'work' profile
    manager.create_profile("work").unwrap();

    // 3. Add data to 'default'
    manager.switch_profile("default").unwrap();
    // Use sub-settings for data since SettingsManager requires schema
    let items = manager.sub_settings("items").unwrap();
    items.set("item1", &json!({"val": 1})).unwrap();

    // 4. Switch to 'work' and add data
    manager.switch_profile("work").unwrap();

    let items = manager.sub_settings("items").unwrap();
    items.set("item1", &json!({"val": 2})).unwrap();
    items.set("item2", &json!({"val": 3})).unwrap();

    // 5. Backup ALL profiles
    let backup_mgr = manager.backup();
    let backup_path = backup_mgr
        .create(&BackupOptions {
            output_dir: temp.path().join("backups"),
            include_settings: true,
            include_sub_settings: vec!["items".into()],
            include_profiles: vec![], // All
            ..Default::default()
        })
        .unwrap();

    // 6. Restore to fresh instance (profiled)
    let temp2 = tempdir().unwrap();
    let restore_config_dir = temp2.path().join("config");
    fs::create_dir_all(&restore_config_dir).unwrap();

    let config2 = SettingsConfigBuilder::new("test-app", "1.0.0")
        .with_config_dir(&restore_config_dir)
        .with_profiles()
        .build();

    let manager2 = SettingsManager::new(config2).unwrap();
    manager2
        .register_sub_settings(SubSettingsConfig::new("items").with_profiles())
        .unwrap();

    // Restore ALL
    let result = manager2
        .backup()
        .restore(&RestoreOptions {
            backup_path: backup_path.clone(),
            flags: rcman::backup::RestoreFlags {
                scope: rcman::backup::RestoreScope {
                    restore_settings: true,
                },
                ..Default::default()
            },
            restore_sub_settings: vec!["items".into()]
                .into_iter()
                .map(|s| (s, vec![]))
                .collect(),
            ..Default::default()
        })
        .unwrap();

    assert!(result.has_changes());

    // 7. Verify 'default' restore
    manager2.switch_profile("default").unwrap();

    let items2 = manager2.sub_settings("items").unwrap();
    let item1_def = items2.get_value("item1").unwrap();
    assert_eq!(item1_def["val"], 1);
    assert!(!items2.exists("item2").unwrap());

    // 8. Verify 'work' restore
    manager2.switch_profile("work").unwrap();

    let items2_work = manager2.sub_settings("items").unwrap();
    let item1_work = items2_work.get_value("item1").unwrap();
    assert_eq!(item1_work["val"], 2);
    let item2_work = items2_work.get_value("item2").unwrap();
    assert_eq!(item2_work["val"], 3);
}

#[cfg(all(feature = "encrypted-file", not(feature = "keychain")))]
#[derive(Default, Serialize, Deserialize)]
struct ProfileSecretSettings;

#[cfg(all(feature = "encrypted-file", not(feature = "keychain")))]
impl SettingsSchema for ProfileSecretSettings {
    fn get_metadata() -> HashMap<String, SettingMetadata> {
        settings! {
            "secrets.api_key" => SettingMetadata::text("").secret(),
        }
    }
}

#[cfg(all(feature = "encrypted-file", not(feature = "keychain")))]
#[test]
fn test_profile_restore_rehydrates_main_secrets_with_credentials() {
    let temp = tempdir().unwrap();
    let source_config_dir = temp.path().join("source");
    fs::create_dir_all(&source_config_dir).unwrap();

    let source_config = SettingsConfigBuilder::new("test-app", "1.0.0")
        .with_config_dir(&source_config_dir)
        .with_schema::<ProfileSecretSettings>()
        .with_profiles()
        .with_credentials()
        .build();

    let source = SettingsManager::new(source_config).unwrap();

    source.create_profile("work").unwrap();
    source.switch_profile("work").unwrap();
    source
        .save_setting("secrets", "api_key", &json!("work-profile-secret"))
        .unwrap();

    let backup_path = source
        .backup()
        .create(
            &BackupOptions::new()
                .output_dir(temp.path().join("backups"))
                .include_profile("work")
                .secret_policy(rcman::SecretBackupPolicy::Include),
        )
        .unwrap();

    let target_config_dir = temp.path().join("target");
    fs::create_dir_all(&target_config_dir).unwrap();

    let target_config = SettingsConfigBuilder::new("test-app", "1.0.0")
        .with_config_dir(&target_config_dir)
        .with_schema::<ProfileSecretSettings>()
        .with_profiles()
        .with_credentials()
        .build();

    let target = SettingsManager::new(target_config).unwrap();

    target
        .backup()
        .restore(
            &RestoreOptions::from_path(&backup_path)
                .overwrite(true)
                .restore_profile("work"),
        )
        .unwrap();

    let secret = target
        .credentials()
        .unwrap()
        .get_with_profile("secrets.api_key", Some("work"))
        .unwrap();
    assert_eq!(secret, Some("work-profile-secret".to_string()));

    let settings_path = target
        .config()
        .config_dir
        .join("profiles")
        .join("work")
        .join(&target.config().settings_file);
    let restored_settings: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(settings_path).unwrap()).unwrap();

    let persisted_key = restored_settings
        .get("secrets")
        .and_then(|secrets| secrets.get("api_key"));
    assert!(persisted_key.is_none() || persisted_key == Some(&serde_json::Value::Null));
}
