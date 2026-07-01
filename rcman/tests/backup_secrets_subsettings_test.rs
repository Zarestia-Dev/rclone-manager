//! Backup Secret Injection Tests for Sub-Settings
//!
//! Tests verifying that secrets in sub-settings (connections, remotes, backend)
//! are properly included/excluded based on the SecretBackupPolicy

mod common;

use common::TestFixture;
use rcman::{SecretBackupPolicy, SettingMetadata, SubSettingsConfig, settings};
use serde_json::json;

fn setup_fixture() -> TestFixture {
    let fixture = TestFixture::with_sub_settings();

    // Re-register with schema for secrets
    fixture
        .manager
        .register_sub_settings(SubSettingsConfig::new("remotes").with_metadata(settings! {
            "type" => SettingMetadata::text(""),
            "scope" => SettingMetadata::text(""),
            "client_id" => SettingMetadata::text(""),
            "client_secret" => SettingMetadata::text("").secret(),
            "bucket" => SettingMetadata::text(""),
            "access_key" => SettingMetadata::text(""),
            "secret_key" => SettingMetadata::text("").secret(),
        }))
        .unwrap();

    fixture
        .manager
        .register_sub_settings(SubSettingsConfig::singlefile("connections").with_metadata(
            settings! {
                "host" => SettingMetadata::text("127.0.0.1"),
                "port" => SettingMetadata::number(0.0),
                "password" => SettingMetadata::text("").secret(),
                "config_password" => SettingMetadata::text("").secret(),
            },
        ))
        .unwrap();

    fixture
}

// =============================================================================
// Helper: Extract connections.json from backup
// =============================================================================
#[cfg(any(feature = "encrypted-file", feature = "keychain"))]
fn extract_connections_from_backup(
    backup_path: &std::path::Path,
    password: Option<&str>,
) -> Option<serde_json::Value> {
    let backup_file = std::fs::File::open(backup_path).ok()?;
    let mut outer_zip = zip::ZipArchive::new(backup_file).ok()?;

    let mut data_zip_entry = outer_zip.by_name("data.zip").ok()?;
    let mut data_zip_bytes = Vec::new();
    std::io::Read::read_to_end(&mut data_zip_entry, &mut data_zip_bytes).ok()?;

    let mut inner_zip = zip::ZipArchive::new(std::io::Cursor::new(data_zip_bytes)).ok()?;

    let target_name = "connections.json";
    let mut found_index = None;
    for i in 0..inner_zip.len() {
        if inner_zip.name_for_index(i) == Some(target_name) {
            found_index = Some(i);
            break;
        }
    }

    let index = found_index?;

    let mut connections_entry = if let Some(pwd) = password {
        inner_zip.by_index_decrypt(index, pwd.as_bytes()).ok()?
    } else {
        inner_zip.by_index(index).ok()?
    };

    let mut connections_content = String::new();
    std::io::Read::read_to_string(&mut connections_entry, &mut connections_content).ok()?;

    serde_json::from_str(&connections_content).ok()
}

#[cfg(any(feature = "encrypted-file", feature = "keychain"))]
fn extract_remotes_from_backup(
    backup_path: &std::path::Path,
    remote_name: &str,
    password: Option<&str>,
) -> Option<serde_json::Value> {
    let backup_file = std::fs::File::open(backup_path).ok()?;
    let mut outer_zip = zip::ZipArchive::new(backup_file).ok()?;

    let mut data_zip_entry = outer_zip.by_name("data.zip").ok()?;
    let mut data_zip_bytes = Vec::new();
    std::io::Read::read_to_end(&mut data_zip_entry, &mut data_zip_bytes).ok()?;

    let mut inner_zip = zip::ZipArchive::new(std::io::Cursor::new(data_zip_bytes)).ok()?;
    let path = format!("remotes/{}.json", remote_name);

    let mut found_index = None;
    for i in 0..inner_zip.len() {
        if inner_zip.name_for_index(i) == Some(&path) {
            found_index = Some(i);
            break;
        }
    }

    let index = found_index?;

    let mut remote_entry = if let Some(pwd) = password {
        inner_zip.by_index_decrypt(index, pwd.as_bytes()).ok()?
    } else {
        inner_zip.by_index(index).ok()?
    };

    let mut remote_content = String::new();
    std::io::Read::read_to_string(&mut remote_entry, &mut remote_content).ok()?;

    serde_json::from_str(&remote_content).ok()
}

