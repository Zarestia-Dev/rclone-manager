//! Restore managed settings first, then reconcile opaque rclone imports and runtime state.

use super::rclone_externals::{
    deferred_remote, is_rclone_conf_id, rclone_conf_targets, remote_name,
};
use crate::context::AppHandle;
use crate::rclone::commands::remote::{create_remote, update_remote};
use crate::services::settings::AppSettingsManager;
use log::{debug, info};
use serde_json::{Value, json};
use std::collections::HashMap;

pub async fn restore_settings(
    app: AppHandle,
    backup_path: std::path::PathBuf,
    password: Option<String>,
    restore_profile: Option<String>,
) -> Result<String, String> {
    let state = app.state::<crate::utils::types::state::RcloneState>();
    let _operation = state.vault_operation_lock.lock().await;
    let manager = app.state::<AppSettingsManager>();
    if manager.is_locked() {
        return Err(
            crate::localized_error!("backendErrors.vault.operationFailed", "error" => rcman::Error::ConfigLocked),
        );
    }
    let mut options = rcman::RestoreOptions::from_path(&backup_path)
        .restore_settings(true)
        .overwrite(true)
        .verify_checksum(true);
    options.password = password
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    options.restore_profile = restore_profile;

    // Resolve the target before restoring settings that can change backend selection.
    let analysis = manager.backup().analyze(&backup_path).map_err(
        |e| crate::localized_error!("backendErrors.backup.restoreFailed", "error" => e.to_string()),
    )?;
    let external_ids = &analysis.manifest.contents.external_configs;
    let mut config_path = None;
    if external_ids.iter().any(|id| is_rclone_conf_id(id)) {
        let path = crate::rclone::queries::get_rclone_config_file(app.clone()).await?;
        for config in rclone_conf_targets(path.clone()) {
            options = options.external(config);
        }
        config_path = Some(path);
    }
    // Remote definitions go through rclone's async API after the restore.
    for id in external_ids.iter().filter(|id| remote_name(id).is_some()) {
        options = options.external(deferred_remote(id));
    }

    let worker_app = app.clone();
    let worker_options = options.clone();
    let restored = crate::utils::spawn_blocking(move || {
        worker_app
            .state::<AppSettingsManager>()
            .backup()
            .restore(&worker_options)
    })
    .await
    .map_err(|e| restore_failed(&e))
    .and_then(|result| result.map_err(|e| restore_error(&e)));

    let outcome = match restored {
        Ok(result) => {
            // Reload the active rclone config after the single rcman file replacement.
            let reload = if let Some(path) = config_path {
                state.transport.rpc(crate::rclone::endpoints::config::SETPATH, Some(&json!({ "path": path }))).await.map(|_| ())
                    .map_err(|error| crate::localized_error!("backendErrors.backup.restoreIncomplete", "error" => error.to_string()))
            } else {
                Ok(())
            };
            match reload {
                Ok(()) => import_deferred_remotes(&app, result).await,
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    };
    // Even an error can follow a managed commit or an incomplete rollback.
    let refresh = crate::services::initialization::refresh_system(app.clone()).await;
    crate::services::settings::vault::emit_vault_state(&app, "restored");
    match (outcome, refresh) {
        (Ok(message), Ok(())) => Ok(message),
        (Err(error), Ok(())) => Err(error),
        (outcome, Err(error)) => Err(crate::localized_error!(
            "backendErrors.backup.refreshFailed", "error" => error,
            "restoreError" => outcome.err().unwrap_or_default()
        )),
    }
}

fn restore_failed(error: &dyn std::fmt::Display) -> String {
    crate::localized_error!("backendErrors.backup.restoreFailed", "error" => error.to_string())
}

/// The password cases get their own message so the restore dialog can show them
/// next to the password field.
fn restore_error(error: &rcman::Error) -> String {
    match error {
        rcman::Error::InvalidPassword => {
            crate::localized_error!("backendErrors.backup.wrongPassword")
        }
        rcman::Error::PasswordRequired => {
            crate::localized_error!("backendErrors.backup.passwordRequired")
        }
        other => restore_failed(other),
    }
}

/// The remote a deferred definition belongs to, and its config.
fn parse_deferred_remote(
    item: &rcman::backup::DeferredImport,
) -> Result<(&str, serde_json::Value), String> {
    let name = remote_name(&item.id).ok_or_else(|| item.id.clone())?;
    let config = serde_json::from_slice(&item.data).map_err(|e| e.to_string())?;
    Ok((name, config))
}

async fn import_deferred_remotes(
    app: &AppHandle,
    result: rcman::RestoreResult,
) -> Result<String, String> {
    let mut imported = 0;
    let mut errors = Vec::new();
    for item in &result.deferred {
        let imported_remote = match parse_deferred_remote(item) {
            Ok((name, config)) => upsert_remote_from_config(name, config, app).await,
            Err(error) => Err(error),
        };
        match imported_remote {
            Ok(()) => imported += 1,
            Err(error) => errors.push(format!("{}: {error}", item.id)),
        }
    }
    errors.extend(result.external_pending.iter().cloned());
    if !errors.is_empty() {
        return Err(
            crate::localized_error!("backendErrors.backup.restoreIncomplete", "error" => errors.join("; ")),
        );
    }
    let restored = result.restored.len() + imported;
    info!("Restore complete: {restored} items restored");
    Ok(crate::localized_success!(
        "backendSuccess.backup.restored",
        "count" => restored
    ))
}

pub(super) async fn upsert_remote_from_config(
    remote_name: &str,
    mut config: serde_json::Value,
    app_handle: &AppHandle,
) -> Result<(), String> {
    if let Some(nested) = config.get(remote_name) {
        config = nested.clone();
    }

    let config_map: HashMap<String, Value> =
        serde_json::from_value(config).map_err(|e| e.to_string())?;

    info!("Upserting remote '{remote_name}'...");

    // The backup already holds the whole remote. With `nonInteractive` rclone stores it as it is
    // and stops at its first question, which is not answered. Without it rclone answers its own
    // questions: for OneDrive that picks the first drive of the account in place of the saved one,
    // and it never returns while the saved token is rejected.
    let opt = Some(json!({ "nonInteractive": true }));

    let Err(e) = update_remote(
        app_handle.clone(),
        remote_name.to_string(),
        config_map.clone(),
        opt.clone(),
        None,
    )
    .await
    else {
        return Ok(());
    };
    debug!("Update failed (likely remote doesn't exist), attempting create: {e}");
    // Without a type there is nothing to create; the update error says why.
    let Some(rclone_type) = config_map.get("type").and_then(Value::as_str) else {
        return Err(e);
    };
    create_remote(
        app_handle.clone(),
        remote_name.to_string(),
        rclone_type.to_string(),
        config_map,
        opt,
        None,
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rcman::backup::DeferredImport;

    fn deferred(id: &str, data: &[u8]) -> DeferredImport {
        DeferredImport {
            id: id.into(),
            data: data.to_vec(),
        }
    }

    #[test]
    fn password_failures_have_their_own_messages() {
        assert_eq!(
            restore_error(&rcman::Error::InvalidPassword),
            "backendErrors.backup.wrongPassword"
        );
        assert_eq!(
            restore_error(&rcman::Error::PasswordRequired),
            "backendErrors.backup.passwordRequired"
        );
        let other = restore_error(&rcman::Error::InvalidBackup("bad".into()));
        let other: serde_json::Value = serde_json::from_str(&other).unwrap();
        assert_eq!(other["key"], "backendErrors.backup.restoreFailed");
        assert!(other["params"]["error"].as_str().unwrap().contains("bad"));
    }

    #[test]
    fn a_deferred_remote_yields_its_name_and_config() {
        let item = deferred("remote:drive", br#"{"drive":{"type":"drive"}}"#);
        let (name, config) = parse_deferred_remote(&item).unwrap();
        assert_eq!(name, "drive");
        assert_eq!(config["drive"]["type"], "drive");
    }

    #[test]
    fn malformed_or_foreign_deferred_items_are_errors() {
        assert!(parse_deferred_remote(&deferred("remote:drive", b"not json")).is_err());
        assert_eq!(
            parse_deferred_remote(&deferred("rclone.conf", b"{}")).unwrap_err(),
            "rclone.conf"
        );
    }

    type Calls = std::sync::Arc<std::sync::Mutex<Vec<(String, Value)>>>;

    /// A stand-in for rclone's daemon: answers every call and records the path and body of each.
    /// `config/update` is refused with "no such remote" when `missing_remote` is set.
    async fn fake_rclone(missing_remote: bool) -> (u16, Calls, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let calls: Calls = Default::default();
        let recorded = calls.clone();
        let server = crate::utils::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let recorded = recorded.clone();
                crate::utils::spawn(async move {
                    let mut request = Vec::new();
                    let header_end = loop {
                        if let Some(at) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                            break at + 4;
                        }
                        let mut chunk = [0; 1024];
                        let read = stream.read(&mut chunk).await.unwrap();
                        assert!(read > 0, "the request ended before its headers");
                        request.extend_from_slice(&chunk[..read]);
                    };
                    let head = String::from_utf8_lossy(&request[..header_end]).to_string();
                    let path = head
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or_default()
                        .to_string();
                    let length = head
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    while request.len() < header_end + length {
                        let mut chunk = [0; 1024];
                        let read = stream.read(&mut chunk).await.unwrap();
                        assert!(read > 0, "the request ended before its body");
                        request.extend_from_slice(&chunk[..read]);
                    }
                    let body = serde_json::from_slice(&request[header_end..header_end + length])
                        .unwrap_or(Value::Null);
                    let (status, reply) = match path.as_str() {
                        "/config/update" if missing_remote => (
                            "500 Internal Server Error",
                            r#"{"error":"couldn't find type field in config"}"#,
                        ),
                        "/config/oauthstatus" => ("200 OK", r#"{"running":false}"#),
                        _ => ("200 OK", "{}"),
                    };
                    recorded.lock().unwrap().push((path, body));
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                        reply.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        (port, calls, server)
    }

    async fn restore_app(port: u16) -> (AppHandle, tempfile::TempDir) {
        use crate::rclone::backend::{
            BackendManager, CopySources, routing_transport::RoutingTransport, types::Backend,
        };
        use crate::utils::types::state::RcloneState;
        let directory = tempfile::tempdir().unwrap();
        let settings: AppSettingsManager =
            rcman::SettingsManager::builder("restore-contract", "1.0.0")
                .with_config_dir(directory.path())
                .with_schema::<crate::services::settings::schema::AppSettings>()
                .with_sub_settings(rcman::SubSettingsConfig::new("remotes").with_profiles())
                .with_sub_settings(rcman::SubSettingsConfig::singlefile("backend").with_profiles())
                .with_sub_settings(
                    rcman::SubSettingsConfig::singlefile(crate::utils::constants::SUB_QUICK_RUNS)
                        .with_profiles(),
                )
                .with_sub_settings(
                    rcman::SubSettingsConfig::singlefile(crate::utils::constants::SUB_WORKFLOWS)
                        .with_profiles(),
                )
                .build()
                .unwrap();
        let manager = BackendManager::new();
        manager
            .add(
                &settings,
                Backend::new_remote("A", "127.0.0.1", port),
                CopySources::default(),
            )
            .await
            .unwrap();
        manager.switch_to(&settings, "A").await.unwrap();
        let app = AppHandle::default();
        app.manage(manager);
        app.manage(settings);
        app.manage(RcloneState::new(
            reqwest::Client::new(),
            std::sync::Arc::new(RoutingTransport::new(app.clone())),
        ));
        (app, directory)
    }

    /// What a OneDrive backup holds: the saved token and the drive the user chose.
    fn onedrive_backup() -> Value {
        json!({"od": {
            "type": "onedrive",
            "token": "{\"access_token\":\"saved\"}",
            "drive_id": "B!MY-BUSINESS-DRIVE",
            "drive_type": "business"
        }})
    }

    /// The calls that carry a config, without the status polling that runs beside them.
    fn config_calls(calls: &Calls) -> Vec<(String, Value)> {
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(path, _)| path.starts_with("/config/") && path != "/config/oauthstatus")
            .cloned()
            .collect()
    }

    #[tokio::test]
    async fn a_restored_remote_is_stored_as_the_backup_has_it_and_rclone_asks_nothing() {
        let (port, calls, server) = fake_rclone(false).await;
        let (app, _directory) = restore_app(port).await;

        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            upsert_remote_from_config("od", onedrive_backup(), &app),
        )
        .await
        .unwrap()
        .unwrap();

        let calls = config_calls(&calls);
        assert_eq!(calls.len(), 1, "{calls:?}");
        let (path, body) = &calls[0];
        assert_eq!(path, "/config/update");
        // Without this rclone answers its own questions: it would pick the first OneDrive of the
        // account in place of the saved one, and never return while the token is rejected.
        assert_eq!(body["opt"], json!({"nonInteractive": true}));
        assert_eq!(body["name"], "od");
        assert_eq!(
            body["parameters"],
            json!({
                "type": "onedrive",
                "token": "{\"access_token\":\"saved\"}",
                "drive_id": "B!MY-BUSINESS-DRIVE",
                "drive_type": "business"
            })
        );
        server.abort();
    }

    #[tokio::test]
    async fn a_remote_that_does_not_exist_yet_is_created_the_same_way() {
        let (port, calls, server) = fake_rclone(true).await;
        let (app, _directory) = restore_app(port).await;

        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            upsert_remote_from_config("od", onedrive_backup(), &app),
        )
        .await
        .unwrap()
        .unwrap();

        let calls = config_calls(&calls);
        let paths: Vec<&str> = calls.iter().map(|(path, _)| path.as_str()).collect();
        assert_eq!(paths, ["/config/update", "/config/create"]);
        let (_, create) = &calls[1];
        assert_eq!(create["type"], "onedrive");
        assert_eq!(create["opt"], json!({"nonInteractive": true}));
        assert_eq!(create["parameters"]["drive_id"], "B!MY-BUSINESS-DRIVE");
        server.abort();
    }

    #[tokio::test]
    async fn a_backup_without_a_type_cannot_be_created_and_says_why() {
        let (port, calls, server) = fake_rclone(true).await;
        let (app, _directory) = restore_app(port).await;

        let error = upsert_remote_from_config("od", json!({"od": {"drive_id": "x"}}), &app)
            .await
            .unwrap_err();

        assert!(error.contains("couldn't find type field"), "{error}");
        assert_eq!(config_calls(&calls).len(), 1);
        server.abort();
    }
}
