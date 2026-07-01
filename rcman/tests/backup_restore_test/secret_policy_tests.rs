use super::*;
#[cfg(all(feature = "encrypted-file", not(feature = "keychain")))]
use rcman::RestoreOptions;
use rcman::{
    BackupOptions, SettingMetadata, SettingsManager, SettingsSchema, SubSettingsConfig, settings,
};
use serde::{Deserialize, Serialize};
use tempfile::TempDir;

#[cfg(not(any(feature = "keychain", feature = "encrypted-file")))]
#[derive(Default, Serialize, Deserialize, Clone)]
struct FileSecretSettings;

#[cfg(not(any(feature = "keychain", feature = "encrypted-file")))]
impl SettingsSchema for FileSecretSettings {
    fn get_metadata() -> std::collections::HashMap<String, SettingMetadata> {
        settings! {
            "secrets.api_key" => SettingMetadata::text("").secret(),
        }
    }
}

#[cfg(not(any(feature = "keychain", feature = "encrypted-file")))]
#[test]
fn test_encrypted_only_redacts_without_credentials_backend() {
    let temp = TempDir::new().unwrap();
    let backup_dir = temp.path().join("backups");

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp.path().join("cfg"))
        .with_schema::<FileSecretSettings>()
        .build()
        .unwrap();

    manager
        .save_setting("secrets", "api_key", &json!("plain-file-secret"))
        .unwrap();

    let backup_path = manager
        .backup()
        .create(
            &BackupOptions::new()
                .output_dir(&backup_dir)
                .secret_policy(rcman::SecretBackupPolicy::EncryptedOnly),
        )
        .unwrap();

    let backup_file = fs::File::open(&backup_path).unwrap();
    let mut outer_zip = zip::ZipArchive::new(backup_file).unwrap();
    let mut data_zip_entry = outer_zip.by_name("data.zip").unwrap();
    let mut data_zip_bytes = Vec::new();
    use std::io::Read as _;
    data_zip_entry.read_to_end(&mut data_zip_bytes).unwrap();

    let mut inner_zip = zip::ZipArchive::new(std::io::Cursor::new(data_zip_bytes)).unwrap();
    let mut settings_entry = inner_zip.by_name("settings.json").unwrap();
    let mut settings_content = String::new();
    settings_entry
        .read_to_string(&mut settings_content)
        .unwrap();

    let settings_value: serde_json::Value = serde_json::from_str(&settings_content).unwrap();
    let api_key = settings_value
        .get("secrets")
        .and_then(|secrets| secrets.get("api_key"));

    assert!(api_key.is_none() || api_key == Some(&serde_json::Value::Null));
}

#[cfg(not(any(feature = "keychain", feature = "encrypted-file")))]
#[derive(Default, Serialize, Deserialize, Clone)]
struct RemoteSecretSchema;

#[cfg(not(any(feature = "keychain", feature = "encrypted-file")))]
impl SettingsSchema for RemoteSecretSchema {
    fn get_metadata() -> std::collections::HashMap<String, SettingMetadata> {
        settings! {
            "type" => SettingMetadata::text("drive"),
            "token" => SettingMetadata::text("").secret(),
        }
    }
}