// =============================================================================
// Tests
// =============================================================================

// Test that verifies Exclude policy removes secret fields from sub-settings in backups
#[test]
fn test_sub_settings_secrets_excluded() {
    let fixture = setup_fixture();
    let temp_dir = tempfile::tempdir().unwrap();

    // Add some connections with secret data
    let connections = fixture.manager.sub_settings("connections").unwrap();
    connections
        .set(
            "Local",
            &json!({
                "host": "127.0.0.1",
                "port": 51900,
                "password": "secret123"
            }),
        )
        .unwrap();

    // Create backup with Exclude policy (no secrets)
    let backup_path = fixture
        .manager
        .backup()
        .create(
            &rcman::BackupOptions::new()
                .output_dir(temp_dir.path())
                .secret_policy(SecretBackupPolicy::Exclude),
        )
        .expect("Backup creation failed");

    // Verify backup was created
    assert!(backup_path.exists(), "Backup file should exist");

    #[cfg(any(feature = "encrypted-file", feature = "keychain"))]
    {
        let connections = extract_connections_from_backup(&backup_path, None)
            .expect("Should be able to extract connections from backup");
        let local = &connections["Local"];
        assert_eq!(local["host"], "127.0.0.1");
        // Password should be excluded
        assert!(local["password"].is_null());
    }
}

#[test]
fn test_sub_settings_secrets_encrypted_with_password() {
    let fixture = setup_fixture();
    let temp_dir = tempfile::tempdir().unwrap();

    // Add connections
    let connections = fixture.manager.sub_settings("connections").unwrap();
    connections
        .set(
            "Local",
            &json!({
                "host": "127.0.0.1",
                "port": 51900,
                "password": "secret123"
            }),
        )
        .unwrap();

    // Create backup with EncryptedOnly policy + password
    let backup_path = fixture
        .manager
        .backup()
        .create(
            &rcman::BackupOptions::new()
                .output_dir(temp_dir.path())
                .secret_policy(SecretBackupPolicy::EncryptedOnly)
                .password("backup_password"),
        )
        .expect("Backup creation failed");

    // Verify backup was created
    assert!(backup_path.exists(), "Backup file should exist");

    #[cfg(any(feature = "encrypted-file", feature = "keychain"))]
    {
        let connections = extract_connections_from_backup(&backup_path, Some("backup_password"))
            .expect("Should be able to extract connections from backup");
        let local = &connections["Local"];
        assert_eq!(local["host"], "127.0.0.1");
        // Password should be included because it's an encrypted backup
        assert_eq!(local["password"], "secret123");
    }
}

#[test]
fn test_mixed_secrets_in_connections() {
    let fixture = setup_fixture();
    let temp_dir = tempfile::tempdir().unwrap();

    // Add connections: some with secrets, some without
    let connections = fixture.manager.sub_settings("connections").unwrap();
    connections
        .set(
            "WithSecret",
            &json!({
                "host": "127.0.0.1",
                "port": 51900,
                "password": "secret_value"
            }),
        )
        .unwrap();
    connections
        .set(
            "NoSecret",
            &json!({
                "host": "192.168.1.1",
                "port": 5572,
                "password": "empty_pass"
            }),
        )
        .unwrap();

    // Create backup
    let backup_path = fixture
        .manager
        .backup()
        .create(
            &rcman::BackupOptions::new()
                .output_dir(temp_dir.path())
                .secret_policy(SecretBackupPolicy::EncryptedOnly)
                .password("backup_password"),
        )
        .expect("Backup creation failed");

    // Verify backup was created
    assert!(backup_path.exists(), "Backup file should exist");

    #[cfg(any(feature = "encrypted-file", feature = "keychain"))]
    {
        let connections = extract_connections_from_backup(&backup_path, Some("backup_password"))
            .expect("Should be able to extract connections from backup");

        assert_eq!(connections["WithSecret"]["password"], "secret_value");
        assert_eq!(connections["NoSecret"]["password"], "empty_pass");
    }
}

