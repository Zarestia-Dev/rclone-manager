use super::*;
use rcman::{BackupOptions, RestoreOptions, SettingsManager, SubSettingsConfig};
use tempfile::TempDir;

#[test]
fn test_restore_external_configs_with_sub_settings_filter() {
    let temp = TempDir::new().unwrap();
    let backup_dir = temp.path().join("backups");

    let external_source = temp.path().join("external_source.conf");
    fs::write(&external_source, "token=abc123\n").unwrap();

    let source_manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp.path().join("source"))
        .with_schema::<common::TestSettings>()
        .with_sub_settings(SubSettingsConfig::new("remotes"))
        .with_external_config(ExternalConfig::new("external_cfg", &external_source))
        .build()
        .unwrap();

    source_manager
        .sub_settings("remotes")
        .unwrap()
        .set("gdrive", &json!({"type": "drive"}))
        .unwrap();

    let backup_path = source_manager
        .backup()
        .create(
            &BackupOptions::new()
                .output_dir(&backup_dir)
                .include_sub_settings("remotes")
                .include_external("external_cfg"),
        )
        .unwrap();

    let restore_target = temp.path().join("restored").join("external_target.conf");

    let restore_manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp.path().join("restore"))
        .with_schema::<common::TestSettings>()
        .with_sub_settings(SubSettingsConfig::new("remotes"))
        .with_external_config(ExternalConfig::new("external_cfg", &restore_target))
        .build()
        .unwrap();

    let result = restore_manager
        .backup()
        .restore(
            &RestoreOptions::from_path(&backup_path)
                .overwrite(true)
                .restore_sub_settings("remotes"),
        )
        .unwrap();

    assert!(result.restored.iter().any(|s| s == "external_cfg"));
    assert!(restore_target.exists());
    assert_eq!(
        fs::read_to_string(&restore_target).unwrap(),
        "token=abc123\n"
    );
}

#[test]
fn test_full_backup_auto_includes_registered_external_configs() {
    let temp = TempDir::new().unwrap();
    let backup_dir = temp.path().join("backups");

    let external_source = temp.path().join("external_auto_include.conf");
    fs::write(&external_source, "mode=auto\n").unwrap();

    let source_manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp.path().join("source_full"))
        .with_schema::<common::TestSettings>()
        .with_external_config(ExternalConfig::new("external_auto", &external_source))
        .build()
        .unwrap();

    let backup_path = source_manager
        .backup()
        .create(&BackupOptions::new().output_dir(&backup_dir))
        .unwrap();

    let restore_target = temp.path().join("restored_full").join("external_auto.conf");

    let restore_manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp.path().join("restore_full"))
        .with_schema::<common::TestSettings>()
        .with_external_config(ExternalConfig::new("external_auto", &restore_target))
        .build()
        .unwrap();

    let result = restore_manager
        .backup()
        .restore(&RestoreOptions::from_path(&backup_path).overwrite(true))
        .unwrap();

    assert!(result.restored.iter().any(|s| s == "external_auto"));
    assert!(restore_target.exists());
    assert_eq!(fs::read_to_string(&restore_target).unwrap(), "mode=auto\n");
}

