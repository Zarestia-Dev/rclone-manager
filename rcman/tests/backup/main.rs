//! Backup & Restore Integration Tests
//!
//! Covers the full backup/restore surface area, organized as a single
//! integration crate with focused submodules:
//!
//! - `create_analyze` — creating and analyzing encrypted / unencrypted backups
//! - `restore_modes` — restoring backups (overwrite, skip, wrong-password, etc.)
//! - `external_configs` — including external config files in backups
//! - `secret_policy` — `SecretBackupPolicy` behaviour for main-settings secrets
//! - `sub_settings` — secret injection for sub-settings categories
//!
//! Submodules live under `tests/backup/` next to this `main.rs` and are
//! pulled in via standard `mod` declarations. The shared `common` fixtures
//! live at `tests/common/mod.rs` and are referenced with `#[path]` so all
//! integration test crates can share them.

#[path = "../common/mod.rs"]
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
// Submodules — standard module resolution finds these under `tests/backup/`.
// =============================================================================

mod create_analyze;
mod external_configs;
mod restore_modes;
mod secret_policy;
mod sub_settings;

// =============================================================================
// Shared helpers used by multiple submodules
// =============================================================================

/// Build a fixture with non-default main settings and a couple of sub-settings
/// entries, so that backup/restore tests have something interesting to chew on.
pub(crate) fn create_fixture_with_data() -> TestFixture {
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

/// Test external-config provider used by the `external_configs` submodule.
pub(crate) struct TestExternalProvider {
    pub configs: Vec<ExternalConfig>,
}

impl ExternalConfigProvider for TestExternalProvider {
    fn get_configs(&self) -> Vec<ExternalConfig> {
        self.configs.clone()
    }
}

#[cfg(all(feature = "encrypted-file", not(feature = "keychain")))]
pub(crate) fn read_settings_from_backup_data(backup_path: &Path) -> Option<serde_json::Value> {
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
pub(crate) fn create_credentials_manager(
    config_dir: &Path,
) -> SettingsManager<rcman::JsonStorage, common::TestSettings> {
    let config = rcman::SettingsConfig::builder("test-app", "1.0.0")
        .with_config_dir(config_dir)
        .with_schema::<common::TestSettings>()
        .with_credentials()
        .build();

    SettingsManager::new(config).unwrap()
}
