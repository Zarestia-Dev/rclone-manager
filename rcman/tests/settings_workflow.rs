//! Settings Workflow Integration Tests
//!
//! Tests for the complete settings lifecycle including:
//! - Creating and loading settings
//! - Saving and caching behavior
//! - Reset functionality
//! - Default value handling
//! - Environment variable overrides

mod common;

use common::{TestFixture, read_settings_file};
use serde_json::json;
use std::sync::{Arc, Mutex};

// =============================================================================
// Basic CRUD Operations
// =============================================================================

#[test]
fn test_create_and_load_settings() {
    let fixture = TestFixture::new();

    // Load settings (should get defaults)
    let settings = fixture.manager.get_all().unwrap();

    // Verify defaults match schema
    assert_eq!(settings.ui.theme, "dark");
    assert!((settings.ui.font_size - 14.0).abs() < f64::EPSILON);
    assert!(settings.general.tray_enabled);
    assert_eq!(settings.general.language, "en");
}

#[test]
fn test_save_setting_updates_cache() {
    let fixture = TestFixture::new();

    // Load initial settings
    let _ = fixture.manager.get_all().unwrap();

    // Save a new value
    fixture
        .manager
        .save_setting("ui", "theme", &json!("light"))
        .unwrap();

    // Load again - should get the cached/saved value
    let metadata = fixture.manager.metadata().unwrap();
    let theme_meta = metadata.get("ui.theme").unwrap();
    assert_eq!(theme_meta.value, Some(json!("light")));
}

#[test]
fn test_save_and_reload_persists() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let config_path = temp_dir.path().to_path_buf();

    // First session: save a value
    {
        let config = rcman::SettingsConfig::builder("test-app", "1.0.0")
            .with_config_dir(&config_path)
            .with_schema::<common::TestSettings>()
            .build();
        let manager = rcman::SettingsManager::new(config).unwrap();

        let _ = manager.get_all().unwrap();
        manager
            .save_setting("ui", "font_size", &json!(20.0))
            .unwrap();
    }

    // Second session: reload and verify
    {
        let config = rcman::SettingsConfig::builder("test-app", "1.0.0")
            .with_config_dir(&config_path)
            .with_schema::<common::TestSettings>()
            .build();
        let manager = rcman::SettingsManager::new(config).unwrap();

        let settings = manager.get_all().unwrap();
        assert!((settings.ui.font_size - 20.0).abs() < f64::EPSILON);
    }
}

// =============================================================================
// Reset Functionality
// =============================================================================

#[test]
fn test_reset_single_setting() {
    let fixture = TestFixture::new();

    // Load and modify
    let _ = fixture.manager.get_all().unwrap();
    fixture
        .manager
        .save_setting("ui", "theme", &json!("light"))
        .unwrap();

    // Reset to default
    let default_value = fixture.manager.reset_setting("ui", "theme").unwrap();

    assert_eq!(default_value, json!("dark"));

    // Verify it's back to default
    let metadata = fixture.manager.metadata().unwrap();
    let theme_meta = metadata.get("ui.theme").unwrap();
    assert_eq!(theme_meta.value, Some(json!("dark")));
}

#[test]
fn test_reset_all_settings() {
    let fixture = TestFixture::new();

    // Load and modify multiple settings
    let _ = fixture.manager.get_all().unwrap();
    fixture
        .manager
        .save_setting("ui", "theme", &json!("light"))
        .unwrap();
    fixture
        .manager
        .save_setting("ui", "font_size", &json!(20.0))
        .unwrap();
    fixture
        .manager
        .save_setting("general", "language", &json!("tr"))
        .unwrap();

    // Reset all
    fixture.manager.reset_all().unwrap();

    // Verify all are back to defaults
    let settings = fixture.manager.get_all().unwrap();
    assert_eq!(settings.ui.theme, "dark");
    assert!((settings.ui.font_size - 14.0).abs() < f64::EPSILON);
    assert_eq!(settings.general.language, "en");
}