#[test]
fn test_multiple_secrets_per_connection() {
    let fixture = setup_fixture();
    let temp_dir = tempfile::tempdir().unwrap();

    // Add a connection with multiple secret fields
    let connections = fixture.manager.sub_settings("connections").unwrap();
    connections
        .set(
            "MainConnection",
            &json!({
                "host": "127.0.0.1",
                "port": 51900,
                "password": "auth_pass",
                "config_password": "config_pass"
            }),
        )
        .unwrap();

    // Create backup
    let backup_path = fixture
        .manager
        .backup()
        .create(
            &rcman::BackupOptions::new()
                .output_dir(temp_dir.path())
                .secret_policy(SecretBackupPolicy::Exclude),
        )
        .expect("Backup creation failed");

    // Verify backup was created
    assert!(backup_path.exists(), "Backup file should exist");

    #[cfg(any(feature = "encrypted-file", feature = "keychain"))]
    {
        let connections = extract_connections_from_backup(&backup_path, None)
            .expect("Should be able to extract connections from backup");
        let conn = &connections["MainConnection"];
        assert!(conn["password"].is_null());
        assert!(conn["config_password"].is_null());
    }
}

#[test]
fn test_remote_secrets_excluded() {
    let fixture = setup_fixture();
    let temp_dir = tempfile::tempdir().unwrap();

    // Add a remote
    let remotes = fixture.manager.sub_settings("remotes").unwrap();
    remotes
        .set(
            "gdrive",
            &json!({
                "type": "drive",
                "scope": "drive",
                "client_id": "id_12345",
                "client_secret": "secret_abcde"
            }),
        )
        .unwrap();

    // Create backup with EXCLUDE policy
    let backup_path = fixture
        .manager
        .backup()
        .create(
            &rcman::BackupOptions::new()
                .output_dir(temp_dir.path())
                .secret_policy(SecretBackupPolicy::Exclude),
        )
        .expect("Backup creation failed");

    // Verify backup was created
    assert!(backup_path.exists(), "Backup file should exist");

    #[cfg(any(feature = "encrypted-file", feature = "keychain"))]
    {
        let remote = extract_remotes_from_backup(&backup_path, "gdrive", None)
            .expect("Should be able to extract remote from backup");
        assert_eq!(remote["client_id"], "id_12345");
        assert!(remote["client_secret"].is_null());
    }
}

#[test]
fn test_remote_secrets_encrypted() {
    let fixture = setup_fixture();
    let temp_dir = tempfile::tempdir().unwrap();

    // Add a remote
    let remotes = fixture.manager.sub_settings("remotes").unwrap();
    remotes
        .set(
            "s3",
            &json!({
                "type": "s3",
                "bucket": "my-bucket",
                "access_key": "AKIAIOSFODNN7EXAMPLE",
                "secret_key": "wJalrXUtnFEMI/K7MDENG"
            }),
        )
        .unwrap();

    // Create backup with EncryptedOnly policy + password
    let backup_path = fixture
        .manager
        .backup()
        .create(
            &rcman::BackupOptions::new()
                .output_dir(temp_dir.path())
                .secret_policy(SecretBackupPolicy::EncryptedOnly)
                .password("backup_password"),
        )
        .expect("Backup creation failed");

    // Verify backup was created
    assert!(backup_path.exists(), "Backup file should exist");

    #[cfg(any(feature = "encrypted-file", feature = "keychain"))]
    {
        let remote = extract_remotes_from_backup(&backup_path, "s3", Some("backup_password"))
            .expect("Should be able to extract remote from backup");
        assert_eq!(remote["access_key"], "AKIAIOSFODNN7EXAMPLE");
        assert_eq!(remote["secret_key"], "wJalrXUtnFEMI/K7MDENG");
    }
}