#[test]
fn test_full_backup_with_explicit_external_list_filters_registered_configs() {
    let temp = TempDir::new().unwrap();
    let backup_dir = temp.path().join("backups");

    let external_a_source = temp.path().join("external_a.conf");
    let external_b_source = temp.path().join("external_b.conf");
    fs::write(&external_a_source, "source=A\n").unwrap();
    fs::write(&external_b_source, "source=B\n").unwrap();

    let source_manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp.path().join("source_full_filter"))
        .with_schema::<common::TestSettings>()
        .with_external_config(ExternalConfig::new("external_a", &external_a_source))
        .with_external_config(ExternalConfig::new("external_b", &external_b_source))
        .build()
        .unwrap();

    let backup_path = source_manager
        .backup()
        .create(
            &BackupOptions::new()
                .output_dir(&backup_dir)
                .include_external("external_a"),
        )
        .unwrap();

    let external_a_target = temp
        .path()
        .join("restore_full_filter")
        .join("external_a.conf");
    let external_b_target = temp
        .path()
        .join("restore_full_filter")
        .join("external_b.conf");

    let restore_manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp.path().join("restore_full_filter_cfg"))
        .with_schema::<common::TestSettings>()
        .with_external_config(ExternalConfig::new("external_a", &external_a_target))
        .with_external_config(ExternalConfig::new("external_b", &external_b_target))
        .build()
        .unwrap();

    let result = restore_manager
        .backup()
        .restore(&RestoreOptions::from_path(&backup_path).overwrite(true))
        .unwrap();

    assert!(result.restored.iter().any(|s| s == "external_a"));
    assert!(!result.restored.iter().any(|s| s == "external_b"));
    assert!(external_a_target.exists());
    assert_eq!(
        fs::read_to_string(&external_a_target).unwrap(),
        "source=A\n"
    );
    assert!(!external_b_target.exists());
}

#[test]
fn test_full_backup_with_explicit_external_list_filters_provider_configs() {
    let temp = TempDir::new().unwrap();
    let backup_dir = temp.path().join("backups");

    let source_manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp.path().join("provider_source_cfg"))
        .with_schema::<common::TestSettings>()
        .build()
        .unwrap();

    source_manager
        .backup()
        .register_external_provider(Box::new(TestExternalProvider {
            configs: vec![
                ExternalConfig::from_content(
                    "provider_a",
                    "provider_a.conf",
                    b"provider=A\n".to_vec(),
                ),
                ExternalConfig::from_content(
                    "provider_b",
                    "provider_b.conf",
                    b"provider=B\n".to_vec(),
                ),
            ],
        }));

    let backup_path = source_manager
        .backup()
        .create(
            &BackupOptions::new()
                .output_dir(&backup_dir)
                .include_external("provider_a"),
        )
        .unwrap();

    let analysis = source_manager.backup().analyze(&backup_path).unwrap();
    assert_eq!(analysis.manifest.contents.external_configs.len(), 1);
    assert!(
        analysis
            .manifest
            .contents
            .external_configs
            .iter()
            .any(|id| id == "provider_a")
    );

    let provider_a_target = temp.path().join("provider_restore").join("provider_a.conf");
    let provider_b_target = temp.path().join("provider_restore").join("provider_b.conf");

    let restore_manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp.path().join("provider_restore_cfg"))
        .with_schema::<common::TestSettings>()
        .build()
        .unwrap();

    restore_manager
        .backup()
        .register_external_provider(Box::new(TestExternalProvider {
            configs: vec![
                ExternalConfig::from_content("provider_a", "provider_a.conf", Vec::new())
                    .import_file(&provider_a_target),
                ExternalConfig::from_content("provider_b", "provider_b.conf", Vec::new())
                    .import_file(&provider_b_target),
            ],
        }));

    let result = restore_manager
        .backup()
        .restore(&RestoreOptions::from_path(&backup_path).overwrite(true))
        .unwrap();

    assert!(result.restored.iter().any(|s| s == "provider_a"));
    assert!(!result.restored.iter().any(|s| s == "provider_b"));
    assert!(provider_a_target.exists());
    assert_eq!(
        fs::read_to_string(&provider_a_target).unwrap(),
        "provider=A\n"
    );
    assert!(!provider_b_target.exists());
}

