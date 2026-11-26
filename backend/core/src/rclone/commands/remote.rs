use crate::context::AppHandle;
use log::{info, warn};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::time::Duration;

use crate::rclone::backend::{
    BackendManager, RcloneTransport, routing_transport::RoutingTransport,
};
use crate::rclone::commands::common::redact_value;
use crate::rclone::commands::job::stop_job_on_backend;
use crate::rclone::commands::mount::unmount_remote_on_backend;
use crate::rclone::commands::serve::stop_serve_on_backend;
use crate::rclone::endpoints::config;
use crate::services::automation::commands::sync_flow_automations;
use crate::services::flow::quick_run::commands::delete_quick_runs_for_remote;
use crate::services::settings::AppSettingsManager;
use crate::services::settings::remote::manager::delete_remote_settings_on_backend;
use crate::utils::logging::log::log_operation;
use crate::utils::types::events::RCLONE_OAUTH_URL;
use crate::utils::types::events::REMOTE_CACHE_CHANGED;
use crate::utils::types::logs::LogCache;
use crate::utils::types::logs::LogLevel;
use crate::utils::types::state::RcloneState;

const OAUTH_POLL_INTERVAL: Duration = Duration::from_millis(200);
const OAUTH_POLL_TIMEOUT: Duration = Duration::from_secs(300);

struct OAuthPollerGuard(tokio::task::JoinHandle<()>);

impl Drop for OAuthPollerGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Spawn a background poller that watches `config/oauthstatus` and emits
/// `RCLONE_OAUTH_URL` to the frontend when the OAuth server produces an
/// auth URL.
fn spawn_oauth_status_poller(
    app: AppHandle,
    transport: std::sync::Arc<dyn RcloneTransport>,
) -> OAuthPollerGuard {
    let handle = crate::utils::spawn(async move {
        let mut url_emitted = false;
        let start = std::time::Instant::now();

        log::debug!("Starting OAuth status poller (timeout: {OAUTH_POLL_TIMEOUT:?})");

        loop {
            if start.elapsed() > OAUTH_POLL_TIMEOUT {
                log::warn!("OAuth status poller timed out after {OAUTH_POLL_TIMEOUT:?}");
                return;
            }

            if app.state::<RcloneState>().is_shutting_down() {
                log::debug!("OAuth status poller exiting — app shutting down");
                return;
            }

            let status = match transport.rpc(config::OAUTHSTATUS, None).await {
                Ok(s) => s,
                Err(e) => {
                    log::debug!("oauthstatus poll error (will retry): {e}");
                    tokio::time::sleep(OAUTH_POLL_INTERVAL).await;
                    continue;
                }
            };

            let running = status
                .get("running")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let auth_url = status
                .get("authUrl")
                .and_then(|v| v.as_str())
                .map(String::from);

            log::debug!(
                "oauthstatus: running={running}, authUrl={:?}",
                auth_url.as_deref().map(|u| &u[..u.len().min(60)])
            );

            if let Some(url) = auth_url {
                if !url_emitted {
                    info!("OAuth auth URL available, emitting to frontend");
                    crate::services::bridge::emit(RCLONE_OAUTH_URL, json!({ "url": url }));
                    url_emitted = true;
                }
            } else if url_emitted {
                log::debug!(
                    "OAuth server stopped (running={running}, authUrl is None) after URL was emitted — flow completed"
                );
                return;
            }

            tokio::time::sleep(OAUTH_POLL_INTERVAL).await;
        }
    });

    OAuthPollerGuard(handle)
}

async fn call_config(
    transport: &dyn RcloneTransport,
    endpoint: &str,
    body: Value,
) -> Result<Value, String> {
    transport
        .rpc(endpoint, Some(&body))
        .await
        .map_err(|e| crate::localized_error!("backendErrors.request.failed", "error" => e))
}

