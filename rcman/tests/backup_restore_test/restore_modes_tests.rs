use super::*;
use rcman::{BackupOptions, RestoreOptions};
use tempfile::TempDir;

#[test]
fn test_restore_backup() {
    let original_fixture = create_fixture_with_data();
    let backup_dir = TempDir::new().unwrap();

    let backup_path = original_fixture
        .manager
        .backup()
        .create(&BackupOptions::new().output_dir(backup_dir.path()))
        .unwrap();

    let new_fixture = TestFixture::with_sub_settings();

    let result = new_fixture
        .manager
        .backup()
        .restore(&RestoreOptions::from_path(&backup_path).overwrite(true))
        .unwrap();

    assert!(result.restored.contains(&"settings.json".to_string()));

    new_fixture.manager.invalidate_cache();

    let metadata = new_fixture.manager.metadata().unwrap();
    let theme_value = metadata.get("ui.theme").unwrap().value.clone();
    assert_eq!(theme_value, Some(json!("light")));

    let font_size_value = metadata.get("ui.font_size").unwrap().value.clone();
    assert_eq!(font_size_value, Some(json!(18.0)));

    let remotes = new_fixture.manager.sub_settings("remotes").unwrap();
    assert_eq!(remotes.get_value("gdrive").unwrap()["type"], "drive");
    assert_eq!(remotes.get_value("s3").unwrap()["type"], "s3");
}

#[test]
fn test_restore_encrypted_backup() {
    let original_fixture = create_fixture_with_data();
    let backup_dir = TempDir::new().unwrap();
    let password = "secure_password_456";

    let backup_path = original_fixture
        .manager
        .backup()
        .create(
            &BackupOptions::new()
                .output_dir(backup_dir.path())
                .password(password),
        )
        .unwrap();

    let new_fixture = TestFixture::with_sub_settings();

    let result = new_fixture
        .manager
        .backup()
        .restore(
            &RestoreOptions::from_path(&backup_path)
                .password(password)
                .overwrite(true),
        )
        .unwrap();

    assert!(result.restored.contains(&"settings.json".to_string()));

    new_fixture.manager.invalidate_cache();

    let metadata = new_fixture.manager.metadata().unwrap();
    let theme_value = metadata.get("ui.theme").unwrap().value.clone();
    assert_eq!(theme_value, Some(json!("light")));
}

#[test]
fn test_restore_wrong_password_fails() {
    let original_fixture = create_fixture_with_data();
    let backup_dir = TempDir::new().unwrap();

    let backup_path = original_fixture
        .manager
        .backup()
        .create(
            &BackupOptions::new()
                .output_dir(backup_dir.path())
                .password("correct_password"),
        )
        .unwrap();

    let new_fixture = TestFixture::with_sub_settings();

    let result = new_fixture.manager.backup().restore(
        &RestoreOptions::from_path(&backup_path)
            .password("wrong_password")
            .overwrite(true),
    );

    assert!(result.is_err());
}

#[test]
fn test_restore_without_password_when_encrypted_fails() {
    let original_fixture = create_fixture_with_data();
    let backup_dir = TempDir::new().unwrap();

    let backup_path = original_fixture
        .manager
        .backup()
        .create(
            &BackupOptions::new()
                .output_dir(backup_dir.path())
                .password("some_password"),
        )
        .unwrap();

    let new_fixture = TestFixture::with_sub_settings();

    let result = new_fixture
        .manager
        .backup()
        .restore(&RestoreOptions::from_path(&backup_path).overwrite(true));

    assert!(result.is_err());
}

#[test]
fn test_backup_includes_sub_settings() {
    let fixture = create_fixture_with_data();
    let backup_dir = TempDir::new().unwrap();

    let backup_path = fixture
        .manager
        .backup()
        .create(
            &BackupOptions::new()
                .output_dir(backup_dir.path())
                .include_sub_settings("remotes"),
        )
        .unwrap();

    let new_fixture = TestFixture::with_sub_settings();
    let result = new_fixture
        .manager
        .backup()
        .restore(&RestoreOptions::from_path(&backup_path).overwrite(true))
        .unwrap();

    assert!(result.restored.iter().any(|s| s.contains("remotes/gdrive")));
    assert!(result.restored.iter().any(|s| s.contains("remotes/s3")));

    let remotes = new_fixture.manager.sub_settings("remotes").unwrap();
    let gdrive = remotes.get_value("gdrive").unwrap();
    assert_eq!(gdrive["type"], "drive");

    let s3 = remotes.get_value("s3").unwrap();
    assert_eq!(s3["type"], "s3");
}

#[test]
fn test_restore_skip_existing() {
    let original_fixture = create_fixture_with_data();
    let backup_dir = TempDir::new().unwrap();

    let backup_path = original_fixture
        .manager
        .backup()
        .create(&BackupOptions::new().output_dir(backup_dir.path()))
        .unwrap();

    let new_fixture = TestFixture::new();
    let _ = new_fixture.manager.get_all().unwrap();
    new_fixture
        .manager
        .save_setting("ui", "theme", &json!("system"))
        .unwrap();

    let result = new_fixture
        .manager
        .backup()
        .restore(&RestoreOptions::from_path(&backup_path).overwrite(false))
        .unwrap();

    assert!(!result.skipped.is_empty() || result.restored.is_empty());
}

#[test]
fn test_restore_overwrite_existing() {
    let original_fixture = create_fixture_with_data();
    let backup_dir = TempDir::new().unwrap();

    let backup_path = original_fixture
        .manager
        .backup()
        .create(&BackupOptions::new().output_dir(backup_dir.path()))
        .unwrap();

    let new_fixture = TestFixture::new();
    let _ = new_fixture.manager.get_all().unwrap();
    new_fixture
        .manager
        .save_setting("ui", "theme", &json!("system"))
        .unwrap();

    new_fixture
        .manager
        .backup()
        .restore(&RestoreOptions::from_path(&backup_path).overwrite(true))
        .unwrap();

    new_fixture.manager.invalidate_cache();

    let metadata = new_fixture.manager.metadata().unwrap();
    let theme_value = metadata.get("ui.theme").unwrap().value.clone();
    assert_eq!(theme_value, Some(json!("light")));
}
