//! Backup management using rcman library
//!
//! This module provides backup and analysis commands using the rcman library.

use crate::context::AppHandle;
use crate::rclone::queries::get_rclone_config_file;
use crate::services::settings::AppSettingsManager;
use crate::utils::types::backup_types::{BackupAnalysis, BackupContentsInfo, ExportType};
use log::{error, info};
use std::path::PathBuf;

// BACKUP COMMAND

#[allow(clippy::too_many_arguments)]
pub async fn backup_settings(
    app_handle: AppHandle,
    backup_dir: String,
    export_type: ExportType,
    password: Option<String>,
    remote_name: Option<String>,
    user_note: Option<String>,
    include_profiles: Option<Vec<String>>,
    include_secrets: Option<bool>,
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
    let (secret_policy, include_rclone_config) =
        export_secrets(password.as_deref(), include_secrets.unwrap_or(false));
    let provider_state = app_handle.state::<super::rclone_config_provider::RcloneConfigProvider>();
    provider_state.replace(super::rclone_config_provider::RcloneConfigProvider::default());
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
        .export_type(rcman_export_type);

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
        if category == "remotes" && include_rclone_config {
            register_rclone_config_provider(&app_handle).await?;
            options = options.include_external("rclone.conf");
        }
        options = options.filename_suffix(category);
    }

    if matches!(export_type, ExportType::All) {
        if include_rclone_config {
            register_rclone_config_provider(&app_handle).await?;
            options = options.include_external("rclone.conf");
        }
        options = options.include_sub_settings(crate::utils::constants::SUB_REMOTES);
        options = options.include_sub_settings(crate::utils::constants::SUB_BACKEND);
        options = options.include_sub_settings(crate::utils::constants::SUB_CONNECTIONS);
        options = options.include_sub_settings(crate::utils::constants::SUB_ALERTS_RULES);
        options = options.include_sub_settings(crate::utils::constants::SUB_ALERTS_ACTIONS);
        options = options.include_sub_settings(crate::utils::constants::SUB_QUICK_RUNS);
        options = options.include_sub_settings(crate::utils::constants::SUB_WORKFLOWS);
        options = options.include_sub_settings(crate::utils::constants::SUB_TEMPLATES);
    }

    if matches!(export_type, ExportType::SpecificRemote)
        && include_rclone_config
        && let Some(ref name) = remote_name
    {
        use super::rclone_config_provider::RcloneConfigProvider;
        use crate::rclone::backend::BackendManager;
        let backend_manager = app_handle.state::<BackendManager>();

        let all_configs = backend_manager.remote_cache().await.get_configs().await;
        let remote_config = all_configs.get(name).cloned();

        let provider = RcloneConfigProvider::for_remote(name, remote_config)
            .map_err(|e| format!("Failed to serialize remote config: {e}"))?;
        provider_state.replace(provider);
        options = options.include_external(format!("remote:{name}"));
    }

    if let Some(ref pw) = password {
        let trimmed = pw.trim();
        if !trimmed.is_empty() {
            options = options.password(trimmed);
        }
    }

    options = options.secret_policy(secret_policy);

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
    provider_state.replace(super::rclone_config_provider::RcloneConfigProvider::default());
    let backup_path = result
        .map_err(|e| crate::localized_error!("backendErrors.backup.exportFailed", "error" => e.to_string()))?
        .map_err(|e| {
            error!("Backup failed: {e}");
            crate::localized_error!("backendErrors.backup.exportFailed", "error" => e.to_string())
        })?;

    info!("Backup complete: {}", backup_path.display());
    Ok(format!("Backup created at: {}", backup_path.display()))
}

/// Secrets leave the app only inside an encrypted archive: without a password the
/// managed secrets are redacted and `rclone.conf` (or a remote's rclone config) is
/// left out. Returns the secret policy and whether the rclone config is exported.
fn export_secrets(
    password: Option<&str>,
    include_secrets: bool,
) -> (rcman::SecretBackupPolicy, bool) {
    let encrypted = password.is_some();
    let policy = if encrypted && include_secrets {
        rcman::SecretBackupPolicy::EncryptedOnly
    } else {
        rcman::SecretBackupPolicy::Exclude
    };
    (policy, encrypted)
}

pub(super) async fn register_rclone_config_provider(app_handle: &AppHandle) -> Result<(), String> {
    use crate::services::settings::backup::rclone_config_provider::RcloneConfigProvider;

    let config_path = get_rclone_config_file(app_handle.clone())
        .await
        .map_err(|e| format!("Failed to fetch rclone config path: {e}"))?;

    app_handle
        .state::<RcloneConfigProvider>()
        .replace(RcloneConfigProvider::from_path(config_path));

    Ok(())
}

