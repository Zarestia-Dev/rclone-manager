//! YAML Storage Integration Tests
//!
//! Tests for YAML storage backend with various rcman features:
//! - Basic settings management with YAML
//! - Sub-settings (multi-file and single-file modes)
//! - Profiles with YAML storage
//! - Edge cases (null handling, nested structures)

#![cfg(feature = "yaml")]

mod common;

use common::TestSettings;
use rcman::{SettingsConfig, SettingsManager, SubSettingsConfig, YamlStorage};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tempfile::TempDir;

// Conditionally used by profile tests
#[cfg(feature = "profiles")]
use rcman::SettingsSchema;
#[cfg(feature = "profiles")]
use std::collections::HashMap;

// =============================================================================
// Basic YAML Settings Management
// =============================================================================

#[test]
fn test_yaml_basic_save_and_load() {
    let temp_dir = TempDir::new().unwrap();

    let config = SettingsConfig::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_storage::<YamlStorage>()
        .with_schema::<TestSettings>()
        .build();

    let manager = SettingsManager::new(config).unwrap();

    // Save a setting
    manager
        .save_setting("ui", "theme", &json!("light"))
        .unwrap();

    // Verify file is YAML
    let settings_file = temp_dir.path().join("settings.yaml");
    assert!(settings_file.exists(), "Settings file should be .yaml");

    let content = std::fs::read_to_string(&settings_file).unwrap();
    assert!(content.contains("ui:"), "YAML should have ui mapping");
    assert!(
        content.contains("theme: light"),
        "YAML should contain theme: light"
    );
}

#[test]
fn test_yaml_load_settings_struct() {
    let temp_dir = TempDir::new().unwrap();

    let config = SettingsConfig::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_storage::<YamlStorage>()
        .with_schema::<TestSettings>()
        .build();

    let manager = SettingsManager::new(config).unwrap();

    // Save some values
    manager
        .save_setting("ui", "theme", &json!("light"))
        .unwrap();
    manager
        .save_setting("ui", "font_size", &json!(16.0))
        .unwrap();

    // Load as struct
    let settings: TestSettings = manager.get_all().unwrap();
    assert_eq!(settings.ui.theme, "light");
    assert_eq!(settings.ui.font_size, 16.0);
}

#[test]
fn test_yaml_reset_setting() {
    let temp_dir = TempDir::new().unwrap();

    let config = SettingsConfig::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_storage::<YamlStorage>()
        .with_schema::<TestSettings>()
        .build();

    let manager = SettingsManager::new(config).unwrap();

    // Save non-default
    manager
        .save_setting("ui", "theme", &json!("light"))
        .unwrap();

    // Reset
    let default_value = manager.reset_setting("ui", "theme").unwrap();
    assert_eq!(default_value, json!("dark"));

    // Verify it's back to default
    let settings: TestSettings = manager.get_all().unwrap();
    assert_eq!(settings.ui.theme, "dark");
}

// =============================================================================
// YAML Sub-Settings (Multi-File Mode)
// =============================================================================

#[test]
fn test_yaml_sub_settings_multi_file() {
    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_storage::<YamlStorage>()
        .with_sub_settings(SubSettingsConfig::new("remotes"))
        .build()
        .unwrap();

    let remotes = manager.sub_settings("remotes").unwrap();

    // Create entries
    remotes
        .set("gdrive", &json!({"type": "drive", "client_id": "abc123"}))
        .unwrap();
    remotes
        .set("s3", &json!({"type": "s3", "bucket": "my-bucket"}))
        .unwrap();

    // Verify files are YAML
    let remotes_dir = temp_dir.path().join("remotes");
    assert!(remotes_dir.join("gdrive.yaml").exists());
    assert!(remotes_dir.join("s3.yaml").exists());

    // Verify content is valid YAML
    let gdrive_content = std::fs::read_to_string(remotes_dir.join("gdrive.yaml")).unwrap();
    assert!(gdrive_content.contains("type: drive"));
    assert!(gdrive_content.contains("client_id: abc123"));

    // Read back
    let gdrive = remotes.get_value("gdrive").unwrap();
    assert_eq!(gdrive["type"], "drive");
}

