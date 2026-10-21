use crate::context::AppHandle;
use log::{info, warn};
use serde_json::{Map, Value, json};
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
use crate::services::flow::quick_run::commands::delete_quick_runs_for_remote;
use crate::services::flow::quick_run::commands::sync_quick_run_automations;
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

fn build_opt(user_opt: Option<Value>, protocol_keys: Value) -> Value {
    let mut map = Map::new();

    if let Some(Value::Object(user)) = user_opt {
        map.extend(user);
    }
    if let Value::Object(protocol) = protocol_keys {
        map.extend(protocol);
    }

    Value::Object(map)
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

pub async fn create_remote_interactive(
    app: AppHandle,
    name: String,
    rclone_type: String,
    parameters: Option<HashMap<String, Value>>,
    opt: Option<Value>,
    backend_name: Option<String>,
) -> Result<Value, String> {
    let backend = app
        .state::<BackendManager>()
        .get_active_checked(backend_name.as_deref())
        .await?;
    let is_local = backend.is_local;
    let transport = RoutingTransport::for_backend(app.clone(), backend);
    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Interactive remote creation".to_string()),
        "Starting interactive config flow".to_string(),
        Some(json!({ "type": rclone_type })),
    );

    let _poller = spawn_oauth_status_poller(app.clone(), transport.clone());

    let mut params_map = parameters.unwrap_or_default();
    add_oauth_template(&app, is_local, &mut params_map).await?;

    let body = json!({
        "name": name,
        "type": rclone_type,
        "opt":  build_opt(opt, json!({ "nonInteractive": true })),
        "parameters": params_map,
    });

    let value = call_config(transport.as_ref(), config::CREATE, body).await?;

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Interactive remote creation".to_string()),
        "Config step completed".to_string(),
        None,
    );

    Ok(value)
}

pub async fn continue_create_remote_interactive(
    app: AppHandle,
    name: String,
    state_token: String,
    result: Value,
    parameters: Option<HashMap<String, Value>>,
    opt: Option<Value>,
    backend_name: Option<String>,
) -> Result<Value, String> {
    let backend = app
        .state::<BackendManager>()
        .get_active_checked(backend_name.as_deref())
        .await?;
    let is_local = backend.is_local;
    let transport = RoutingTransport::for_backend(app.clone(), backend);
    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Interactive remote creation".to_string()),
        "Continuing config flow".to_string(),
        Some(json!({ "state": state_token })),
    );

    let _poller = spawn_oauth_status_poller(app.clone(), transport.clone());

    let mut params_map = parameters.unwrap_or_default();
    add_oauth_template(&app, is_local, &mut params_map).await?;

    let body = json!({
        "name": name,
        "opt": build_opt(opt, json!({
            "continue":       true,
            "state":          state_token,
            "result":         result,
            "nonInteractive": true,
        })),
        "parameters": params_map,
    });

    let value = call_config(transport.as_ref(), config::UPDATE, body).await?;

    if let Err(e) = transport
        .rpc(crate::rclone::endpoints::fscache::CLEAR, None)
        .await
    {
        warn!("Failed to clear fscache after interactive remote update: {e}");
    }

    crate::services::bridge::emit(REMOTE_CACHE_CHANGED, &name);

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Interactive remote creation".to_string()),
        "Config step answered".to_string(),
        None,
    );

    Ok(value)
}

pub async fn create_remote(
    app: AppHandle,
    name: String,
    parameters: HashMap<String, Value>,
    opt: Option<Value>,
    backend_name: Option<String>,
) -> Result<(), String> {
    let backend = app
        .state::<BackendManager>()
        .get_active_checked(backend_name.as_deref())
        .await?;
    let is_local = backend.is_local;
    let transport = RoutingTransport::for_backend(app.clone(), backend);
    let Some(remote_type) = parameters
        .get("type")
        .and_then(|v| v.as_str())
        .map(String::from)
    else {
        return Err("Missing remote type".into());
    };

    let mut params_map = parameters;
    add_oauth_template(&app, is_local, &mut params_map).await?;

    let mut body = json!({
        "name":       name,
        "type":       remote_type,
        "parameters": params_map,
    });

    if let Some(ref extra) = opt {
        body["opt"] = extra.clone();
    }

    let redacted_payload = redact_value(&body, &app);

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Remote creation".to_string()),
        "Creating remote".to_string(),
        Some(json!({
            "arguments": redacted_payload,
        })),
    );

    let _poller = spawn_oauth_status_poller(app.clone(), transport.clone());

    call_config(transport.as_ref(), config::CREATE, body)
        .await
        .map_err(|e| {
            log_operation(
                LogLevel::Error,
                Some(name.clone()),
                Some("Remote creation".to_string()),
                "Failed to create remote".to_string(),
                Some(json!({ "error": e })),
            );
            match e {
                ref s if s.contains("failed to get oauth token") => {
                    "OAuth authentication failed or was not completed".into()
                }
                ref s if s.contains("bind: address already in use") => "Port already in use".into(),
                _ => e,
            }
        })?;

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Remote creation".to_string()),
        "Remote created successfully".to_string(),
        None,
    );

    crate::services::bridge::emit(REMOTE_CACHE_CHANGED, &name);

    Ok(())
}