#[cfg(not(any(feature = "keychain", feature = "encrypted-file")))]
#[test]
fn test_encrypted_only_redacts_subsettings_secret_fields_without_password() {
    let temp = TempDir::new().unwrap();
    let backup_dir = temp.path().join("backups");

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp.path().join("cfg"))
        .with_schema::<FileSecretSettings>()
        .build()
        .unwrap();

    manager
        .register_sub_settings(
            SubSettingsConfig::new("remotes").with_schema::<RemoteSecretSchema>(),
        )
        .unwrap();

    manager
        .sub_settings("remotes")
        .unwrap()
        .set(
            "gdrive",
            &json!({"type": "drive", "token": "sub-secret-token"}),
        )
        .unwrap();

    let backup_path = manager
        .backup()
        .create(
            &BackupOptions::new()
                .output_dir(&backup_dir)
                .export_type(rcman::ExportType::SettingsOnly)
                .include_settings(false)
                .include_sub_settings("remotes")
                .secret_policy(rcman::SecretBackupPolicy::EncryptedOnly),
        )
        .unwrap();

    let backup_file = fs::File::open(&backup_path).unwrap();
    let mut outer_zip = zip::ZipArchive::new(backup_file).unwrap();
    let mut data_zip_entry = outer_zip.by_name("data.zip").unwrap();
    let mut data_zip_bytes = Vec::new();
    use std::io::Read as _;
    data_zip_entry.read_to_end(&mut data_zip_bytes).unwrap();

    let mut inner_zip = zip::ZipArchive::new(std::io::Cursor::new(data_zip_bytes)).unwrap();
    let mut remote_entry = inner_zip.by_name("remotes/gdrive.json").unwrap();
    let mut remote_content = String::new();
    remote_entry.read_to_string(&mut remote_content).unwrap();

    let remote_value: serde_json::Value = serde_json::from_str(&remote_content).unwrap();
    let token = remote_value.get("token");
    assert!(token.is_none());
}

#[cfg(all(feature = "encrypted-file", not(feature = "keychain")))]
#[test]
fn test_backup_secret_policy_include_exports_secret() {
    let temp = TempDir::new().unwrap();
    let backup_dir = temp.path().join("backups");
    let manager = create_credentials_manager(&temp.path().join("cfg"));

    manager
        .save_setting("api", "key", &json!("sk-live-include"))
        .unwrap();

    let backup_path = manager
        .backup()
        .create(
            &BackupOptions::new()
                .output_dir(&backup_dir)
                .secret_policy(rcman::SecretBackupPolicy::Include),
        )
        .unwrap();

    let settings_value = read_settings_from_backup_data(&backup_path).unwrap();
    assert_eq!(settings_value["api"]["key"], json!("sk-live-include"));
}

#[cfg(all(feature = "encrypted-file", not(feature = "keychain")))]
#[test]
fn test_backup_secret_policy_encrypted_only_without_password_redacts() {
    let temp = TempDir::new().unwrap();
    let backup_dir = temp.path().join("backups");
    let manager = create_credentials_manager(&temp.path().join("cfg"));

    manager
        .save_setting("api", "key", &json!("sk-live-encrypted-only"))
        .unwrap();

    let backup_path = manager
        .backup()
        .create(
            &BackupOptions::new()
                .output_dir(&backup_dir)
                .secret_policy(rcman::SecretBackupPolicy::EncryptedOnly),
        )
        .unwrap();

    match read_settings_from_backup_data(&backup_path) {
        None => {}
        Some(settings_value) => {
            let key_value = settings_value.get("api").and_then(|api| api.get("key"));
            assert!(key_value.is_none() || key_value == Some(&serde_json::Value::Null));
        }
    }
}

#[cfg(all(feature = "encrypted-file", not(feature = "keychain")))]
#[test]
fn test_restore_rehydrates_secret_credentials_from_backup() {
    let temp = TempDir::new().unwrap();
    let source = create_credentials_manager(&temp.path().join("source"));
    let target = create_credentials_manager(&temp.path().join("target"));
    let backup_dir = temp.path().join("backups");

    source
        .save_setting("api", "key", &json!("sk-restore-secret"))
        .unwrap();

    let backup_path = source
        .backup()
        .create(
            &BackupOptions::new()
                .output_dir(&backup_dir)
                .secret_policy(rcman::SecretBackupPolicy::Include),
        )
        .unwrap();

    target
        .backup()
        .restore(&RestoreOptions::from_path(&backup_path).overwrite(true))
        .unwrap();

    target.invalidate_cache();

    assert_eq!(
        target.get_value("api.key").unwrap(),
        json!("sk-restore-secret")
    );

    let settings_path = target.config().settings_path();
    let restored_settings: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(settings_path).unwrap()).unwrap();

    let persisted_key = restored_settings.get("api").and_then(|api| api.get("key"));
    assert!(persisted_key.is_none() || persisted_key == Some(&serde_json::Value::Null));
}