async fn add_oauth_template(
    app: &AppHandle,
    is_local: bool,
    parameters: &mut HashMap<String, Value>,
) -> Result<(), String> {
    if parameters.contains_key("config_template_file") || parameters.contains_key("config_template")
    {
        return Ok(());
    }
    if let Ok(paths) = crate::services::paths::AppPaths::from_app_handle(app) {
        let template = paths.oauth_template_path().map_err(
            |error| crate::localized_error!("backendErrors.request.failed", "error" => error),
        )?;
        if is_local {
            if template.exists() {
                parameters.insert("config_template_file".into(), json!(template));
            }
        } else {
            match tokio::fs::read_to_string(&template).await {
                Ok(content) => {
                    // config/create and config/update reject CR/LF even in ephemeral values.
                    // The bundled template uses block comments and explicit JS semicolons.
                    parameters.insert(
                        "config_template".into(),
                        json!(content.replace(['\r', '\n'], " ")),
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(
                        crate::localized_error!("backendErrors.request.failed", "error" => error),
                    );
                }
            }
        }
    }
    Ok(())
}

/// The OAuth failures users hit most get their own message; anything else is returned unchanged.
fn config_error(error: String) -> String {
    if error.contains("failed to get oauth token") {
        crate::localized_error!("backendErrors.remote.oauthFailed")
    } else if error.contains("bind: address already in use") {
        crate::localized_error!("backendErrors.remote.oauthPortInUse")
    } else {
        error
    }
}

fn config_body(
    name: &str,
    rclone_type: Option<String>,
    parameters: HashMap<String, Value>,
    opt: Option<Value>,
) -> Value {
    let mut body = json!({ "name": name, "parameters": parameters });
    if let Some(rclone_type) = rclone_type {
        body["type"] = json!(rclone_type);
    }
    if let Some(opt) = opt {
        body["opt"] = opt;
    }
    body
}

/// Runs `config/create` (when `rclone_type` is set) or `config/update` and returns rclone's answer.
///
/// `opt` is rclone's own option block, so the caller decides how the call behaves. With
/// `nonInteractive` rclone answers with the next question (its `State` is empty once the remote
/// is complete) and `continue`, `state` and `result` answer it. Without `nonInteractive` rclone
/// answers every question with its default.
async fn configure_remote(
    app: AppHandle,
    name: String,
    rclone_type: Option<String>,
    mut parameters: HashMap<String, Value>,
    opt: Option<Value>,
    backend_name: Option<String>,
) -> Result<Value, String> {
    let backend = app
        .state::<BackendManager>()
        .get_active_checked(backend_name.as_deref())
        .await?;
    let is_local = backend.is_local;
    let transport = RoutingTransport::for_backend(app.clone(), backend);
    add_oauth_template(&app, is_local, &mut parameters).await?;

    let (endpoint, operation) = if rclone_type.is_some() {
        (config::CREATE, "Remote creation")
    } else {
        (config::UPDATE, "Remote update")
    };
    let body = config_body(&name, rclone_type, parameters, opt);

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some(operation.to_string()),
        "Configuring remote".to_string(),
        Some(json!({ "arguments": redact_value(&body, &app) })),
    );

    let _poller = spawn_oauth_status_poller(app.clone(), transport.clone());

    let value = call_config(transport.as_ref(), endpoint, body)
        .await
        .map_err(|error| {
            log_operation(
                LogLevel::Error,
                Some(name.clone()),
                Some(operation.to_string()),
                "Failed to configure remote".to_string(),
                Some(json!({ "error": error })),
            );
            config_error(error)
        })?;

    if let Err(e) = transport
        .rpc(crate::rclone::endpoints::fscache::CLEAR, None)
        .await
    {
        warn!("Failed to clear fscache after remote config: {e}");
    }
    crate::services::bridge::emit(REMOTE_CACHE_CHANGED, &name);

    log_operation(
        LogLevel::Info,
        Some(name),
        Some(operation.to_string()),
        "Remote config step completed".to_string(),
        None,
    );

    Ok(value)
}

/// Starts `config/create`; see [`configure_remote`] for how `opt` drives rclone.
pub async fn create_remote(
    app: AppHandle,
    name: String,
    rclone_type: String,
    parameters: HashMap<String, Value>,
    opt: Option<Value>,
    backend_name: Option<String>,
) -> Result<Value, String> {
    configure_remote(app, name, Some(rclone_type), parameters, opt, backend_name).await
}

/// Runs `config/update`, which keeps the keys it is not given. It also answers the questions of
/// a `config/create` that stopped early (`continue`, `state` and `result` in `opt`).
pub async fn update_remote(
    app: AppHandle,
    name: String,
    parameters: HashMap<String, Value>,
    opt: Option<Value>,
    backend_name: Option<String>,
) -> Result<Value, String> {
    configure_remote(app, name, None, parameters, opt, backend_name).await
}