#[test]
fn test_yaml_sub_settings_list() {
    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_storage::<YamlStorage>()
        .with_sub_settings(SubSettingsConfig::new("configs"))
        .build()
        .unwrap();

    let configs = manager.sub_settings("configs").unwrap();

    configs.set("alpha", &json!({"name": "Alpha"})).unwrap();
    configs.set("beta", &json!({"name": "Beta"})).unwrap();
    configs.set("gamma", &json!({"name": "Gamma"})).unwrap();

    let mut list = configs.list().unwrap();
    list.sort();

    assert_eq!(list, vec!["alpha", "beta", "gamma"]);
}

#[test]
fn test_yaml_sub_settings_delete() {
    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_storage::<YamlStorage>()
        .with_sub_settings(SubSettingsConfig::new("remotes"))
        .build()
        .unwrap();

    let remotes = manager.sub_settings("remotes").unwrap();

    remotes.set("temp", &json!({"type": "temp"})).unwrap();
    let file_path = temp_dir.path().join("remotes").join("temp.yaml");
    assert!(file_path.exists());

    remotes.delete("temp").unwrap();
    assert!(!file_path.exists());
    assert!(!remotes.exists("temp").unwrap());
}

// =============================================================================
// YAML Sub-Settings (Single-File Mode)
// =============================================================================

#[test]
fn test_yaml_sub_settings_single_file() {
    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_storage::<YamlStorage>()
        .with_sub_settings(SubSettingsConfig::singlefile("backends"))
        .build()
        .unwrap();

    let backends = manager.sub_settings("backends").unwrap();

    backends
        .set("local", &json!({"host": "localhost", "port": 5572}))
        .unwrap();
    backends
        .set("remote", &json!({"host": "192.168.1.1", "port": 5573}))
        .unwrap();

    // Should be a single file
    let backends_file = temp_dir.path().join("backends.yaml");
    assert!(backends_file.exists());
    assert!(backends_file.is_file());

    // Verify content structure
    let content = std::fs::read_to_string(&backends_file).unwrap();
    assert!(content.contains("local:") || content.contains("host: localhost"));
    assert!(content.contains("remote:") || content.contains("host: 192.168.1.1"));

    // Read back both entries
    let local = backends.get_value("local").unwrap();
    assert_eq!(local["host"], "localhost");

    let remote = backends.get_value("remote").unwrap();
    assert_eq!(remote["host"], "192.168.1.1");
}

// =============================================================================
// YAML with Profiles
// =============================================================================

#[cfg(feature = "profiles")]
#[test]
fn test_yaml_profiles_basic() {
    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_storage::<YamlStorage>()
        .with_sub_settings(SubSettingsConfig::new("remotes").with_profiles())
        .build()
        .unwrap();

    let remotes = manager.sub_settings("remotes").unwrap();
    let profiles = remotes.profiles().unwrap();

    // Add data to default profile
    remotes
        .set("personal-drive", &json!({"type": "drive"}))
        .unwrap();

    // Create work profile
    profiles.create("work").unwrap();
    remotes.switch_profile("work").unwrap();

    // Add work-specific data
    remotes
        .set("company-drive", &json!({"type": "sharepoint"}))
        .unwrap();

    // Verify directory structure uses .yaml files
    let remotes_dir = temp_dir.path().join("remotes");
    assert!(
        remotes_dir.join(".profiles.yaml").exists(),
        "Manifest should be .yaml"
    );

    let default_dir = remotes_dir.join("profiles").join("default");
    assert!(default_dir.join("personal-drive.yaml").exists());

    let work_dir = remotes_dir.join("profiles").join("work");
    assert!(work_dir.join("company-drive.yaml").exists());

    // Switch back and verify isolation
    remotes.switch_profile("default").unwrap();
    assert!(remotes.exists("personal-drive").unwrap());
    assert!(!remotes.exists("company-drive").unwrap());
}