#[test]
fn test_reset_all_emits_callbacks_for_changed_keys() {
    let fixture = TestFixture::new();

    let _ = fixture.manager.get_all().unwrap();

    fixture
        .manager
        .save_setting("ui", "theme", &json!("light"))
        .unwrap();
    fixture
        .manager
        .save_setting("general", "language", &json!("tr"))
        .unwrap();

    let events = Arc::new(Mutex::new(Vec::new()));
    let events_clone = Arc::clone(&events);
    fixture.manager.events().on_change(move |key, old, new| {
        events_clone
            .lock()
            .unwrap()
            .push((key.to_string(), old.clone(), new.clone()));
    });

    fixture.manager.reset_all().unwrap();

    let captured = events.lock().unwrap();
    assert_eq!(captured.len(), 2);
    assert!(captured.iter().any(|(key, old, new)| key == "ui.theme"
        && *old == json!("light")
        && *new == json!("dark")));
    assert!(captured.iter().any(|(key, old, new)| {
        key == "general.language" && *old == json!("tr") && *new == json!("en")
    }));
}

#[test]
fn test_reset_all_without_changes_emits_no_callbacks() {
    let fixture = TestFixture::new();

    let _ = fixture.manager.get_all().unwrap();

    let callback_count = Arc::new(Mutex::new(0usize));
    let callback_count_clone = Arc::clone(&callback_count);
    fixture.manager.events().on_change(move |_key, _old, _new| {
        let mut guard = callback_count_clone.lock().unwrap();
        *guard += 1;
    });

    fixture.manager.reset_all().unwrap();

    assert_eq!(*callback_count.lock().unwrap(), 0);
}

// =============================================================================
// Default Value Behavior
// =============================================================================

#[test]
fn test_default_value_not_stored_in_file() {
    let fixture = TestFixture::new();

    // Initially load settings
    let _ = fixture.manager.get_all().unwrap();

    // Save a non-default value first
    fixture
        .manager
        .save_setting("ui", "theme", &json!("light"))
        .unwrap();

    // Verify it's stored - checking for the category first
    let json = read_settings_file(&fixture).unwrap();
    assert!(json.get("ui").unwrap().get("theme").is_some());

    // Now save the default value back
    fixture
        .manager
        .save_setting("ui", "theme", &json!("dark"))
        .unwrap();

    // Default value should be REMOVED from the file
    let json = read_settings_file(&fixture).unwrap_or(json!({}));
    // Either the file is empty/non-existent (if all categories empty)
    // or the "ui" category might exist but "theme" should not be in it,
    // or "ui" category might be removed if empty.
    if let Some(ui) = json.get("ui") {
        assert!(ui.get("theme").is_none());
    }
}

#[test]
fn test_only_non_defaults_stored() {
    let fixture = TestFixture::new();

    // Load settings
    let _ = fixture.manager.get_all().unwrap();

    // Save one default and one non-default
    fixture
        .manager
        .save_setting("ui", "theme", &json!("dark")) // default
        .unwrap();
    fixture
        .manager
        .save_setting("ui", "font_size", &json!(20.0)) // non-default
        .unwrap();

    let json = read_settings_file(&fixture).unwrap();
    let ui = json.get("ui").expect("ui category should exist");

    // Default should not be stored
    assert!(ui.get("theme").is_none());
    // Non-default should be stored
    assert_eq!(ui.get("font_size"), Some(&json!(20.0)));
}

// =============================================================================
// Validation
// =============================================================================

#[test]
fn test_invalid_number_rejected() {
    let fixture = TestFixture::new();
    let _ = fixture.manager.get_all().unwrap();

    // Try to save a value outside the valid range (min=8, max=32)
    let result = fixture
        .manager
        .save_setting("ui", "font_size", &json!(100.0));

    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.to_string().contains("at most"));
}

#[test]
fn test_invalid_select_option_rejected() {
    let fixture = TestFixture::new();
    let _ = fixture.manager.get_all().unwrap();

    // Try to save an invalid option
    let result = fixture
        .manager
        .save_setting("ui", "theme", &json!("invalid_theme"));

    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.to_string().contains("available options"));
}

#[test]
fn test_setting_not_found_error() {
    let fixture = TestFixture::new();
    let _ = fixture.manager.get_all().unwrap();

    // Try to save a non-existent setting
    let result = fixture
        .manager
        .save_setting("nonexistent", "setting", &json!("value"));

    assert!(result.is_err());
}

// =============================================================================
// Environment Variable Overrides
// =============================================================================

#[test]
fn test_env_var_override() {
    let fixture = TestFixture::with_env_prefix("TESTAPP");

    // Set env var through mock
    fixture.env_source.set("TESTAPP_UI_THEME", "system");

    // Load settings
    let metadata = fixture.manager.metadata().unwrap();
    let theme_meta = metadata.get("ui.theme").unwrap();

    // Value should be overridden by env var
    assert_eq!(theme_meta.value, Some(json!("system")));
    assert!(theme_meta.get_meta_bool("env_override").unwrap_or(false));
}