#[test]
fn test_full_backup_auto_includes_provider_configs_when_external_list_empty() {
    let temp = TempDir::new().unwrap();
    let backup_dir = temp.path().join("backups");

    let source_manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp.path().join("provider_auto_source_cfg"))
        .with_schema::<common::TestSettings>()
        .build()
        .unwrap();

    source_manager
        .backup()
        .register_external_provider(Box::new(TestExternalProvider {
            configs: vec![
                ExternalConfig::from_content(
                    "provider_a",
                    "provider_a.conf",
                    b"provider=A\n".to_vec(),
                ),
                ExternalConfig::from_content(
                    "provider_b",
                    "provider_b.conf",
                    b"provider=B\n".to_vec(),
                ),
            ],
        }));

    let backup_path = source_manager
        .backup()
        .create(&BackupOptions::new().output_dir(&backup_dir))
        .unwrap();

    let analysis = source_manager.backup().analyze(&backup_path).unwrap();
    assert_eq!(analysis.manifest.contents.external_configs.len(), 2);
    assert!(
        analysis
            .manifest
            .contents
            .external_configs
            .iter()
            .any(|id| id == "provider_a")
    );
    assert!(
        analysis
            .manifest
            .contents
            .external_configs
            .iter()
            .any(|id| id == "provider_b")
    );

    let provider_a_target = temp
        .path()
        .join("provider_auto_restore")
        .join("provider_a.conf");
    let provider_b_target = temp
        .path()
        .join("provider_auto_restore")
        .join("provider_b.conf");

    let restore_manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp.path().join("provider_auto_restore_cfg"))
        .with_schema::<common::TestSettings>()
        .build()
        .unwrap();

    restore_manager
        .backup()
        .register_external_provider(Box::new(TestExternalProvider {
            configs: vec![
                ExternalConfig::from_content("provider_a", "provider_a.conf", Vec::new())
                    .import_file(&provider_a_target),
                ExternalConfig::from_content("provider_b", "provider_b.conf", Vec::new())
                    .import_file(&provider_b_target),
            ],
        }));

    let result = restore_manager
        .backup()
        .restore(&RestoreOptions::from_path(&backup_path).overwrite(true))
        .unwrap();

    assert!(result.restored.iter().any(|s| s == "provider_a"));
    assert!(result.restored.iter().any(|s| s == "provider_b"));
    assert!(provider_a_target.exists());
    assert!(provider_b_target.exists());
    assert_eq!(
        fs::read_to_string(&provider_a_target).unwrap(),
        "provider=A\n"
    );
    assert_eq!(
        fs::read_to_string(&provider_b_target).unwrap(),
        "provider=B\n"
    );
}

#[test]
fn test_full_backup_deduplicates_duplicate_external_ids_static_first() {
    let temp = TempDir::new().unwrap();
    let backup_dir = temp.path().join("backups");

    let static_source = temp.path().join("dup_static.conf");
    fs::write(&static_source, "source=static\n").unwrap();

    let source_manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp.path().join("dup_source_cfg"))
        .with_schema::<common::TestSettings>()
        .with_external_config(ExternalConfig::new("dup_id", &static_source))
        .build()
        .unwrap();

    source_manager
        .backup()
        .register_external_provider(Box::new(TestExternalProvider {
            configs: vec![ExternalConfig::from_content(
                "dup_id",
                "dup_provider.conf",
                b"source=provider\n".to_vec(),
            )],
        }));

    let backup_path = source_manager
        .backup()
        .create(&BackupOptions::new().output_dir(&backup_dir))
        .unwrap();

    let analysis = source_manager.backup().analyze(&backup_path).unwrap();
    assert_eq!(analysis.manifest.contents.external_configs.len(), 1);
    assert_eq!(analysis.manifest.contents.external_configs[0], "dup_id");
    assert_eq!(
        analysis
            .manifest
            .contents
            .external_config_files
            .get("dup_id")
            .map(String::as_str),
        Some("dup_static.conf")
    );

    let restore_target = temp.path().join("dup_restore").join("dup_target.conf");

    let restore_manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp.path().join("dup_restore_cfg"))
        .with_schema::<common::TestSettings>()
        .with_external_config(ExternalConfig::new("dup_id", &restore_target))
        .build()
        .unwrap();

    let result = restore_manager
        .backup()
        .restore(&RestoreOptions::from_path(&backup_path).overwrite(true))
        .unwrap();

    assert_eq!(
        result
            .restored
            .iter()
            .filter(|id| id.as_str() == "dup_id")
            .count(),
        1
    );
    assert!(restore_target.exists());
    assert_eq!(
        fs::read_to_string(&restore_target).unwrap(),
        "source=static\n"
    );
}