#[cfg(feature = "profiles")]
#[test]
fn test_yaml_main_settings_profiles() {
    use rcman::SettingMetadata;

    #[derive(Serialize, Deserialize, Default)]
    struct SimpleSettings {
        #[serde(default)]
        app: AppSection,
    }

    #[derive(Serialize, Deserialize)]
    struct AppSection {
        #[serde(default = "default_mode")]
        mode: String,
    }

    fn default_mode() -> String {
        "normal".to_string()
    }

    impl Default for AppSection {
        fn default() -> Self {
            Self {
                mode: default_mode(),
            }
        }
    }

    impl SettingsSchema for SimpleSettings {
        fn get_metadata() -> HashMap<String, SettingMetadata> {
            let mut map = HashMap::new();
            map.insert(
                "app.mode".to_string(),
                SettingMetadata::text("normal").meta_str("label", "Mode"),
            );
            map
        }
    }

    let temp_dir = TempDir::new().unwrap();

    let config = SettingsConfig::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_storage::<YamlStorage>()
        .with_schema::<SimpleSettings>()
        .with_profiles()
        .build();

    let manager = SettingsManager::new(config).unwrap();

    // Save in default profile
    manager
        .save_setting("app", "mode", &json!("debug"))
        .unwrap();

    // Create and switch to production profile
    manager.create_profile("production").unwrap();
    manager.switch_profile("production").unwrap();

    // Verify production has default value
    let settings: SimpleSettings = manager.get_all().unwrap();
    assert_eq!(settings.app.mode, "normal");

    // Save production-specific
    manager
        .save_setting("app", "mode", &json!("release"))
        .unwrap();

    // Verify manifest is YAML
    assert!(temp_dir.path().join(".profiles.yaml").exists());

    // Verify profile settings are YAML
    let prod_settings = temp_dir
        .path()
        .join("profiles")
        .join("production")
        .join("settings.yaml");
    assert!(prod_settings.exists());
}

// =============================================================================
// YAML Edge Cases
// =============================================================================

#[test]
fn test_yaml_nested_structures() {
    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_storage::<YamlStorage>()
        .with_sub_settings(SubSettingsConfig::new("configs"))
        .build()
        .unwrap();

    let configs = manager.sub_settings("configs").unwrap();

    // Save deeply nested structure
    configs
        .set(
            "complex",
            &json!({
                "server": {
                    "host": "localhost",
                    "port": 8080,
                    "tls": {
                        "enabled": true,
                        "cert_path": "/path/to/cert"
                    }
                },
                "database": {
                    "connection_string": "postgres://localhost/db"
                }
            }),
        )
        .unwrap();

    // Read back and verify structure preserved
    let loaded = configs.get_value("complex").unwrap();
    assert_eq!(loaded["server"]["host"], "localhost");
    assert_eq!(loaded["server"]["tls"]["enabled"], true);
    assert_eq!(
        loaded["database"]["connection_string"],
        "postgres://localhost/db"
    );
}

#[test]
fn test_yaml_arrays() {
    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_storage::<YamlStorage>()
        .with_sub_settings(SubSettingsConfig::new("configs"))
        .build()
        .unwrap();

    let configs = manager.sub_settings("configs").unwrap();

    // Save with arrays
    configs
        .set(
            "with_arrays",
            &json!({
                "tags": ["tag1", "tag2", "tag3"],
                "ports": [80, 443, 8080],
                "enabled_features": ["auth", "logging"]
            }),
        )
        .unwrap();

    let loaded = configs.get_value("with_arrays").unwrap();
    assert_eq!(loaded["tags"].as_array().unwrap().len(), 3);
    assert_eq!(loaded["ports"][0], 80);
}

#[test]
fn test_yaml_special_characters_in_strings() {
    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_storage::<YamlStorage>()
        .with_sub_settings(SubSettingsConfig::new("configs"))
        .build()
        .unwrap();

    let configs = manager.sub_settings("configs").unwrap();

    // Test special characters that might need escaping
    configs
        .set(
            "special",
            &json!({
                "path_with_backslash": "C:\\Users\\test",
                "string_with_quotes": "He said \"hello\"",
                "multiline_like": "line1\nline2\nline3",
                "unicode": "日本語テスト"
            }),
        )
        .unwrap();

    let loaded = configs.get_value("special").unwrap();
    assert_eq!(loaded["path_with_backslash"], "C:\\Users\\test");
    assert_eq!(loaded["string_with_quotes"], "He said \"hello\"");
    assert!(loaded["multiline_like"].as_str().unwrap().contains('\n'));
    assert_eq!(loaded["unicode"], "日本語テスト");
}