pub async fn update_remote(
    app: AppHandle,
    name: String,
    parameters: HashMap<String, Value>,
    opt: Option<Value>,
    backend_name: Option<String>,
) -> Result<(), String> {
    let backend = app
        .state::<BackendManager>()
        .get_active_checked(backend_name.as_deref())
        .await?;
    let is_local = backend.is_local;
    let transport = RoutingTransport::for_backend(app.clone(), backend);
    let Some(_remote_type) = parameters.get("type").and_then(|v| v.as_str()) else {
        return Err("Missing remote type".into());
    };

    let mut params_map = parameters;
    add_oauth_template(&app, is_local, &mut params_map).await?;

    let mut body = json!({ "name": name, "parameters": params_map });

    if let Some(ref extra) = opt {
        body["opt"] = extra.clone();
    }

    let redacted_payload = redact_value(&body, &app);

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Remote update".to_string()),
        "Updating remote".to_string(),
        Some(json!({
            "arguments": redacted_payload,
        })),
    );

    let _poller = spawn_oauth_status_poller(app.clone(), transport.clone());

    call_config(transport.as_ref(), config::UPDATE, body)
        .await
        .map_err(|e| {
            log_operation(
                LogLevel::Error,
                Some(name.clone()),
                Some("Remote update".to_string()),
                "Failed to update remote".to_string(),
                Some(json!({ "error": e })),
            );
            e
        })?;

    log_operation(
        LogLevel::Info,
        Some(name.clone()),
        Some("Remote update".to_string()),
        "Remote updated successfully".to_string(),
        None,
    );

    crate::services::bridge::emit(REMOTE_CACHE_CHANGED, &name);

    if let Err(e) = transport
        .rpc(crate::rclone::endpoints::fscache::CLEAR, None)
        .await
    {
        warn!("Failed to clear fscache after remote update: {e}");
    }

    Ok(())
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
            stop_job_on_backend(app.clone(), backend.clone(), job.jobid, name.clone()).await?;
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
        Ok(_) => sync_quick_run_automations(&app).await,
        Err(error) => Err(error),
    };
    app.state::<LogCache>().clear_for_remote(&name).await;
    settings_result.and(presets_result)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        use crate::rclone::backend::types::Backend;
        use std::sync::{Arc, atomic::AtomicBool};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let directory = tempfile::tempdir().unwrap();
        let settings: AppSettingsManager =
            rcman::SettingsManager::builder("delete-contract", "1.0.0")
                .with_config_dir(directory.path())
                .with_schema::<crate::services::settings::schema::AppSettings>()
                .with_sub_settings(rcman::SubSettingsConfig::new("remotes").with_profiles())
                .with_sub_settings(rcman::SubSettingsConfig::singlefile("backend").with_profiles())
                .with_sub_settings(rcman::SubSettingsConfig::singlefile(
                    crate::utils::constants::SUB_QUICK_RUNS,
                ))
                .build()
                .unwrap();
        let manager = BackendManager::new();
        manager
            .add(
                &settings,
                Backend::new_remote("A", "127.0.0.1", listener.local_addr().unwrap().port()),
                None,
                None,
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
        app.manage(RcloneState {
            client: reqwest::Client::new(),
            transport: Arc::new(RoutingTransport::new(app.clone())),
            is_shutting_down: AtomicBool::new(false),
            poller_running: AtomicBool::new(false),
            poller_visible: AtomicBool::new(false),
            initial_startup: AtomicBool::new(false),
            updater_running: AtomicBool::new(false),
            initialization_lock: tokio::sync::Mutex::new(()),
            vault_operation_lock: tokio::sync::Mutex::new(()),
        });
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