#[test]
fn test_restore_external_unknown_config_reports_pending_reason() {
    let temp = TempDir::new().unwrap();
    let backup_dir = temp.path().join("backups");

    let source_manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp.path().join("unknown_source_cfg"))
        .with_schema::<common::TestSettings>()
        .with_external_config(ExternalConfig::from_content(
            "unknown_external",
            "unknown_external.conf",
            b"token=xyz\n".to_vec(),
        ))
        .build()
        .unwrap();

    let backup_path = source_manager
        .backup()
        .create(
            &BackupOptions::new()
                .output_dir(&backup_dir)
                .include_external("unknown_external"),
        )
        .unwrap();

    let restore_manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp.path().join("unknown_restore_cfg"))
        .with_schema::<common::TestSettings>()
        .build()
        .unwrap();

    let result = restore_manager
        .backup()
        .restore(&RestoreOptions::from_path(&backup_path).overwrite(true))
        .unwrap();

    assert!(
        result
            .pending_details
            .iter()
            .any(|item| item.id == "unknown_external"
                && item.reason == rcman::RestorePendingReason::UnknownExternalConfig)
    );
    assert!(
        result
            .external_pending
            .iter()
            .any(|id| id == "unknown_external")
    );
}

#[test]
fn test_restore_external_exists_conflict_reports_skip_reason() {
    let temp = TempDir::new().unwrap();
    let backup_dir = temp.path().join("backups");

    let external_source = temp.path().join("exists_conflict_source.conf");
    fs::write(&external_source, "source=backup\n").unwrap();

    let source_manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp.path().join("exists_source_cfg"))
        .with_schema::<common::TestSettings>()
        .with_external_config(ExternalConfig::new("external_exists", &external_source))
        .build()
        .unwrap();

    let backup_path = source_manager
        .backup()
        .create(
            &BackupOptions::new()
                .output_dir(&backup_dir)
                .include_external("external_exists"),
        )
        .unwrap();

    let restore_target = temp
        .path()
        .join("exists_restore")
        .join("external_exists.conf");
    fs::create_dir_all(restore_target.parent().unwrap()).unwrap();
    fs::write(&restore_target, "source=local\n").unwrap();

    let restore_manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp.path().join("exists_restore_cfg"))
        .with_schema::<common::TestSettings>()
        .with_external_config(ExternalConfig::new("external_exists", &restore_target))
        .build()
        .unwrap();

    let result = restore_manager
        .backup()
        .restore(&RestoreOptions::from_path(&backup_path).overwrite(false))
        .unwrap();

    assert!(
        result
            .skipped_details
            .iter()
            .any(|item| item.id == "external_exists"
                && item.reason == rcman::RestoreSkipReason::ExistsConflict)
    );
    assert!(result.skipped.iter().any(|id| id == "external_exists"));
    assert_eq!(
        fs::read_to_string(&restore_target).unwrap(),
        "source=local\n"
    );
}

#[test]
fn test_get_external_config_from_backup_by_id() {
    let temp = TempDir::new().unwrap();
    let backup_dir = temp.path().join("backups");

    let external_source = temp.path().join("custom-archive-name.txt");
    fs::write(&external_source, "sample external content").unwrap();

    let manager = SettingsManager::builder("test-app", "1.0.0")
        .with_config_dir(temp.path().join("config"))
        .with_schema::<common::TestSettings>()
        .with_external_config(ExternalConfig::new("ext_config_id", &external_source))
        .build()
        .unwrap();

    let backup_path = manager
        .backup()
        .create(
            &BackupOptions::new()
                .output_dir(&backup_dir)
                .include_external("ext_config_id"),
        )
        .unwrap();

    let data = manager
        .backup()
        .get_external_config_from_backup(&backup_path, "ext_config_id", None)
        .unwrap();

    assert_eq!(data, b"sample external content");
}