#[test]
fn test_env_override_priority() {
    let temp_dir = tempfile::TempDir::new().unwrap();

    // First, save a value to file
    {
        let config = rcman::SettingsConfig::builder("test-app", "1.0.0")
            .with_config_dir(temp_dir.path())
            .with_schema::<common::TestSettings>()
            .build();
        let manager = rcman::SettingsManager::new(config).unwrap();

        let _ = manager.get_all().unwrap();
        manager
            .save_setting("ui", "theme", &json!("light"))
            .unwrap();
    }

    // Now load with env var override
    let env_source = std::sync::Arc::new(common::MockEnvSource::new());
    env_source.set("TEST2_UI_THEME", "system");

    let config = rcman::SettingsConfig::builder("test-app", "1.0.0")
        .with_config_dir(temp_dir.path())
        .with_schema::<common::TestSettings>()
        .with_env_prefix("TEST2")
        .with_env_source(env_source.clone() as std::sync::Arc<dyn rcman::EnvSource>)
        .build();
    let manager = rcman::SettingsManager::new(config).unwrap();

    let metadata = manager.metadata().unwrap();
    let theme_meta = metadata.get("ui.theme").unwrap();

    // Env var should override stored value
    assert_eq!(theme_meta.value, Some(json!("system")));
}

// =============================================================================
// Cache Invalidation
// =============================================================================

#[test]
fn test_invalidate_cache() {
    let fixture = TestFixture::new();

    // Load settings (populates cache)
    let _ = fixture.manager.get_all().unwrap();

    // Modify file directly (simulating external change)
    let path = fixture.settings_path();
    // Use correct nested structure
    std::fs::write(&path, r#"{"ui": {"theme": "light"}}"#).unwrap();

    // Cache still has old value
    let metadata = fixture.manager.metadata().unwrap();
    let theme_meta = metadata.get("ui.theme").unwrap();
    assert_eq!(theme_meta.value, Some(json!("dark"))); // cached default

    // Invalidate cache
    fixture.manager.invalidate_cache();

    // Now should pick up the file change
    let metadata = fixture.manager.metadata().unwrap();
    let theme_meta = metadata.get("ui.theme").unwrap();
    assert_eq!(theme_meta.value, Some(json!("light")));
}

// =============================================================================
// Path and File Settings
// =============================================================================

#[test]
fn test_path_and_file_settings() {
    let fixture = TestFixture::new();
    let _ = fixture.manager.get_all().unwrap();

    // Save directory path
    fixture
        .manager
        .save_setting("paths", "config_dir", &json!("/home/user/.config/myapp"))
        .unwrap();

    // Save file path
    fixture
        .manager
        .save_setting("paths", "log_file", &json!("/var/log/myapp.log"))
        .unwrap();

    // Reload and verify
    let metadata = fixture.manager.metadata().unwrap();

    let config_dir_meta = metadata.get("paths.config_dir").unwrap();
    assert_eq!(
        config_dir_meta.value,
        Some(json!("/home/user/.config/myapp"))
    );

    let log_file_meta = metadata.get("paths.log_file").unwrap();
    assert_eq!(log_file_meta.value, Some(json!("/var/log/myapp.log")));
}

// =============================================================================
// Concurrency
// =============================================================================

#[test]
fn test_concurrent_access() {
    use std::sync::Arc;
    use std::thread;

    let fixture = Arc::new(TestFixture::new());
    let mut handles = vec![];

    // Spawn 10 threads reading settings
    for _ in 0..10 {
        let fixture = Arc::clone(&fixture);
        handles.push(thread::spawn(move || {
            for _ in 0..50 {
                let _ = fixture.manager.metadata().unwrap();
            }
        }));
    }

    // Spawn 5 threads writing settings
    for i in 0..5 {
        let fixture = Arc::clone(&fixture);
        handles.push(thread::spawn(move || {
            for _ in 0..10 {
                let val = if i % 2 == 0 {
                    json!("light")
                } else {
                    json!("dark")
                };
                fixture.manager.save_setting("ui", "theme", &val).unwrap();
            }
        }));
    }

    // Wait for all
    for handle in handles {
        handle.join().unwrap();
    }

    // Verify consistency: data should be readable and valid JSON
    let metadata = fixture.manager.metadata().unwrap();
    let theme = metadata.get("ui.theme").unwrap();
    assert!(theme.value.is_some());
}
