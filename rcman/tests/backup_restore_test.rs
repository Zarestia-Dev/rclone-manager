//! Backup & Restore Integration Tests
//!
//! Tests for the backup/restore functionality including:
//! - Creating encrypted and unencrypted backups
//! - Analyzing backups
//! - Restoring from backups
//! - Sub-settings inclusion in backups

mod common;

use common::TestFixture;
#[cfg(all(feature = "encrypted-file", not(feature = "keychain")))]
use rcman::SettingsManager;
use rcman::backup::{ExternalConfig, ExternalConfigProvider};
use serde_json::json;
use std::fs;
#[cfg(all(feature = "encrypted-file", not(feature = "keychain")))]
use std::io::Read;
#[cfg(all(feature = "encrypted-file", not(feature = "keychain")))]
use std::path::Path;

// =============================================================================
// Helper Functions
// =============================================================================

fn create_fixture_with_data() -> TestFixture {
    let fixture = TestFixture::with_sub_settings();

    // Load and set some non-default settings
    let _ = fixture.manager.get_all().unwrap();
    fixture
        .manager
        .save_setting("ui", "theme", &json!("light"))
        .unwrap();
    fixture
        .manager
        .save_setting("ui", "font_size", &json!(18.0))
        .unwrap();

    // Add some sub-settings data
    let remotes = fixture.manager.sub_settings("remotes").unwrap();
    remotes
        .set("gdrive", &json!({"type": "drive", "scope": "drive"}))
        .unwrap();
    remotes
        .set("s3", &json!({"type": "s3", "bucket": "my-bucket"}))
        .unwrap();

    fixture
}

struct TestExternalProvider {
    configs: Vec<ExternalConfig>,
}

impl ExternalConfigProvider for TestExternalProvider {
    fn get_configs(&self) -> Vec<ExternalConfig> {
        self.configs.clone()
    }
}

#[cfg(all(feature = "encrypted-file", not(feature = "keychain")))]
fn read_settings_from_backup_data(backup_path: &Path) -> Option<serde_json::Value> {
    let backup_file = fs::File::open(backup_path).unwrap();
    let mut outer_zip = zip::ZipArchive::new(backup_file).unwrap();

    let mut data_zip_entry = outer_zip.by_name("data.zip").unwrap();
    let mut data_zip_bytes = Vec::new();
    data_zip_entry.read_to_end(&mut data_zip_bytes).unwrap();

    let mut inner_zip = zip::ZipArchive::new(std::io::Cursor::new(data_zip_bytes)).unwrap();
    let Ok(mut settings_entry) = inner_zip.by_name("settings.json") else {
        return None;
    };

    let mut settings_content = String::new();
    settings_entry
        .read_to_string(&mut settings_content)
        .unwrap();

    Some(serde_json::from_str(&settings_content).unwrap())
}

#[cfg(all(feature = "encrypted-file", not(feature = "keychain")))]
fn create_credentials_manager(
    config_dir: &Path,
) -> SettingsManager<rcman::JsonStorage, common::TestSettings> {
    let config = rcman::SettingsConfig::builder("test-app", "1.0.0")
        .with_config_dir(config_dir)
        .with_schema::<common::TestSettings>()
        .with_credentials()
        .build();

    SettingsManager::new(config).unwrap()
}

#[path = "backup_restore_test/create_analyze_tests.rs"]
mod create_analyze_tests;
#[path = "backup_restore_test/external_configs_tests.rs"]
mod external_configs_tests;
#[path = "backup_restore_test/restore_modes_tests.rs"]
mod restore_modes_tests;
#[cfg(not(feature = "keychain"))]
#[path = "backup_restore_test/secret_policy_tests.rs"]
mod secret_policy_tests;
