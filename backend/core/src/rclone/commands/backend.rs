use std::path::PathBuf;

use crate::context::AppHandle;
use log::{debug, info, warn};

use crate::rclone::backend::connectivity::{PROBE_TIMEOUT, probe_backend};
use crate::rclone::backend::runtime::RuntimeInfo;
use crate::rclone::backend::types::Backend;
use crate::rclone::backend::types::BackendInfo;
use crate::rclone::backend::{BackendManager, CopySources};
use crate::rclone::endpoints::config;
use crate::rclone::engine::lifecycle::start_engine_if_not_running;
use crate::rclone::state::automations::AutomationsCache;
use crate::services::automation::engine::AutomationScheduler;
use crate::services::settings::AppSettingsManager;
use crate::utils::constants::LOCAL_BACKEND_NAME;
use crate::utils::types::events::BACKEND_SWITCHED;
use crate::utils::types::state::RcloneState;

pub async fn list_backends(app: AppHandle) -> Result<Vec<BackendInfo>, String> {
    let backend_manager = app.state::<BackendManager>();
    Ok(backend_manager.list_all().await)
}

pub async fn get_active_backend(app: AppHandle) -> Result<String, String> {
    let backend_manager = app.state::<BackendManager>();
    Ok(backend_manager.get_active_name().await)
}

pub async fn get_backend_profiles(app: AppHandle) -> Result<Vec<String>, String> {
    let manager = app.state::<AppSettingsManager>();
    let remotes = manager
        .sub_settings("remotes")
        .map_err(|e| format!("Failed to access remotes sub-settings: {e}"))?;

    remotes
        .profiles()
        .map_err(|_| "Profiles not enabled for remotes".to_string())?
        .list()
        .map_err(|e| format!("Failed to list profiles: {e}"))
}

pub async fn switch_backend(app: AppHandle, name: String) -> Result<(), String> {
    info!("Switching to backend: {name}");

    let backend_manager = app.state::<BackendManager>();
    let settings_manager = app.state::<AppSettingsManager>();
    let _switch = backend_manager.switch_lock.lock().await;

    let backend = backend_manager
        .get(&name)
        .await
        .ok_or_else(|| crate::localized_error!("backendErrors.backend.notFound", "name" => name))?;

    ensure_reachable(&app, &backend, &backend_manager).await?;

    backend_manager
        .switch_to(settings_manager.inner(), &name)
        .await?;
    app.state::<crate::services::automation::watcher::WatcherManager>()
        .stop_all()
        .await;

    crate::rclone::engine::lifecycle::clear_engine_errors(&app).await;
    info!("Re-evaluating engine after backend switch to '{name}'");
    start_engine_if_not_running(&app).await;

    configure_remote_backend(&app, &backend).await;

    let refresh_result =
        refresh_and_verify_cache(&app, &backend_manager, &settings_manager, &name).await;
    // Refresh may revert to Local. Reconcile the backend actually selected on
    // both paths, so old cron jobs and watch sessions cannot remain attached.
    let automation_result =
        crate::services::automation::commands::reload_automations_from_configs(&app).await;
    let active_name = backend_manager.get_active_name().await;

    crate::rclone::backend::manager::save_active_backend_to_settings(
        settings_manager.inner(),
        &active_name,
    );
    crate::services::bridge::emit(BACKEND_SWITCHED, &active_name);

    refresh_result?;
    automation_result?;

    info!("Switched to backend: {name}");
    Ok(())
}

/// Parameters for adding a new backend connection.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddBackendParams {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub is_local: bool,
    pub username: Option<String>,
    pub password: Option<String>,
    pub config_password: Option<String>,
    pub config_path: Option<PathBuf>,
    pub copy_backend_from: Option<String>,
    pub copy_remotes_from: Option<String>,
    pub copy_flow_from: Option<String>,
}

