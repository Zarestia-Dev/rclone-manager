use super::*;
use rcman::BackupOptions;
use tempfile::TempDir;

#[test]
fn test_create_unencrypted_backup() {
    let fixture = create_fixture_with_data();
    let backup_dir = TempDir::new().unwrap();

    let backup_path = fixture
        .manager
        .backup()
        .create(&BackupOptions::new().output_dir(backup_dir.path()))
        .unwrap();

    assert!(backup_path.exists());
    assert_eq!(backup_path.extension().unwrap(), "rcman");

    let analysis = fixture.manager.backup().analyze(&backup_path).unwrap();
    assert!(!analysis.requires_password);
    assert!(analysis.is_valid);
}

#[test]
fn test_create_encrypted_backup() {
    let fixture = create_fixture_with_data();
    let backup_dir = TempDir::new().unwrap();

    let backup_path = fixture
        .manager
        .backup()
        .create(
            &BackupOptions::new()
                .output_dir(backup_dir.path())
                .password("test_password_123"),
        )
        .unwrap();

    assert!(backup_path.exists());

    let analysis = fixture.manager.backup().analyze(&backup_path).unwrap();
    assert!(analysis.requires_password);
    assert!(analysis.is_valid);
}

#[test]
fn test_create_backup_with_note() {
    let fixture = create_fixture_with_data();
    let backup_dir = TempDir::new().unwrap();

    let backup_path = fixture
        .manager
        .backup()
        .create(
            &BackupOptions::new()
                .output_dir(backup_dir.path())
                .note("Weekly backup before update"),
        )
        .unwrap();

    let analysis = fixture.manager.backup().analyze(&backup_path).unwrap();
    assert_eq!(
        analysis.manifest.backup.user_note,
        Some("Weekly backup before update".to_string())
    );
}

#[test]
fn test_analyze_backup_contents() {
    let fixture = create_fixture_with_data();
    let backup_dir = TempDir::new().unwrap();

    let backup_path = fixture
        .manager
        .backup()
        .create(&BackupOptions::new().output_dir(backup_dir.path()))
        .unwrap();

    let analysis = fixture.manager.backup().analyze(&backup_path).unwrap();

    assert_eq!(analysis.manifest.backup.app_name, "test-app");
    assert_eq!(analysis.manifest.backup.app_version, "1.0.0");
    assert!(analysis.is_valid);
    assert!(analysis.warnings.is_empty());
    assert!(analysis.manifest.contents.settings);
}

#[test]
fn test_analyze_encrypted_backup() {
    let fixture = create_fixture_with_data();
    let backup_dir = TempDir::new().unwrap();

    let backup_path = fixture
        .manager
        .backup()
        .create(
            &BackupOptions::new()
                .output_dir(backup_dir.path())
                .password("secret123"),
        )
        .unwrap();

    let analysis = fixture.manager.backup().analyze(&backup_path).unwrap();

    assert!(analysis.requires_password);
    assert_eq!(analysis.manifest.backup.app_name, "test-app");
}
