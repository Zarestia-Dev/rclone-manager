//! Common test utilities for rcman integration tests
//!
//! Provides shared test fixtures, settings schemas, and helper functions.

#![allow(dead_code)]

use rcman::{
    EnvSource, SettingMetadata, SettingsConfig, SettingsManager, SettingsSchema, SubSettingsConfig,
    opt, settings,
};

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

// =============================================================================
// Mock Environment Source
// =============================================================================

#[derive(Clone, Default)]
pub struct MockEnvSource {
    vars: Arc<Mutex<HashMap<String, String>>>,
}

impl MockEnvSource {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, key: &str, value: &str) {
        self.vars
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
    }

    pub fn remove(&self, key: &str) {
        self.vars.lock().unwrap().remove(key);
    }
}

impl EnvSource for MockEnvSource {
    fn var(&self, key: &str) -> Result<String, std::env::VarError> {
        self.vars
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or(std::env::VarError::NotPresent)
    }
}

// =============================================================================
// Test Settings Schema
// =============================================================================

/// A comprehensive test settings struct covering all setting types
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct TestSettings {
    pub ui: UiSettings,
    pub general: GeneralSettings,
    pub api: ApiSettings,
    pub paths: PathsSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UiSettings {
    pub theme: String,
    pub font_size: f64,
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
            font_size: 14.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GeneralSettings {
    #[serde(rename = "tray_enabled")]
    pub tray_enabled: bool,
    pub language: String,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            tray_enabled: true,
            language: "en".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ApiSettings {
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct PathsSettings {
    #[serde(rename = "config_dir")]
    pub config_dir: String,
    #[serde(rename = "log_file")]
    pub log_file: String,
}

impl SettingsSchema for TestSettings {
    fn get_metadata() -> HashMap<String, SettingMetadata> {
        settings! {
            "ui.theme" => SettingMetadata::select("dark", vec![
                opt("light", "Light"),
                opt("dark", "Dark"),
                opt("system", "System"),
            ])
            .meta_str("label", "Theme")
            .meta_str("category", "appearance")
            .meta_str("description", "Application color theme")
            .meta_num("order", 1),

            "ui.font_size" => SettingMetadata::number(14.0)
                .meta_str("label", "Font Size")
                .meta_str("category", "appearance")
                .meta_str("description", "Base font size in pixels")
                .min(8.0)
                .max(32.0)
                .step(1.0)
                .meta_num("order", 2),

            "general.tray_enabled" => SettingMetadata::toggle(true)
                .meta_str("label", "Enable Tray")
                .meta_str("category", "general")
                .meta_str("description", "Show system tray icon")
                .meta_num("order", 1),

            "general.language" => SettingMetadata::select("en", vec![
                opt("en", "English"),
                opt("tr", "Turkish"),
                opt("de", "German"),
            ])
            .meta_str("label", "Language")
            .meta_str("category", "general")
            .meta_num("order", 2),

            "api.key" => {
                let s = SettingMetadata::text("")
                    .meta_str("label", "API Key")
                    .meta_str("category", "security")
                    .meta_str("description", "Secret API key for external services")
                    .meta_str("input_type", "password");
                #[cfg(any(feature = "keychain", feature = "encrypted-file"))]
                let s = s.secret();
                s
            },

            "paths.config_dir" => SettingMetadata::text("")
                .meta_str("label", "Config Directory")
                .meta_str("category", "paths")
                .meta_str("description", "Directory for configuration files")
                .meta_str("input_type", "path"),

            "paths.log_file" => SettingMetadata::text("")
                .meta_str("label", "Log File")
                .meta_str("category", "paths")
                .meta_str("description", "Path to the log file")
                .meta_str("input_type", "file"),
        }
    }
}

// =============================================================================
// Test Fixtures
// =============================================================================

/// Test fixture that provides a temporary directory and configured `SettingsManager`
pub struct TestFixture {
    pub temp_dir: TempDir,
    pub manager: SettingsManager<rcman::JsonStorage, TestSettings>,
    pub env_source: Arc<MockEnvSource>,
}

impl TestFixture {
    /// Create a new test fixture with default configuration
    pub fn new() -> Self {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let env_source = Arc::new(MockEnvSource::new());
        let config = SettingsConfig::builder("test-app", "1.0.0")
            .with_config_dir(temp_dir.path())
            .with_schema::<TestSettings>()
            .with_credentials()
            .with_env_source(env_source.clone() as Arc<dyn EnvSource>)
            .build();
        let manager = SettingsManager::new(config).expect("Failed to create manager");

        Self {
            temp_dir,
            manager,
            env_source,
        }
    }

    /// Create a fixture with sub-settings configured
    pub fn with_sub_settings() -> Self {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let env_source = Arc::new(MockEnvSource::new());
        let config = SettingsConfig::builder("test-app", "1.0.0")
            .with_config_dir(temp_dir.path())
            .with_schema::<TestSettings>()
            .with_credentials()
            .with_env_source(env_source.clone() as Arc<dyn EnvSource>)
            .build();
        let manager = SettingsManager::new(config).expect("Failed to create manager");

        // Register sub-settings manually (without schema validation for test flexibility)
        manager
            .register_sub_settings(SubSettingsConfig::new("remotes"))
            .unwrap();
        manager
            .register_sub_settings(SubSettingsConfig::singlefile("backends"))
            .unwrap();
        manager
            .register_sub_settings(SubSettingsConfig::singlefile("connections"))
            .unwrap();

        Self {
            temp_dir,
            manager,
            env_source,
        }
    }

    /// Create a fixture with environment variable prefix
    pub fn with_env_prefix(prefix: &str) -> Self {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let env_source = Arc::new(MockEnvSource::new());
        let config = SettingsConfig::builder("test-app", "1.0.0")
            .with_config_dir(temp_dir.path())
            .with_schema::<TestSettings>()
            .with_env_prefix(prefix)
            .with_credentials()
            .with_env_source(env_source.clone() as Arc<dyn EnvSource>)
            .build();
        let manager = SettingsManager::new(config).expect("Failed to create manager");

        Self {
            temp_dir,
            manager,
            env_source,
        }
    }

    /// Get the config directory path
    pub fn config_dir(&self) -> PathBuf {
        self.temp_dir.path().to_path_buf()
    }

    /// Get the settings file path
    pub fn settings_path(&self) -> PathBuf {
        self.temp_dir.path().join("settings.json")
    }
}

impl Default for TestFixture {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// Helper Functions
// =============================================================================

/// Read the raw settings JSON file content
pub fn read_settings_file(fixture: &TestFixture) -> Option<serde_json::Value> {
    let path = fixture.settings_path();
    if path.exists() {
        let content = std::fs::read_to_string(&path).ok()?;
        serde_json::from_str(&content).ok()
    } else {
        None
    }
}

/// Check if a key exists in the settings JSON file
pub fn key_exists_in_file(fixture: &TestFixture, key: &str) -> bool {
    read_settings_file(fixture).is_some_and(|json| json.get(key).is_some())
}