pub async fn add_backend(app: AppHandle, params: AddBackendParams) -> Result<(), String> {
    info!(
        "Adding backend: {} ({}:{})",
        params.name, params.host, params.port
    );

    if params.name.is_empty() {
        return Err(crate::localized_error!("backendErrors.backend.nameEmpty"));
    }
    if Backend::is_local_name(&params.name) {
        return Err(crate::localized_error!(
            "backendErrors.backend.cannotAddLocal"
        ));
    }

    let mut backend = if params.is_local {
        Backend::new_local(&params.name)
    } else {
        Backend::new_remote(&params.name, &params.host, params.port)
    };

    backend.host = params.host;
    backend.port = params.port;
    backend.config_path = params.config_path;

    if let (Some(u), Some(p)) = (&params.username, &params.password)
        && !u.is_empty()
        && !p.is_empty()
    {
        backend.username = Some(u.clone());
        backend.password = Some(p.clone());
    }

    if let Some(cp) = &params.config_password
        && !cp.is_empty()
    {
        backend.config_password = Some(cp.clone());
    }

    let settings_manager = app.state::<AppSettingsManager>();
    let backend_manager = app.state::<BackendManager>();
    backend_manager
        .add(
            settings_manager.inner(),
            backend.clone(),
            CopySources {
                backend: params.copy_backend_from.as_deref(),
                remotes: params.copy_remotes_from.as_deref(),
                flow: params.copy_flow_from.as_deref(),
            },
        )
        .await?;

    if let Err(error) = save_backend_to_settings(settings_manager.inner(), &backend) {
        // Without the saved connection the new backend would vanish on restart,
        // leaving its profiles behind.
        if let Err(rollback) = backend_manager
            .remove(settings_manager.inner(), &backend.name)
            .await
        {
            warn!("Failed to roll back backend '{}': {rollback}", backend.name);
        }
        return Err(error);
    }

    info!("Backend '{}' added", params.name);
    Ok(())
}

/// Parameters for updating an existing backend connection.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBackendParams {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub config_password: Option<String>,
    pub config_path: Option<PathBuf>,
}

/// The API credentials an updated backend ends up with.
#[derive(Debug, PartialEq)]
struct Credentials {
    username: Option<String>,
    password: Option<String>,
    is_auth_generated: bool,
}

/// Resolves the credentials sent with an update. The stored password never leaves the
/// backend, so a form that only edits the username sends no password.
/// - nothing sent: keep what is stored
/// - username and password: replace both
/// - username only: change the username, keep a stored custom password
/// - anything else: custom auth is off; Local falls back to its generated login
fn resolve_credentials(
    existing: &Backend,
    username: Option<&str>,
    password: Option<&str>,
) -> Credentials {
    let kept =
        |username: Option<String>, password: Option<String>, is_auth_generated| Credentials {
            username,
            password,
            is_auth_generated,
        };
    if username.is_none() && password.is_none() {
        return kept(
            existing.username.clone(),
            existing.password.clone(),
            existing.is_auth_generated,
        );
    }
    let username = username.filter(|u| !u.is_empty());
    let password = password.filter(|p| !p.is_empty());
    match (username, password) {
        (Some(u), Some(p)) => kept(Some(u.to_string()), Some(p.to_string()), false),
        (Some(u), None) if !existing.is_auth_generated && existing.password.is_some() => {
            kept(Some(u.to_string()), existing.password.clone(), false)
        }
        _ if existing.is_local && existing.is_auth_generated => {
            kept(existing.username.clone(), existing.password.clone(), true)
        }
        _ => kept(None, None, false),
    }
}

pub async fn update_backend(app: AppHandle, params: UpdateBackendParams) -> Result<(), String> {
    info!("Updating backend: {}", params.name);

    let backend_manager = app.state::<BackendManager>();
    let settings_manager = app.state::<AppSettingsManager>();

    let existing = backend_manager.get(&params.name).await.ok_or_else(
        || crate::localized_error!("backendErrors.backend.notFound", "name" => params.name),
    )?;

    let credentials = resolve_credentials(
        &existing,
        params.username.as_deref(),
        params.password.as_deref(),
    );
    let backend = Backend {
        name: params.name.clone(),
        is_local: existing.is_local,
        is_auth_generated: credentials.is_auth_generated,
        host: params.host,
        port: params.port,
        username: credentials.username,
        password: credentials.password,
        // `None` keeps the stored password, an empty one clears it.
        config_password: match params.config_password.as_deref() {
            None => existing.config_password.clone(),
            Some("") => None,
            Some(password) => Some(password.to_string()),
        },
        config_path: params.config_path,
    };

    let creds_changed =
        existing.username != backend.username || existing.password != backend.password;
    let address_changed =
        creds_changed || existing.host != backend.host || existing.port != backend.port;
    let conn_changed = address_changed
        || existing.config_path != backend.config_path
        || existing.config_password != backend.config_password;

    backend_manager
        .update(&params.name, backend.clone())
        .await?;

    save_backend_to_settings(settings_manager.inner(), &backend)?;

    if address_changed {
        // The old address's version, OS and status no longer describe this backend.
        backend_manager.clear_runtime_info(&params.name).await;
    }
    if conn_changed {
        let is_active = backend_manager.get_active_name().await == params.name;
        if is_active && !existing.is_local {
            configure_remote_backend(&app, &backend).await;
        }
        if is_active || existing.is_local {
            info!(
                "Restarting engine — connection or credentials of '{}' changed",
                params.name
            );
            crate::rclone::engine::lifecycle::clear_engine_errors(&app).await;
            crate::rclone::engine::lifecycle::restart_for_config_change(&app, "backend_settings");
        }
    }

    info!("Backend '{}' updated", params.name);
    Ok(())
}

