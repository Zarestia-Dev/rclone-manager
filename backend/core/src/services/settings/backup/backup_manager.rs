//! Backup management using rcman library
//!
//! This module provides backup and analysis commands using the rcman library.

use super::rclone_externals::{is_rclone_conf_id, rclone_conf, remote_definition, remote_name};
use crate::context::AppHandle;
use crate::rclone::queries::get_rclone_config_file;
use crate::services::settings::AppSettingsManager;
use crate::utils::types::backup_types::{BackupAnalysis, BackupContentsInfo, ExportType};
use log::{error, info};
use std::path::PathBuf;

// BACKUP COMMAND

pub async fn backup_settings(
    app_handle: AppHandle,
    backup_dir: String,
    export_type: ExportType,
    password: Option<String>,
    remote_name: Option<String>,
    user_note: Option<String>,
    include_profiles: Option<Vec<String>>,
) -> Result<String, String> {
    let state = app_handle.state::<crate::utils::types::state::RcloneState>();
    let _operation = state.vault_operation_lock.lock().await;
    let manager = app_handle.state::<AppSettingsManager>();
    if manager.is_locked() {
        return Err(
            crate::localized_error!("backendErrors.vault.operationFailed", "error" => rcman::Error::ConfigLocked),
        );
    }
    let password = password
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    // Secrets leave the app only inside an encrypted archive. Without a password
    // rcman redacts managed secrets and drops sensitive externals, so the rclone
    // config and remote definitions are not even read.
    let encrypted = password.is_some();
    info!("Starting backup with rcman to: {backup_dir}");

    // Map app's ExportType to rcman's ExportType
    let rcman_export_type = match &export_type {
        ExportType::All => rcman::ExportType::Full,
        ExportType::Settings => rcman::ExportType::SettingsOnly,
        ExportType::SpecificRemote => rcman::ExportType::Single {
            settings_type: "remotes".into(),
            name: remote_name.clone().unwrap_or_default(),
        },
        ExportType::Category(_) => rcman::ExportType::SettingsOnly,
    };

    // Build rcman backup options
    let mut options = rcman::BackupOptions::new()
        .output_dir(&backup_dir)
        .export_type(rcman_export_type)
        .secret_policy(if encrypted {
            rcman::SecretBackupPolicy::EncryptedOnly
        } else {
            rcman::SecretBackupPolicy::Exclude
        });

    if matches!(
        export_type,
        ExportType::Category(_) | ExportType::SpecificRemote
    ) {
        options = options.include_settings(false);
    }

    if let ExportType::Category(ref category) = export_type {
        if category == "alerts" {
            options = options.include_sub_settings(crate::utils::constants::SUB_ALERTS_RULES);
            options = options.include_sub_settings(crate::utils::constants::SUB_ALERTS_ACTIONS);
        } else {
            options = options.include_sub_settings(category);
        }
        if category == "remotes" && encrypted {
            options = options.external(rclone_conf(rclone_config_path(&app_handle).await?));
        }
        options = options.filename_suffix(category);
    }

    // A full export names no sub-settings, so rcman includes every registered one
    // and a new store cannot be forgotten here.
    if matches!(export_type, ExportType::All) && encrypted {
        options = options.external(rclone_conf(rclone_config_path(&app_handle).await?));
    }

    if matches!(export_type, ExportType::SpecificRemote)
        && encrypted
        && let Some(ref name) = remote_name
    {
        use crate::rclone::backend::BackendManager;
        let backend_manager = app_handle.state::<BackendManager>();

        let all_configs = backend_manager.remote_cache().await.get_configs().await;
        if let Some(remote_config) = all_configs.get(name) {
            options = options.external(remote_definition(name, remote_config).map_err(
                |e| crate::localized_error!("backendErrors.backup.exportFailed", "error" => e.to_string()),
            )?);
        }
    }

    if let Some(ref pw) = password {
        options = options.password(pw);
    }

    if let Some(note) = user_note {
        options = options.note(note);
    }

    if let Some(profiles) = include_profiles {
        for profile in profiles {
            options = options.include_profile(profile);
        }
    }

    let worker_app = app_handle.clone();
    let result = crate::utils::spawn_blocking(move || {
        worker_app
            .state::<AppSettingsManager>()
            .backup()
            .create(&options)
    })
    .await;
    let backup_path = result
        .map_err(|e| crate::localized_error!("backendErrors.backup.exportFailed", "error" => e.to_string()))?
        .map_err(|e| {
            error!("Backup failed: {e}");
            crate::localized_error!("backendErrors.backup.exportFailed", "error" => e.to_string())
        })?;

    info!("Backup complete: {}", backup_path.display());
    Ok(crate::localized_success!(
        "backendSuccess.backup.created",
        "path" => backup_path.display()
    ))
}