#[test]
fn test_yaml_optional_fields() {
    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct ConfigWithOptional {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        port: Option<u16>,
    }

    let temp_dir = TempDir::new().unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_storage::<YamlStorage>()
        .with_sub_settings(SubSettingsConfig::new("configs"))
        .build()
        .unwrap();

    let configs = manager.sub_settings("configs").unwrap();

    // Save with Some values
    let original_with = ConfigWithOptional {
        name: "test".to_string(),
        description: Some("A test config".to_string()),
        port: Some(8080),
    };
    configs.set("with_optional", &original_with).unwrap();

    // Save without optional fields (simulating None)
    let original_without = ConfigWithOptional {
        name: "minimal".to_string(),
        description: None,
        port: None,
    };
    configs.set("without_optional", &original_without).unwrap();

    // Both should load correctly
    let with_opt: ConfigWithOptional = configs.get("with_optional").unwrap();
    assert_eq!(with_opt, original_with);

    let without_opt: ConfigWithOptional = configs.get("without_optional").unwrap();
    assert_eq!(without_opt, original_without);

    // Verify skip_serializing_if works (keys should be missing in raw JSON)
    let raw_without = configs.get_value("without_optional").unwrap();
    assert!(raw_without.get("description").is_none());
    assert!(raw_without.get("port").is_none());
}

#[test]
fn test_yaml_concurrent_writes() {
    use std::sync::Arc;
    use std::thread;

    let temp_dir = TempDir::new().unwrap();

    let manager = Arc::new(
        SettingsManager::builder("test-app", "1.0.0")
            .with_config_dir(temp_dir.path())
            .with_storage::<YamlStorage>()
            .with_sub_settings(SubSettingsConfig::new("configs"))
            .build()
            .unwrap(),
    );

    let mut handles = vec![];

    for i in 0..5 {
        let manager_clone = Arc::clone(&manager);
        let handle = thread::spawn(move || {
            let configs = manager_clone.sub_settings("configs").unwrap();
            configs
                .set(
                    &format!("config{i}"),
                    &json!({"id": i, "data": format!("data{i}")}),
                )
                .unwrap();
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.join().unwrap();
    }

    // Verify all configs exist
    let configs = manager.sub_settings("configs").unwrap();
    let list = configs.list().unwrap();
    assert_eq!(list.len(), 5);

    for i in 0..5 {
        let config = configs.get_value(&format!("config{i}")).unwrap();
        assert_eq!(config["id"], i);
    }
}

// =============================================================================
// YAML Migration
// =============================================================================

#[test]
fn test_yaml_sub_settings_migrator() {
    let temp_dir = TempDir::new().unwrap();

    // Write old format YAML directly
    let configs_dir = temp_dir.path().join("configs");
    std::fs::create_dir_all(&configs_dir).unwrap();
    std::fs::write(
        configs_dir.join("old.yaml"),
        "name: old config\nlegacy_field: should be migrated\n",
    )
    .unwrap();

    // Create manager with migrator
    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_storage::<YamlStorage>()
        .with_sub_settings(
            SubSettingsConfig::new("configs").with_migrator(|mut value| {
                if let Some(obj) = value.as_object_mut() {
                    // Migrate legacy_field to new_field
                    if let Some(legacy) = obj.remove("legacy_field") {
                        obj.insert("migrated_field".into(), legacy);
                    }
                    // Add version
                    if !obj.contains_key("version") {
                        obj.insert("version".into(), json!(2));
                    }
                }
                value
            }),
        )
        .build()
        .unwrap();

    let configs = manager.sub_settings("configs").unwrap();
    let loaded = configs.get_value("old").unwrap();

    // Verify migration happened
    assert!(loaded.get("legacy_field").is_none());
    assert_eq!(loaded["migrated_field"], "should be migrated");
    assert_eq!(loaded["version"], 2);
}