pub async fn delete_remote(
    app: AppHandle,
    name: String,
    backend_name: Option<String>,
) -> Result<(), String> {
    let manager = app.state::<BackendManager>();
    let _selection = manager.switch_lock.lock().await;
    let backend = manager.get_active_checked(backend_name.as_deref()).await?;
    let transport = RoutingTransport::for_backend(app.clone(), backend.clone());
    let prefix = format!("{name}:");
    let remotes = manager.remote_cache_for(&backend.name);
    for mount in remotes.get_mounted_remotes().await {
        if mount.fs.starts_with(&prefix) {
            unmount_remote_on_backend(
                app.clone(),
                backend.clone(),
                mount.mount_point,
                name.clone(),
            )
            .await?;
        }
    }
    for serve in remotes.get_serves().await {
        if serve
            .params
            .get("fs")
            .and_then(Value::as_str)
            .is_some_and(|fs| fs.starts_with(&prefix))
        {
            stop_serve_on_backend(app.clone(), backend.clone(), serve.id, name.clone()).await?;
        }
    }
    let jobs = manager.job_cache_for(&backend.name);
    for job in jobs.get_active_jobs().await {
        if job.remote_name.trim_end_matches(':') == name {
            stop_job_on_backend(app.clone(), backend.clone(), job.jobid).await?;
        }
    }
    // Keep saved settings and presets intact if Rclone rejects the actual deletion.
    call_config(transport.as_ref(), config::DELETE, json!({"name": name})).await?;
    crate::services::bridge::emit(REMOTE_CACHE_CHANGED, &name);
    jobs.delete_jobs_by_remote(&name, Some(&app)).await;
    let settings_result =
        delete_remote_settings_on_backend(&app, name.clone(), &backend.name).await;
    let settings = app.state::<AppSettingsManager>();
    let presets_result = match delete_quick_runs_for_remote(&settings, &name) {
        Ok(deleted) => {
            if let Some(runtime) =
                app.try_state::<crate::services::automation::runtime::RuntimeTasks>()
            {
                for id in deleted {
                    runtime.invalidate_quick_run(&id);
                }
            }
            sync_flow_automations(&app).await
        }
        Err(error) => Err(error),
    };
    app.state::<LogCache>().clear_for_remote(&name).await;
    settings_result.and(presets_result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_body_passes_rclones_option_block_through() {
        let parameters = HashMap::from([("host".to_string(), json!("example.com"))]);
        let opt = json!({
            "nonInteractive": true,
            "continue": true,
            "state": "password",
            "result": "a@b.c"
        });
        let create = config_body(
            "probe",
            Some("sugarsync".into()),
            parameters.clone(),
            Some(opt.clone()),
        );
        assert_eq!(
            create,
            json!({
                "name": "probe",
                "type": "sugarsync",
                "parameters": { "host": "example.com" },
                "opt": opt
            })
        );
        let update = config_body("probe", None, parameters, None);
        assert_eq!(
            update,
            json!({ "name": "probe", "parameters": { "host": "example.com" } })
        );
    }

    #[test]
    fn oauth_failures_get_their_own_message_and_other_errors_pass_through() {
        assert_eq!(
            config_error("loopback: failed to get oauth token: EOF".into()),
            "backendErrors.remote.oauthFailed"
        );
        assert_eq!(
            config_error("listen tcp: bind: address already in use".into()),
            "backendErrors.remote.oauthPortInUse"
        );
        assert_eq!(config_error("no region set".into()), "no region set");
    }

    #[tokio::test]
    async fn oauth_templates_preserve_explicit_settings_and_missing_paths() {
        let app = AppHandle::default();
        let mut parameters = HashMap::new();
        add_oauth_template(&app, false, &mut parameters)
            .await
            .unwrap();
        assert!(parameters.is_empty());
        parameters.insert("config_template_file".into(), json!("/remote/custom.html"));
        add_oauth_template(&app, true, &mut parameters)
            .await
            .unwrap();
        assert_eq!(parameters["config_template_file"], "/remote/custom.html");
        let mut parameters =
            HashMap::from([("config_template".into(), json!("<p>Özel {{.Title}}</p>"))]);
        add_oauth_template(&app, false, &mut parameters)
            .await
            .unwrap();
        assert_eq!(parameters["config_template"], "<p>Özel {{.Title}}</p>");
    }

    #[tokio::test]
    async fn oauth_templates_use_paths_locally_and_content_remotely() {
        let directory = tempfile::tempdir().unwrap();
        let paths = crate::services::paths::AppPaths {
            config_dir: directory.path().into(),
            cache_dir: directory.path().into(),
            logs_dir: directory.path().into(),
            resource_dir: directory.path().into(),
        };
        let template = paths.oauth_template_path().unwrap();
        let content = tokio::fs::read_to_string(&template).await.unwrap();
        let app = AppHandle::default();
        app.manage(paths);
        for is_local in [true, false] {
            let mut parameters = HashMap::new();
            add_oauth_template(&app, is_local, &mut parameters)
                .await
                .unwrap();
            if is_local {
                assert_eq!(parameters["config_template_file"], json!(template));
                assert!(!parameters.contains_key("config_template"));
            } else {
                assert_eq!(
                    parameters["config_template"],
                    content.replace(['\r', '\n'], " ")
                );
                assert!(
                    !parameters["config_template"]
                        .as_str()
                        .unwrap()
                        .contains(['\r', '\n'])
                );
                assert!(!parameters.contains_key("config_template_file"));
            }
        }
    }

    #[tokio::test]
    async fn stale_owner_is_rejected_before_config_or_filesystem_requests() {
        let app = AppHandle::default();
        app.manage(BackendManager::new());
        let expected = Some("another-backend".to_string());
        assert!(
            create_remote(
                app.clone(),
                "drive".into(),
                "drive".into(),
                HashMap::new(),
                None,
                expected.clone()
            )
            .await
            .is_err()
        );
        assert!(
            update_remote(
                app.clone(),
                "drive".into(),
                HashMap::new(),
                None,
                expected.clone()
            )
            .await
            .is_err()
        );
        assert!(
            delete_remote(app.clone(), "drive".into(), expected.clone())
                .await
                .is_err()
        );
        assert!(
            crate::rclone::commands::filesystem::mkdir(
                app,
                "/".into(),
                "tmp/path".into(),
                None,
                None,
                expected
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn rejected_remote_deletion_preserves_settings_and_presets() {
        use crate::rclone::backend::{CopySources, types::Backend};
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let directory = tempfile::tempdir().unwrap();
        let settings: AppSettingsManager =
            rcman::SettingsManager::builder("delete-contract", "1.0.0")
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
                Backend::new_remote("A", "127.0.0.1", listener.local_addr().unwrap().port()),
                CopySources::default(),
            )
            .await
            .unwrap();
        manager.switch_to(&settings, "A").await.unwrap();
        let original = json!({"mountConfigs": {"Default": {"app": {}, "rclone": {"fs": "drive:", "mountPoint": "/mnt"}}}});
        settings
            .sub_settings("remotes")
            .unwrap()
            .set("drive", &original)
            .unwrap();
        let preset = json!({"id": "qr", "name": "Keep me", "remoteName": "drive", "operationType": "mount", "config": original["mountConfigs"]["Default"]});
        settings
            .sub_settings(crate::utils::constants::SUB_QUICK_RUNS)
            .unwrap()
            .set("qr", &preset)
            .unwrap();
        let app = AppHandle::default();
        app.manage(manager);
        app.manage(settings);
        app.manage(RcloneState::new(
            reqwest::Client::new(),
            Arc::new(RoutingTransport::new(app.clone())),
        ));
        let server_app = app.clone();
        let server = crate::utils::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let mut bytes = [0; 1024];
                let read = stream.read(&mut bytes).await.unwrap();
                assert!(read > 0);
                request.extend_from_slice(&bytes[..read]);
            }
            assert!(String::from_utf8_lossy(&request).starts_with("POST /config/delete "));
            assert!(
                server_app
                    .state::<BackendManager>()
                    .switch_lock
                    .try_lock()
                    .is_err()
            );
            let body = r#"{"error":"permission denied"}"#;
            stream.write_all(format!("HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            delete_remote(app.clone(), "drive".into(), Some("A".into())),
        )
        .await
        .unwrap();
        assert!(result.is_err());
        server.await.unwrap();
        let settings = app.state::<AppSettingsManager>();
        assert_eq!(
            settings
                .sub_settings("remotes")
                .unwrap()
                .get_value("drive")
                .unwrap(),
            original
        );
        assert_eq!(
            settings
                .sub_settings(crate::utils::constants::SUB_QUICK_RUNS)
                .unwrap()
                .get_value("qr")
                .unwrap(),
            preset
        );
    }
}