pub(super) async fn rclone_config_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    get_rclone_config_file(app_handle.clone())
        .await
        .map_err(|e| crate::localized_error!("backendErrors.backup.exportFailed", "error" => e))
}

// BACKUP ANALYSIS

/// What the restore dialog shows for an archive's manifest.
fn describe_contents(contents: &rcman::backup::BackupContents) -> BackupContentsInfo {
    let has_external =
        |matches: fn(&str) -> bool| contents.external_configs.iter().any(|id| matches(id));
    let remotes = contents.sub_settings.get("remotes");
    BackupContentsInfo {
        settings: contents.settings,
        backend_config: contents.sub_settings.contains_key("backend"),
        rclone_config: has_external(is_rclone_conf_id),
        remote_definitions: has_external(|id| is_rclone_conf_id(id) || remote_name(id).is_some()),
        remote_count: remotes.map(|entry| entry.items().len()),
        remote_names: remotes.map(|entry| {
            entry
                .items()
                .into_iter()
                .map(|(profile, item)| match profile {
                    Some(profile) => format!("{profile}: {item}"),
                    None => item.to_owned(),
                })
                .collect()
        }),
        profiles: remotes
            .and_then(rcman::SubSettingsManifestEntry::profile_names)
            .map(|names| names.into_iter().map(str::to_owned).collect()),
    }
}