pub async fn remove_backend(app: AppHandle, name: String) -> Result<(), String> {
    info!("Removing backend: {name}");

    let scheduler = app.state::<AutomationScheduler>();
    let automations_cache = app.state::<AutomationsCache>();
    let settings_manager = app.state::<AppSettingsManager>();
    let backend_manager = app.state::<BackendManager>();

    backend_manager
        .remove(settings_manager.inner(), &name)
        .await?;

    delete_backend_from_settings(settings_manager.inner(), &name)?;

    let automations = automations_cache.get_automations_for_backend(&name).await;
    if !automations.is_empty() {
        info!(
            "Cleaning up {} automations for backend '{name}'",
            automations.len()
        );
        for automation in automations {
            if let Some(job_id_str) = &automation.scheduler_job_id
                && let Ok(job_id) = uuid::Uuid::parse_str(job_id_str)
            {
                let _ = scheduler.unschedule_automation(job_id).await;
            }
        }
        automations_cache.clear_backend_automations(&name).await;
    }

    info!("Backend '{name}' removed");
    Ok(())
}

pub async fn test_backend_connection(
    app: AppHandle,
    name: String,
) -> Result<TestConnectionResult, String> {
    debug!("Testing connection: {name}");

    let backend_manager = app.state::<BackendManager>();
    let transport = app.state::<RcloneState>().transport.clone();
    Ok(
        match probe_backend(&backend_manager, &name, &*transport, PROBE_TIMEOUT).await {
            Ok(_) => TestConnectionResult::connected(
                backend_manager
                    .get_runtime_info(&name)
                    .await
                    .unwrap_or_default(),
            ),
            Err(error) => TestConnectionResult::failed(error),
        },
    )
}

/// Tests unsaved connection details. `name` is the backend being edited: its stored
/// password stands in when the form sends none, since the password never leaves the backend.
pub async fn test_backend_connection_details(
    app: AppHandle,
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    name: Option<String>,
) -> Result<TestConnectionResult, String> {
    debug!("Testing unsaved connection details: {host}:{port}");

    let mut temp_backend = Backend::new_remote("temp_test_backend", host, port);
    temp_backend.username = username;
    temp_backend.password = password;
    if temp_backend.password.is_none()
        && let Some(name) = name
        && let Some(saved) = app.state::<BackendManager>().get(&name).await
        && (temp_backend.username.is_none() || temp_backend.username == saved.username)
    {
        temp_backend.username = saved.username;
        temp_backend.password = saved.password;
    }

    let transport = app.state::<RcloneState>().transport.clone();
    let runtime_info = temp_backend
        .fetch_runtime_info(&*transport, PROBE_TIMEOUT)
        .await;

    Ok(if runtime_info.is_connected() {
        TestConnectionResult::connected(runtime_info)
    } else {
        TestConnectionResult::failed(runtime_info.error_message().unwrap_or_default())
    })
}

/// Suggest an available local TCP port starting from `start_port` (or default 51900).
#[cfg(not(feature = "librclone"))]
pub fn find_available_port(start_port: Option<u16>) -> Result<u16, String> {
    let start = start_port.unwrap_or(51900);
    Ok(crate::utils::process::process_manager::find_next_available_port(start))
}