// BACKUP ANALYSIS

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
            let contents = BackupContentsInfo {
                settings: analysis.manifest.contents.settings,
                backend_config: analysis
                    .manifest
                    .contents
                    .sub_settings
                    .contains_key("backend"),
                rclone_config: analysis
                    .manifest
                    .contents
                    .external_configs
                    .iter()
                    .any(|id| id == "rclone.conf" || id == "rclone_config"),
                remote_count: analysis.manifest.contents.sub_settings.get("remotes").map(
                    |r| match r {
                        rcman::SubSettingsManifestEntry::MultiFile(items) => items.len(),
                        rcman::SubSettingsManifestEntry::SingleFile(_) => 1,
                        rcman::SubSettingsManifestEntry::Profiled { profiles } => profiles
                            .values()
                            .map(|entry| match entry {
                                rcman::ProfileEntry::Single(_) => 1,
                                rcman::ProfileEntry::Multiple(items) => items.len(),
                            })
                            .sum(),
                    },
                ),
                remote_names: analysis.manifest.contents.sub_settings.get("remotes").map(
                    |r| match r {
                        rcman::SubSettingsManifestEntry::MultiFile(items) => items.clone(),
                        rcman::SubSettingsManifestEntry::SingleFile(name) => vec![name.clone()],
                        rcman::SubSettingsManifestEntry::Profiled { profiles } => {
                            let mut names = Vec::new();
                            for (profile, entry) in profiles {
                                match entry {
                                    rcman::ProfileEntry::Single(item) => {
                                        names.push(format!("{profile}: {item}"));
                                    }
                                    rcman::ProfileEntry::Multiple(items) => {
                                        for item in items {
                                            names.push(format!("{profile}: {item}"));
                                        }
                                    }
                                }
                            }
                            names
                        }
                    },
                ),
                profiles: analysis
                    .manifest
                    .contents
                    .sub_settings
                    .get("remotes")
                    .and_then(|r| match r {
                        rcman::SubSettingsManifestEntry::Profiled { profiles } => {
                            Some(profiles.keys().cloned().collect())
                        }
                        _ => None,
                    }),
            };

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

    #[test]
    fn a_password_includes_secrets_and_the_rclone_config() {
        assert_eq!(
            export_secrets(Some("pass"), true),
            (rcman::SecretBackupPolicy::EncryptedOnly, true)
        );
    }

    #[test]
    fn without_a_password_secrets_and_the_rclone_config_stay_out() {
        for include_secrets in [false, true] {
            assert_eq!(
                export_secrets(None, include_secrets),
                (rcman::SecretBackupPolicy::Exclude, false)
            );
        }
    }

    #[tokio::test]
    async fn a_full_export_without_a_password_succeeds_without_the_rclone_config() {
        use crate::rclone::backend::{BackendManager, routing_transport::RoutingTransport};
        use crate::utils::types::{backup_types::ExportType, state::RcloneState};
        use std::sync::Arc;

        let directory = tempfile::tempdir().unwrap();
        let output = tempfile::tempdir().unwrap();
        let conf = directory.path().join("rclone.conf");
        std::fs::write(&conf, "[drive]\ntype = drive\ntoken = secret\n").unwrap();
        let settings =
            crate::services::settings::manager::create_settings_manager(directory.path()).unwrap();
        let provider = super::super::rclone_config_provider::RcloneConfigProvider::from_path(conf);
        settings.register_external_provider(Box::new(provider.clone()));
        let app = AppHandle::default();
        app.manage(settings);
        app.manage(provider);
        app.manage(BackendManager::new());
        app.manage(RcloneState::new(
            reqwest::Client::new(),
            Arc::new(RoutingTransport::new(app.clone())),
        ));

        let message = backup_settings(
            app.clone(),
            output.path().display().to_string(),
            ExportType::All,
            None,
            None,
            None,
            None,
            Some(true),
        )
        .await
        .unwrap();

        let path = message.trim_start_matches("Backup created at: ");
        let analysis = analyze_backup_file(app, path.into()).await.unwrap();
        assert!(!analysis.is_encrypted);
        assert!(!analysis.contents.unwrap().rclone_config);
    }

    #[test]
    fn a_password_alone_encrypts_without_adding_managed_secrets() {
        assert_eq!(
            export_secrets(Some("pass"), false),
            (rcman::SecretBackupPolicy::Exclude, true)
        );
    }
}