pub async fn analyze_backup_file(
    app_handle: AppHandle,
    path: PathBuf,
) -> Result<BackupAnalysis, String> {
    let manager = app_handle.state::<AppSettingsManager>();
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext != "rcman" {
        return Err(crate::localized_error!(
            "backendErrors.backup.unsupportedArchive"
        ));
    }

    match manager.backup().analyze(&path) {
        Ok(analysis) => {
            let contents = describe_contents(&analysis.manifest.contents);

            Ok(BackupAnalysis {
                is_encrypted: analysis.is_encrypted,
                archive_type: if analysis.requires_password {
                    "zip-aes".into()
                } else {
                    "zip".into()
                },
                format_version: analysis.format_version,
                created_at: Some(analysis.created_at),
                backup_type: Some(analysis.backup_type),
                user_note: analysis.user_note,
                contents: Some(contents),
            })
        }
        Err(e) => Err(crate::localized_error!(
            "backendErrors.backup.invalidArchive",
            "error" => e
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::constants::{
        SUB_ALERTS_ACTIONS, SUB_ALERTS_RULES, SUB_BACKEND, SUB_CONNECTIONS, SUB_QUICK_RUNS,
        SUB_REMOTES, SUB_TEMPLATES, SUB_WORKFLOWS,
    };
    use rcman::SubSettingsManifestEntry::{MultiFile, Profiled, SingleFile};

    fn created_backup_path(message: &str) -> String {
        let message: serde_json::Value = serde_json::from_str(message).unwrap();
        assert_eq!(message["key"], "backendSuccess.backup.created");
        message["params"]["path"].as_str().unwrap().to_owned()
    }

    fn app_with_settings(directory: &std::path::Path) -> AppHandle {
        use crate::rclone::backend::{BackendManager, routing_transport::RoutingTransport};
        use crate::utils::types::state::RcloneState;
        use std::sync::Arc;

        let app = AppHandle::default();
        app.manage(crate::services::settings::manager::create_settings_manager(directory).unwrap());
        app.manage(BackendManager::new());
        app.manage(RcloneState::new(
            reqwest::Client::new(),
            Arc::new(RoutingTransport::new(app.clone())),
        ));
        app
    }

    // Exports in one process share the credential namespace, so concurrent tests
    // would conflict; this single export checks everything a password-less full export holds.
    #[tokio::test]
    async fn a_full_export_without_a_password_holds_every_store_but_no_rclone_config() {
        let directory = tempfile::tempdir().unwrap();
        let output = tempfile::tempdir().unwrap();
        let app = app_with_settings(directory.path());
        let manager = app.state::<AppSettingsManager>();
        let stores = [
            SUB_REMOTES,
            SUB_BACKEND,
            SUB_CONNECTIONS,
            SUB_ALERTS_RULES,
            SUB_ALERTS_ACTIONS,
            SUB_QUICK_RUNS,
            SUB_WORKFLOWS,
            SUB_TEMPLATES,
        ];
        for store in stores {
            manager
                .sub_settings(store)
                .unwrap()
                .set("entry", &serde_json::json!({}))
                .unwrap();
        }

        let message = backup_settings(
            app.clone(),
            output.path().display().to_string(),
            ExportType::All,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let path = created_backup_path(&message);

        let analysis = analyze_backup_file(app.clone(), path.clone().into())
            .await
            .unwrap();
        assert!(!analysis.is_encrypted);
        let contents = analysis.contents.unwrap();
        assert!(!contents.rclone_config);
        assert!(!contents.remote_definitions);

        // A full export names no sub-settings, so a newly registered store is never forgotten.
        let manifest = manager
            .backup()
            .analyze(std::path::Path::new(&path))
            .unwrap();
        let mut exported: Vec<_> = manifest
            .manifest
            .contents
            .sub_settings
            .keys()
            .cloned()
            .collect();
        exported.sort();
        let mut expected: Vec<_> = stores.iter().map(|store| (*store).to_owned()).collect();
        expected.sort();
        assert_eq!(exported, expected);
    }

    #[test]
    fn contents_list_remotes_with_their_profiles() {
        let mut contents = rcman::backup::BackupContents {
            settings: true,
            external_configs: vec!["rclone.conf".into()],
            ..Default::default()
        };
        contents.sub_settings.insert(
            "remotes".into(),
            Profiled {
                profiles: [
                    (
                        "default".to_string(),
                        rcman::ProfileEntry::Multiple(vec!["dropbox".into(), "drive".into()]),
                    ),
                    ("work".to_string(), rcman::ProfileEntry::Single("s3".into())),
                ]
                .into(),
            },
        );
        contents
            .sub_settings
            .insert("backend".into(), SingleFile("backend".into()));

        let info = describe_contents(&contents);
        assert!(info.settings && info.backend_config);
        assert!(info.rclone_config && info.remote_definitions);
        assert_eq!(info.remote_count, Some(3));
        assert_eq!(
            info.remote_names.unwrap(),
            ["default: drive", "default: dropbox", "work: s3"]
        );
        assert_eq!(info.profiles.unwrap(), ["default", "work"]);
    }

    #[test]
    fn flat_remotes_have_no_profiles_and_a_single_remote_export_has_definitions() {
        let mut contents = rcman::backup::BackupContents {
            external_configs: vec!["remote:drive".into()],
            ..Default::default()
        };
        contents.sub_settings.insert(
            "remotes".into(),
            MultiFile(vec!["drive".into(), "s3".into()]),
        );

        let info = describe_contents(&contents);
        assert!(!info.rclone_config);
        assert!(info.remote_definitions);
        assert_eq!(info.remote_count, Some(2));
        assert_eq!(info.remote_names.unwrap(), ["drive", "s3"]);
        assert!(info.profiles.is_none());
    }

    #[test]
    fn a_backup_without_remote_settings_reports_none() {
        let info = describe_contents(&rcman::backup::BackupContents::default());
        assert!(!info.settings && !info.backend_config);
        assert!(!info.rclone_config && !info.remote_definitions);
        assert!(info.remote_count.is_none() && info.remote_names.is_none());
        assert!(info.profiles.is_none());
    }
}