/// Check if a specific local TCP port is available.
#[cfg(not(feature = "librclone"))]
pub fn check_port_available(port: u16) -> Result<bool, String> {
    Ok(!crate::utils::process::process_manager::is_port_in_use(
        port,
    ))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TestConnectionResult {
    pub success: bool,
    /// Localized failure reason, in the shape `localized_error!` produces.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub version: Option<String>,
    pub os: Option<String>,
    pub config_path: Option<PathBuf>,
}

impl TestConnectionResult {
    fn connected(info: RuntimeInfo) -> Self {
        Self {
            success: true,
            message: None,
            version: info.version,
            os: info.os,
            config_path: info.config_path,
        }
    }

    fn failed(error: impl std::fmt::Display) -> Self {
        Self {
            success: false,
            message: Some(
                crate::localized_error!("backendErrors.backend.connectionFailed", "error" => error),
            ),
            version: None,
            os: None,
            config_path: None,
        }
    }
}

// Persistence helpers

fn save_backend_to_settings(manager: &AppSettingsManager, backend: &Backend) -> Result<(), String> {
    let connections = manager
        .sub_settings("connections")
        .map_err(|e| e.to_string())?;

    let mut backend_to_save = backend.clone();
    if backend_to_save.is_auth_generated {
        backend_to_save.username = None;
        backend_to_save.password = None;
    }

    let mut value = serde_json::to_value(&backend_to_save).map_err(|e| e.to_string())?;
    // rcman preserves omitted secrets. Write their schema defaults explicitly
    // when the connection no longer has a password so stored credentials clear.
    value["password"] = serde_json::json!(backend_to_save.password.as_deref().unwrap_or_default());
    value["config_password"] = serde_json::json!(
        backend_to_save
            .config_password
            .as_deref()
            .unwrap_or_default()
    );
    connections
        .set(&backend.name, &value)
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn delete_backend_from_settings(manager: &AppSettingsManager, name: &str) -> Result<(), String> {
    let connections = manager
        .sub_settings("connections")
        .map_err(|e| e.to_string())?;

    connections.delete(name).map_err(|e| e.to_string())?;
    Ok(())
}

/// Refuses to switch to a remote that does not answer. The probe also records its
/// version, OS and config path, so the switched-to backend is never shown without them.
async fn ensure_reachable(
    app: &AppHandle,
    backend: &Backend,
    backend_manager: &BackendManager,
) -> Result<(), String> {
    if backend.is_local {
        return Ok(());
    }

    let transport = app.state::<RcloneState>().transport.clone();
    probe_backend(backend_manager, &backend.name, &*transport, PROBE_TIMEOUT)
        .await
        .map(|_| ())
        .map_err(|error| {
            crate::localized_error!(
                "backendErrors.backend.cannotConnect",
                "name" => backend.name, "error" => error
            )
        })
}

async fn configure_remote_backend(app: &AppHandle, backend: &Backend) {
    if let Some(config_path) = &backend.config_path {
        info!(
            "Setting config path for remote backend '{}' to: {}",
            backend.name,
            config_path.display()
        );
        let params = serde_json::json!({ "path": config_path });
        let transport = app.state::<RcloneState>().transport.clone();
        if let Err(e) = transport.rpc(config::SETPATH, Some(&params)).await {
            warn!("Failed to set config path: {e}");
        } else {
            info!("Config path set successfully");
        }
    }

    if backend.config_password.is_some()
        && let Err(e) = crate::rclone::commands::system::try_auto_unlock_config(app).await
    {
        warn!("Auto-unlock failed: {e}");
    }
}

async fn refresh_and_verify_cache(
    app: &AppHandle,
    backend_manager: &BackendManager,
    settings_manager: &AppSettingsManager,
    name: &str,
) -> Result<(), String> {
    let backend = backend_manager
        .get(name)
        .await
        .ok_or_else(|| crate::localized_error!("backendErrors.backend.notFound", "name" => name))?;
    match tokio::time::timeout(
        std::time::Duration::from_secs(15),
        app.state::<BackendManager>()
            .remote_cache_for(name)
            .refresh_all(app.clone(), &backend),
    )
    .await
    {
        Ok(Ok(())) => {
            info!("Cache refreshed for backend '{name}'");
            Ok(())
        }
        Ok(Err(e)) => {
            warn!("Cache refresh failed for backend '{name}': {e}");
            revert_to_local(backend_manager, settings_manager, name).await;
            Err(crate::localized_error!("backendErrors.backend.listFailedReverted", "error" => e))
        }
        Err(_) => {
            warn!("Cache refresh timed out for backend '{name}'");
            if !Backend::is_local_name(name) {
                backend_manager
                    .set_runtime_status(
                        name,
                        crate::rclone::backend::runtime::RuntimeStatus::Error(
                            "Connection too slow".to_string(),
                        ),
                    )
                    .await;
            }
            revert_to_local(backend_manager, settings_manager, name).await;
            Err(crate::localized_error!(
                "backendErrors.backend.tooSlowReverted"
            ))
        }
    }
}

async fn revert_to_local(
    backend_manager: &BackendManager,
    settings_manager: &AppSettingsManager,
    current_name: &str,
) {
    if !Backend::is_local_name(current_name) {
        info!("Reverting to previous backend due to failure");
        if let Err(e) = backend_manager
            .switch_to(settings_manager, LOCAL_BACKEND_NAME)
            .await
        {
            warn!("Failed to revert to Local backend: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_manager() -> (tempfile::TempDir, AppSettingsManager) {
        let directory = tempfile::tempdir().unwrap();
        let manager = rcman::SettingsManager::builder("backend-secrets-test", "1")
            .with_config_dir(directory.path())
            .with_schema::<crate::services::settings::schema::AppSettings>()
            .with_credential_config(rcman::CredentialConfig::Custom(std::sync::Arc::new(
                rcman::MemoryBackend::new(),
            )))
            .with_sub_settings(
                rcman::SubSettingsConfig::singlefile("connections").with_schema::<Backend>(),
            )
            .build()
            .unwrap();
        (directory, manager)
    }

    #[test]
    fn clearing_connection_passwords_removes_credentials_and_tracking() {
        let (directory, manager) = settings_manager();
        let mut backend = Backend::new_remote("Test", "localhost", 51900);
        backend.password = Some("api-secret".into());
        backend.config_password = Some("config-secret".into());
        save_backend_to_settings(&manager, &backend).unwrap();

        backend.password = None;
        backend.config_password = None;
        save_backend_to_settings(&manager, &backend).unwrap();

        let credentials = manager.credentials().unwrap();
        for field in ["password", "config_password"] {
            let key = format!("sub.connections.Test.{field}");
            assert_eq!(credentials.get(&key).unwrap(), None);
            assert!(
                !credentials
                    .get_tracked_secrets(None)
                    .unwrap()
                    .contains(&key)
            );
        }
        let saved = std::fs::read_to_string(directory.path().join("connections.json")).unwrap();
        assert!(!saved.contains("api-secret"));
        assert!(!saved.contains("config-secret"));
    }

    #[test]
    fn generated_auth_clears_saved_api_password_and_preserves_config_password() {
        let (_directory, manager) = settings_manager();
        let mut backend = Backend::new_local(LOCAL_BACKEND_NAME);
        backend.password = Some("old-api-secret".into());
        backend.config_password = Some("config-secret".into());
        save_backend_to_settings(&manager, &backend).unwrap();

        backend.is_auth_generated = true;
        backend.password = Some("runtime-only-secret".into());
        save_backend_to_settings(&manager, &backend).unwrap();

        let credentials = manager.credentials().unwrap();
        assert_eq!(
            credentials.get("sub.connections.Local.password").unwrap(),
            None
        );
        assert_eq!(
            credentials
                .get("sub.connections.Local.config_password")
                .unwrap()
                .as_deref(),
            Some("config-secret")
        );
        let tracked = credentials.get_tracked_secrets(None).unwrap();
        assert!(!tracked.contains("sub.connections.Local.password"));
        assert!(tracked.contains("sub.connections.Local.config_password"));
    }

    #[test]
    fn test_params_deserialize_camelcase() {
        let json = r#"{
            "name": "Local",
            "host": "0.0.0.0",
            "port": 51900,
            "configPassword": "secret",
            "configPath": "/config/rclone.conf"
        }"#;

        let params: UpdateBackendParams = serde_json::from_str(json).unwrap();
        assert_eq!(params.config_password.as_deref(), Some("secret"));
        assert_eq!(
            params.config_path.as_ref(),
            Some(&PathBuf::from("/config/rclone.conf"))
        );
    }

    #[test]
    fn test_add_params_deserialize_camelcase() {
        let json = r#"{
            "name": "MyRemote",
            "host": "192.168.1.100",
            "port": 51900,
            "isLocal": false
        }"#;

        let params: AddBackendParams = serde_json::from_str(json).unwrap();
        assert!(!params.is_local);
    }

    #[test]
    fn test_missing_optional_fields_use_none() {
        let json = r#"{"name":"Local","host":"0.0.0.0","port":51900}"#;
        let params: UpdateBackendParams = serde_json::from_str(json).unwrap();
        assert_eq!(params.username, None);
        assert_eq!(params.password, None);
    }

    fn existing_backend(is_local: bool, generated: bool, password: Option<&str>) -> Backend {
        let mut backend = Backend::new_remote("NAS", "10.0.0.1", 51900);
        backend.is_local = is_local;
        backend.is_auth_generated = generated;
        backend.username = password.map(|_| "admin".to_string());
        backend.password = password.map(str::to_string);
        backend
    }

    fn resolved(credentials: Credentials) -> (Option<String>, Option<String>, bool) {
        (
            credentials.username,
            credentials.password,
            credentials.is_auth_generated,
        )
    }

    #[test]
    fn sending_no_credentials_keeps_the_stored_ones() {
        for generated in [false, true] {
            let existing = existing_backend(generated, generated, Some("secret"));
            assert_eq!(
                resolved(resolve_credentials(&existing, None, None)),
                (Some("admin".into()), Some("secret".into()), generated)
            );
        }
    }

    #[test]
    fn a_username_and_password_replace_generated_credentials() {
        let existing = existing_backend(true, true, Some("generated"));
        assert_eq!(
            resolved(resolve_credentials(&existing, Some("me"), Some("mine"))),
            (Some("me".into()), Some("mine".into()), false)
        );
    }

    #[test]
    fn a_username_alone_keeps_the_stored_custom_password() {
        let existing = existing_backend(false, false, Some("secret"));
        assert_eq!(
            resolved(resolve_credentials(&existing, Some("renamed"), None)),
            (Some("renamed".into()), Some("secret".into()), false)
        );
    }

    #[test]
    fn empty_credentials_turn_custom_auth_off() {
        let remote = existing_backend(false, false, Some("secret"));
        assert_eq!(
            resolved(resolve_credentials(&remote, Some(""), Some(""))),
            (None, None, false)
        );
        let no_password = existing_backend(false, false, None);
        assert_eq!(
            resolved(resolve_credentials(&no_password, Some("admin"), None)),
            (None, None, false)
        );
    }

    #[test]
    fn local_falls_back_to_its_generated_login_when_custom_auth_is_off() {
        let local = existing_backend(true, true, Some("generated"));
        assert_eq!(
            resolved(resolve_credentials(&local, Some(""), Some(""))),
            (Some("admin".into()), Some("generated".into()), true)
        );
    }

    #[test]
    fn backend_info_never_carries_the_password() {
        let mut backend = Backend::new_remote("NAS", "10.0.0.1", 51900);
        backend.username = Some("admin".into());
        backend.password = Some("secret".into());
        let json = serde_json::to_string(&BackendInfo::from_backend(&backend, false)).unwrap();
        assert!(json.contains("admin"));
        assert!(!json.contains("secret"));
        assert!(!json.contains("password"));
    }
    /// Answers the three probe endpoints like an rcd would; every other path gets `config/paths`.
    async fn serve_rc(listener: tokio::net::TcpListener) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buffer = [0u8; 4096];
                let read = stream.read(&mut buffer).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]);
                let body = if request.contains("core/version") {
                    r#"{"version":"v1.76.0","decomposed":[1,76,0],"goVersion":"go1","os":"linux","arch":"amd64","isBeta":false,"isGit":false,"linking":"static","goTags":"none"}"#
                } else if request.contains("core/pid") {
                    r#"{"pid":42}"#
                } else {
                    r#"{"config":"/etc/rclone.conf"}"#
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    }

    /// An app whose only extra backend, `NAS`, is a remote at `port`.
    async fn app_with_remote(port: u16) -> (AppHandle, tempfile::TempDir) {
        use crate::rclone::backend::routing_transport::RoutingTransport;
        let directory = tempfile::tempdir().unwrap();
        let settings: AppSettingsManager = rcman::SettingsManager::builder("probe-test", "1")
            .with_config_dir(directory.path())
            .with_schema::<crate::services::settings::schema::AppSettings>()
            .with_sub_settings(rcman::SubSettingsConfig::new("remotes").with_profiles())
            .with_sub_settings(rcman::SubSettingsConfig::singlefile("backend").with_profiles())
            .with_sub_settings(rcman::SubSettingsConfig::singlefile("quick_runs").with_profiles())
            .with_sub_settings(rcman::SubSettingsConfig::singlefile("workflows").with_profiles())
            .build()
            .unwrap();
        let manager = BackendManager::new();
        manager
            .add(
                &settings,
                Backend::new_remote("NAS", "127.0.0.1", port),
                CopySources::default(),
            )
            .await
            .unwrap();
        let app = AppHandle::default();
        app.manage(manager);
        app.manage(settings);
        app.manage(RcloneState::new(
            crate::rclone::backend::types::rc_client(),
            std::sync::Arc::new(RoutingTransport::new(app.clone())),
        ));
        (app, directory)
    }

    #[tokio::test]
    async fn switching_to_a_remote_records_its_version_os_and_config_path() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(serve_rc(listener));
        let (app, _directory) = app_with_remote(port).await;
        let manager = app.state::<BackendManager>();
        let backend = manager.get("NAS").await.unwrap();

        ensure_reachable(&app, &backend, &manager).await.unwrap();

        let info = manager.get_runtime_info("NAS").await.unwrap();
        assert!(info.is_connected());
        assert_eq!(info.version.as_deref(), Some("v1.76.0"));
        assert_eq!(info.os.as_deref(), Some("linux"));
        assert_eq!(
            info.config_path.as_deref(),
            Some(std::path::Path::new("/etc/rclone.conf"))
        );
    }

    #[tokio::test]
    async fn switching_to_an_unreachable_remote_fails_and_marks_it_offline() {
        let port = {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            listener.local_addr().unwrap().port()
        };
        let (app, _directory) = app_with_remote(port).await;
        let manager = app.state::<BackendManager>();
        let backend = manager.get("NAS").await.unwrap();

        let error = ensure_reachable(&app, &backend, &manager)
            .await
            .unwrap_err();

        assert!(error.contains("backendErrors.backend.cannotConnect"));
        let info = manager.get_runtime_info("NAS").await.unwrap();
        assert!(info.error_message().is_some());
    }

    #[tokio::test]
    async fn a_failed_test_replaces_the_connected_status_and_keeps_the_last_known_version() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(serve_rc(listener));
        let (app, _directory) = app_with_remote(port).await;

        let first = test_backend_connection(app.clone(), "NAS".into())
            .await
            .unwrap();
        assert!(first.success);
        assert_eq!(first.version.as_deref(), Some("v1.76.0"));
        assert!(first.message.is_none());

        server.abort();
        let _ = server.await;
        let second = test_backend_connection(app.clone(), "NAS".into())
            .await
            .unwrap();

        assert!(!second.success);
        assert!(
            second
                .message
                .unwrap()
                .contains("backendErrors.backend.connectionFailed")
        );
        let listed = app
            .state::<BackendManager>()
            .list_all()
            .await
            .into_iter()
            .find(|backend| backend.name == "NAS")
            .unwrap();
        assert!(matches!(
            listed.status,
            Some(crate::rclone::backend::runtime::RuntimeStatus::Error(_))
        ));
        assert_eq!(listed.version.as_deref(), Some("v1.76.0"));
    }

    #[tokio::test]
    async fn testing_unsaved_details_borrows_the_stored_password_only_for_the_same_user() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buffer = [0u8; 4096];
                    let read = stream.read(&mut buffer).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buffer[..read]).to_lowercase();
                    // "admin:secret"
                    let authorized = request.contains("authorization: basic ywrtaw46c2vjcmv0");
                    let (status, body) = if authorized {
                        (
                            "200 OK",
                            r#"{"version":"v1","decomposed":[1],"goVersion":"g","os":"linux","arch":"a","isBeta":false,"isGit":false,"linking":"s","goTags":"n"}"#,
                        )
                    } else {
                        ("401 Unauthorized", r#"{"error":"unauthorized"}"#)
                    };
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        let (app, _directory) = app_with_remote(port).await;
        let manager = app.state::<BackendManager>();
        let mut saved = manager.get("NAS").await.unwrap();
        saved.username = Some("admin".into());
        saved.password = Some("secret".into());
        manager.update("NAS", saved).await.unwrap();
        let test = |username: Option<&str>| {
            test_backend_connection_details(
                app.clone(),
                "127.0.0.1".into(),
                port,
                username.map(String::from),
                None,
                Some("NAS".into()),
            )
        };

        assert!(test(Some("admin")).await.unwrap().success);
        assert!(test(None).await.unwrap().success);
        assert!(!test(Some("someone-else")).await.unwrap().success);
    }
}
