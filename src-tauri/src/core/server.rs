use axum::{
    Router,
    extract::{Query, State},
    http::{Method, StatusCode, header::AUTHORIZATION},
    middleware::Next,
    response::{IntoResponse, Json, Sse, sse::Event},
    routing::{get, post},
};
use axum_server::tls_rustls::RustlsConfig;
use futures::stream::Stream;
use log::{error, info};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, convert::Infallible, sync::Arc};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::broadcast;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::core::lifecycle::shutdown::handle_shutdown;
use crate::core::scheduler::commands::validate_cron;
use crate::core::scheduler::engine::CronScheduler;
use crate::rclone::commands::remote::create_remote;
use crate::utils::types::all_types::{JobCache, LogCache, ProfileParams, RcloneState, RemoteCache};
use crate::utils::types::scheduled_task::{CronValidationResponse, ScheduledTask};
use crate::utils::types::settings::SettingsState;
use crate::{rclone::state::scheduled_tasks::ScheduledTasksCache, utils::types::events::*};

#[cfg(feature = "updater")]
use crate::utils::app::updater::app_updates::{
    DownloadState, PendingUpdate, fetch_update, get_download_status, install_update,
};

// Config struct to pass parameters from lib.rs
#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub tls_cert: Option<std::path::PathBuf>,
    pub tls_key: Option<std::path::PathBuf>,
}

/// Shared state for web server handlers
#[derive(Clone)]
struct WebServerState {
    app_handle: AppHandle,
    event_tx: Arc<broadcast::Sender<TauriEvent>>,
    auth_credentials: Option<(String, String)>, // (username, base64_encoded_credentials)
}

/// Event message for SSE
#[derive(Clone, Debug, Serialize, Deserialize)]
struct TauriEvent {
    event: String,
    payload: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
struct ApiResponse<T> {
    success: bool,
    data: Option<T>,
    error: Option<String>,
}

impl<T> ApiResponse<T> {
    fn success(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
        }
    }

    fn error(message: String) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(message),
        }
    }
}

// Custom error type for API handlers
#[derive(Debug)]
enum AppError {
    BadRequest(anyhow::Error),
    InternalServerError(anyhow::Error),
}

// Enable '?' operator conversion for any error type
impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(err: E) -> Self {
        Self::InternalServerError(err.into())
    }
}

// Implement Axum's IntoResponse for automatic error handling
impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, error) = match self {
            AppError::BadRequest(e) => (StatusCode::BAD_REQUEST, e),
            AppError::InternalServerError(e) => {
                error!("API Error: {:#}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, e)
            }
        };

        let body = Json(ApiResponse::<String>::error(error.to_string()));
        (status, body).into_response()
    }
}

/// Authentication middleware for API endpoints
async fn auth_middleware(
    State(state): State<WebServerState>,
    request: axum::http::Request<axum::body::Body>,
    next: Next,
) -> Result<axum::response::Response, StatusCode> {
    if state.auth_credentials.is_none() {
        return Ok(next.run(request).await);
    }

    let (_username, expected_creds) = state.auth_credentials.as_ref().unwrap();

    // Check Authorization header (Basic Auth)
    if let Some(auth_header) = request.headers().get(AUTHORIZATION) {
        if let Ok(auth_str) = auth_header.to_str() {
            if auth_str.starts_with("Basic ") {
                let creds = &auth_str[6..];
                if creds == expected_creds {
                    return Ok(next.run(request).await);
                }
            }
        }
    }

    // Check query parameter as fallback
    if let Some(query_string) = request.uri().query() {
        if let Ok(decoded) = urlencoding::decode(query_string) {
            for param in decoded.split('&') {
                if let Some((key, value)) = param.split_once('=') {
                    if key == "auth" && value == expected_creds {
                        return Ok(next.run(request).await);
                    }
                }
            }
        }
    }

    let response = axum::http::Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .header(
            "WWW-Authenticate",
            format!("Basic realm=\"Rclone Manager\""),
        )
        .body(axum::body::Body::from("Unauthorized"))
        .unwrap();

    Ok(response)
}

fn remote_routes() -> Router<WebServerState> {
    Router::new()
        .route("/remotes", get(get_remotes_handler))
        .route("/remote/:name", get(get_remote_config_handler))
        .route("/remote-types", get(get_remote_types_handler))
        .route("/create-remote", post(create_remote_handler))
        .route(
            "/create-remote-interactive",
            post(create_remote_interactive_handler),
        )
        .route(
            "/continue-create-remote-interactive",
            post(continue_create_remote_interactive_handler),
        )
        .route("/quit-rclone-oauth", post(quit_rclone_oauth_handler))
        .route("/delete-remote", post(delete_remote_handler))
        .route("/save-remote-settings", post(save_remote_settings_handler))
        .route(
            "/delete-remote-settings",
            post(delete_remote_settings_handler),
        )
        .route("/get-cached-remotes", get(get_cached_remotes_handler))
        .route(
            "/get-oauth-supported-remotes",
            get(get_oauth_supported_remotes_handler),
        )
        .route(
            "/save-rclone-backend-option",
            post(save_rclone_backend_option_handler),
        )
        .route("/set-rclone-option", post(set_rclone_option_handler))
        .route(
            "/remove-rclone-backend-option",
            post(remove_rclone_backend_option_handler),
        )
        .route(
            "/get-grouped-options-with-values",
            get(get_grouped_options_with_values_handler),
        )
        .route("/update-remote", post(update_remote_handler))
}

fn system_routes() -> Router<WebServerState> {
    Router::new()
        .route("/stats", get(get_stats_handler))
        .route("/stats/filtered", get(get_core_stats_filtered_handler))
        .route("/transfers/completed", get(get_completed_transfers_handler))
        .route("/memory-stats", get(get_memory_stats_handler))
        .route("/bandwidth/limit", get(get_bandwidth_limit_handler))
        .route("/rclone-info", get(get_rclone_info_handler))
        .route("/rclone-pid", get(get_rclone_pid_handler))
        .route("/get-rclone-rc-url", get(get_rclone_rc_url_handler))
        .route("/kill-process-by-pid", get(kill_process_by_pid_handler))
        .route(
            "/check-rclone-available",
            get(check_rclone_available_handler),
        )
        .route(
            "/check-mount-plugin-installed",
            get(check_mount_plugin_installed_handler),
        )
        .route("/is-network-metered", get(is_network_metered_handler))
        .route("/provision-rclone", get(provision_rclone_handler))
        .route("/validate-cron", get(validate_cron_handler))
        .route("/handle-shutdown", post(handle_shutdown_handler))
        .route("/get-configs", get(get_configs_handler))
        .route("/force-check-serves", post(force_check_serves_handler))
        .route("/fetch-update", get(fetch_update_handler))
        .route("/get-download-status", get(get_download_status_handler))
        .route("/install-update", post(install_update_handler))
        .route("/relaunch-app", post(relaunch_app_handler))
        .route("/are-updates-disabled", get(are_updates_disabled_handler))
        .route("/get-build-type", get(get_build_type_handler))
}

fn file_operations_routes() -> Router<WebServerState> {
    Router::new()
        .route("/fs/info", get(get_fs_info_handler))
        .route("/disk-usage", get(get_disk_usage_handler))
        .route("/get-local-drives", get(get_local_drives_handler))
        .route("/get-size", get(get_size_handler))
        .route("/get-stat", get(get_stat_handler))
        .route("/mkdir", post(mkdir_handler))
        .route("/cleanup", post(cleanup_handler))
        .route("/copy-url", post(copy_url_handler))
        .route("/remote/paths", post(get_remote_paths_handler))
        .route("/convert-asset-src", get(convert_file_src_handler))
}

fn settings_routes() -> Router<WebServerState> {
    Router::new()
        .route("/settings", get(get_settings_handler))
        .route("/settings/load", get(load_settings_handler))
        .route("/save-setting", post(save_setting_handler))
        .route("/reset-setting", post(reset_setting_handler))
        .route("/reset-settings", post(reset_settings_handler))
        .route(
            "/save-rclone-backend-options",
            post(save_rclone_backend_options_handler),
        )
        .route(
            "/reset-rclone-backend-options",
            post(reset_rclone_backend_options_handler),
        )
        .route(
            "/get-rclone-backend-store-path",
            get(get_rclone_backend_store_path_handler),
        )
        .route("/check-links", get(check_links_handler))
        .route("/check-rclone-update", get(check_rclone_update_handler))
        .route("/update-rclone", get(update_rclone_handler))
}

fn mount_serve_routes() -> Router<WebServerState> {
    Router::new()
        .route("/mounted-remotes", get(get_mounted_remotes_handler))
        .route(
            "/get-cached-mounted-remotes",
            get(get_cached_mounted_remotes_handler),
        )
        .route("/get-cached-serves", get(get_cached_serves_handler))
        .route("/serve/start-profile", post(start_serve_profile_handler))
        .route("/serve/stop", post(stop_serve_handler))
        .route("/mount-remote-profile", post(mount_remote_profile_handler))
        .route("/unmount-remote", post(unmount_remote_handler))
        .route("/mount-types", get(get_mount_types_handler))
}

fn scheduled_tasks_routes() -> Router<WebServerState> {
    Router::new()
        .route(
            "/reload-scheduled-tasks-from-configs",
            post(reload_scheduled_tasks_from_configs_handler),
        )
        .route("/get-scheduled-tasks", get(get_scheduled_tasks_handler))
        .route(
            "/toggle-scheduled-task",
            post(toggle_scheduled_task_handler),
        )
        .route(
            "/get-scheduled-tasks-stats",
            get(get_scheduled_tasks_stats_handler),
        )
        .route(
            "/reload-scheduled-tasks",
            post(reload_scheduled_tasks_handler),
        )
        .route(
            "/clear-all-scheduled-tasks",
            post(clear_all_scheduled_tasks_handler),
        )
        .route("/get-scheduled-task", get(get_scheduled_task_handler))
}

fn flags_routes() -> Router<WebServerState> {
    Router::new()
        .route("/flags/mount", get(get_mount_flags_handler))
        .route("/flags/copy", get(get_copy_flags_handler))
        .route("/flags/sync", get(get_sync_flags_handler))
        .route("/flags/bisync", get(get_bisync_flags_handler))
        .route("/flags/move", get(get_move_flags_handler))
        .route("/flags/filter", get(get_filter_flags_handler))
        .route("/flags/vfs", get(get_vfs_flags_handler))
        .route("/flags/backend", get(get_backend_flags_handler))
        .route("/get-option-blocks", get(get_option_blocks_handler))
        .route("/get-flags-by-category", get(get_flags_by_category_handler))
        .route("/serve/types", get(get_serve_types_handler))
        .route("/serve/flags", get(get_serve_flags_handler))
}

fn security_routes() -> Router<WebServerState> {
    Router::new()
        .route(
            "/get-cached-encryption-status",
            get(get_cached_encryption_status_handler),
        )
        .route("/has-stored-password", get(has_stored_password_handler))
        .route(
            "/is-config-encrypted-cached",
            get(is_config_encrypted_cached_handler),
        )
        .route(
            "/has-config-password-env",
            get(has_config_password_env_handler),
        )
        .route(
            "/remove-config-password",
            post(remove_config_password_handler),
        )
        .route(
            "/validate-rclone-password",
            get(validate_rclone_password_handler),
        )
        .route(
            "/store-config-password",
            post(store_config_password_handler),
        )
        .route("/unencrypt-config", post(unencrypt_config_handler))
        .route("/encrypt-config", post(encrypt_config_handler))
        .route("/get-config-password", get(get_config_password_handler))
        .route(
            "/set-config-password-env",
            post(set_config_password_env_handler),
        )
        .route(
            "/clear-config-password-env",
            post(clear_config_password_env_handler),
        )
        .route(
            "/clear-encryption-cache",
            post(clear_encryption_cache_handler),
        )
        .route(
            "/change-config-password",
            post(change_config_password_handler),
        )
}

fn logs_routes() -> Router<WebServerState> {
    Router::new()
        .route("/get-remote-logs", get(get_remote_logs_handler))
        .route("/clear-remote-logs", get(clear_remote_logs_handler))
}

fn vfs_routes() -> Router<WebServerState> {
    Router::new()
        .route("/vfs/list", get(vfs_list_handler))
        .route("/vfs/forget", post(vfs_forget_handler))
        .route("/vfs/refresh", post(vfs_refresh_handler))
        .route("/vfs/stats", get(vfs_stats_handler))
        .route("/vfs/poll-interval", post(vfs_poll_interval_handler))
        .route("/vfs/queue", get(vfs_queue_handler))
        .route("/vfs/queue/set-expiry", post(vfs_queue_set_expiry_handler))
}

fn backup_routes() -> Router<WebServerState> {
    Router::new()
        .route("/backup-settings", get(backup_settings_handler))
        .route("/analyze-backup-file", get(analyze_backup_file_handler))
        .route("/restore-settings", post(restore_settings_handler))
}

pub async fn start_web_server(
    app_handle: AppHandle,
    host: String,
    port: u16,
    auth_credentials: Option<(String, String)>,
    tls_cert: Option<std::path::PathBuf>,
    tls_key: Option<std::path::PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    info!("🌐 Starting web server on {}:{}", host, port);

    // In development mode, inform about Angular dev server integration
    #[cfg(debug_assertions)]
    {
        let dev_port = std::env::var("TAURI_DEV_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(1420);
        info!("🔧 Development mode detected!");
        info!(
            "   → Angular dev server: http://localhost:{} (with hot reload)",
            dev_port
        );
        info!("   → API server: http://localhost:{}/api", port);
        info!("   → Use Angular dev server for faster development with hot reload");
    }

    // Create broadcast channel for SSE events
    let (event_tx, _) = broadcast::channel::<TauriEvent>(100);
    let event_tx = Arc::new(event_tx);

    // Setup Tauri event listeners to forward all events to SSE clients
    // List of all events emitted by the application
    // Forward the same events emitted by the native Tauri runtime to SSE clients so
    // the web (headless) UI can receive the same updates as the desktop runtime.
    // Keep this list in sync with `src/app/shared/types/events.ts` and
    // `src-tauri/src/utils/types/events.rs`.
    let events_to_forward = vec![
        // Core
        RCLONE_API_URL_UPDATED,
        ENGINE_RESTARTED,
        // RClone engine
        RCLONE_ENGINE_READY,
        RCLONE_ENGINE_ERROR,
        RCLONE_ENGINE_PASSWORD_ERROR,
        RCLONE_ENGINE_PATH_ERROR,
        RCLONE_ENGINE_UPDATING,
        RCLONE_PASSWORD_STORED,
        // Remote management & state changes
        REMOTE_STATE_CHANGED,
        REMOTE_PRESENCE_CHANGED,
        REMOTE_CACHE_UPDATED,
        // System & settings
        SYSTEM_SETTINGS_CHANGED,
        BANDWIDTH_LIMIT_CHANGED,
        RCLONE_CONFIG_UNLOCKED,
        // UI & cache events
        UPDATE_TRAY_MENU,
        JOB_CACHE_CHANGED,
        MOUNT_STATE_CHANGED,
        SERVE_STATE_CHANGED,
        // Plugins / installs
        MOUNT_PLUGIN_INSTALLED,
        // Network
        NETWORK_STATUS_CHANGED,
        // Scheduled tasks
        SCHEDULED_TASK_ERROR,
        SCHEDULED_TASK_COMPLETED,
        SCHEDULED_TASK_STOPPED,
        // App wide events
        APP_EVENT,
        // Open Internal Route
        OPEN_INTERNAL_ROUTE,
    ];

    for event_name in events_to_forward {
        let event_tx_for_listener = event_tx.clone();
        let event_name_owned = event_name.to_string();
        app_handle.listen(event_name, move |event| {
            let payload_str = event.payload();
            let payload_val: serde_json::Value = match serde_json::from_str(payload_str) {
                Ok(v) => v,
                Err(_) => serde_json::Value::String(payload_str.to_string()),
            };

            let tauri_event = TauriEvent {
                event: event_name_owned.clone(),
                payload: payload_val,
            };

            let _ = event_tx_for_listener.send(tauri_event);
        });
    }

    // Encode credentials for Basic Authentication
    // Basic Auth expects base64(username:password)
    let encoded_auth = auth_credentials.map(|(username, password)| {
        use base64::{Engine as _, engine::general_purpose::STANDARD};
        let credentials = format!("{}:{}", username, password);
        let encoded = STANDARD.encode(credentials.as_bytes());
        (username, encoded)
    });

    let state = WebServerState {
        app_handle: app_handle.clone(),
        event_tx,
        auth_credentials: encoded_auth,
    };

    // Determine the path to serve static files from
    // Try multiple locations in priority order
    let static_dir = {
        // 1. Try Tauri Resources directory first (for installed app)
        let resource_path = app_handle
            .path()
            .resolve("browser", BaseDirectory::Resource);
        info!("Looking for static files in resources: {:?}", resource_path);

        if let Ok(path) = resource_path {
            if path.exists() {
                info!("✅ Found static files in resources: {}", path.display());
                Some(path)
            } else {
                // 2. Try Docker installation path (for containerized deployments)
                let docker_path =
                    std::path::PathBuf::from("/usr/lib/rclone-manager-headless/browser");
                if docker_path.exists() {
                    info!(
                        "✅ Found static files in Docker path: {}",
                        docker_path.display()
                    );
                    Some(docker_path)
                } else {
                    // 3. Try local development directory
                    let local_dist = std::path::PathBuf::from("dist/rclone-manager/browser");
                    if local_dist.exists() {
                        info!(
                            "✅ Found static files in current directory: {}",
                            local_dist.display()
                        );
                        Some(local_dist)
                    } else {
                        // 4. Try relative path from executable (development fallback)
                        std::env::current_exe()
                            .ok()
                            .and_then(|exe_path| exe_path.parent().map(|p| p.to_path_buf()))
                            .and_then(|exe_dir| {
                                let dist_path =
                                    exe_dir.join("../../../dist/rclone-manager/browser");
                                if dist_path.exists() {
                                    info!(
                                        "✅ Found static files relative to executable: {}",
                                        dist_path.display()
                                    );
                                    Some(dist_path)
                                } else {
                                    None
                                }
                            })
                    }
                }
            }
        } else {
            None
        }
    };
    // Build jobs sub-router
    let jobs_router = Router::new()
        .route("/", get(get_jobs_handler))
        .route("/active", get(get_active_jobs_handler))
        .route("/stop", post(stop_job_handler))
        .route("/delete", post(delete_job_handler))
        .route("/start-sync-profile", post(start_sync_profile_handler))
        .route("/start-copy-profile", post(start_copy_profile_handler))
        .route("/start-move-profile", post(start_move_profile_handler))
        .route("/start-bisync-profile", post(start_bisync_profile_handler))
        .route("/:id/status", get(get_job_status_handler))
        .with_state(state.clone());

    // Build API router
    let api_router = Router::new()
        .merge(remote_routes())
        .merge(system_routes())
        .merge(file_operations_routes())
        .merge(settings_routes())
        .merge(mount_serve_routes())
        .merge(scheduled_tasks_routes())
        .merge(flags_routes())
        .merge(security_routes())
        .merge(logs_routes())
        .merge(vfs_routes())
        .merge(backup_routes())
        .nest("/jobs", jobs_router)
        .route("/events", get(sse_handler))
        .route("/get-bisync-flags", get(get_bisync_flags_handler))
        .route("/get-move-flags", get(get_move_flags_handler))
        .with_state(state.clone())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ));

    // Configure CORS to allow requests from localhost and 127.0.0.1
    let mut allowed_origins = vec![
        format!("http://localhost:{}", port).parse().unwrap(),
        format!("http://127.0.0.1:{}", port).parse().unwrap(),
    ];
    if host != "0.0.0.0" && host != "127.0.0.1" && host != "localhost" {
        if let Ok(origin) = format!("http://{}:{}", host, port).parse() {
            allowed_origins.push(origin);
        }
    }

    // In development mode, also allow the Angular dev server (port 1420)
    #[cfg(debug_assertions)]
    {
        let dev_port = std::env::var("TAURI_DEV_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(1420);
        info!(
            "🔧 Development mode: allowing Angular dev server on port {}",
            dev_port
        );
        allowed_origins.push(format!("http://localhost:{}", dev_port).parse().unwrap());
        allowed_origins.push(format!("http://127.0.0.1:{}", dev_port).parse().unwrap());
    }
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(allowed_origins))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            axum::http::header::AUTHORIZATION,
            axum::http::header::CONTENT_TYPE,
            axum::http::header::ACCEPT,
        ])
        .expose_headers([axum::http::header::WWW_AUTHENTICATE])
        .allow_credentials(true);

    // Build main router
    let mut app = Router::new()
        .route("/health", get(health_handler))
        .nest("/api", api_router)
        .layer(cors)
        .layer(tower_http::trace::TraceLayer::new_for_http());

    // Add static file serving if directory exists
    if let Some(static_path) = static_dir {
        info!("📁 Serving static files from: {}", static_path.display());
        use tower_http::services::ServeDir;
        app = app.fallback_service(ServeDir::new(static_path));
    } else {
        info!("⚠️  No static files found. Build Angular app with: npm run build:headless");
        app = app.route("/", get(root_handler));
    }

    let addr = format!("{}:{}", host, port).parse()?;

    // Check if TLS args are provided
    if let (Some(cert), Some(key)) = (tls_cert, tls_key) {
        info!("🔒 SSL/TLS Enabled");
        info!("📜 Certificate: {:?}", cert);
        info!("🔑 Key: {:?}", key);
        info!("🌍 Secure Server listening on https://{}", addr);

        // Load the certificate and key
        let config = RustlsConfig::from_pem_file(cert, key)
            .await
            .map_err(|e| format!("Failed to load TLS config: {}", e))?;

        // Start HTTPS Server
        axum_server::bind_rustls(addr, config)
            .serve(app.into_make_service())
            .await?;
    } else {
        // Fallback to Standard HTTP
        info!("⚠️  TLS keys not provided - Running in INSECURE HTTP mode");
        info!("🌍 Server listening on http://{}", addr);

        // Start HTTP Server
        axum_server::bind(addr)
            .serve(app.into_make_service())
            .await?;
    }

    Ok(())
}

// ============================================================================
// Route Handlers
// ============================================================================

async fn root_handler() -> &'static str {
    "RClone Manager Headless API Server"
}

async fn health_handler() -> Json<ApiResponse<String>> {
    Json(ApiResponse::success("OK".to_string()))
}

async fn get_remotes_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<Vec<String>>>, AppError> {
    use crate::rclone::state::cache::get_cached_remotes;
    let cache = state.app_handle.state::<RemoteCache>();
    let remotes = get_cached_remotes(cache)
        .await
        .map_err(anyhow::Error::msg)?;
    info!("Fetched remotes: {:?}", remotes);
    Ok(Json(ApiResponse::success(remotes)))
}

#[derive(Deserialize)]
struct RemoteNameQuery {
    name: String,
}

async fn get_remote_config_handler(
    State(state): State<WebServerState>,
    Query(query): Query<RemoteNameQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_remote_config;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let config = get_remote_config(query.name, rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(config)))
}

async fn get_remote_types_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_remote_types;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let types = get_remote_types(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_types = serde_json::to_value(types)?;
    Ok(Json(ApiResponse::success(json_types)))
}

async fn get_stats_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_core_stats;

    let rclone_state = state.app_handle.state::<RcloneState>();

    let stats = get_core_stats(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(stats)))
}

async fn get_core_stats_filtered_handler(
    State(state): State<WebServerState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::stats::get_core_stats_filtered;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let jobid = params.get("jobid").and_then(|s| s.parse::<u64>().ok());

    let group = params.get("group").cloned();

    let value = get_core_stats_filtered(rclone_state, jobid, group)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

async fn get_completed_transfers_handler(
    State(state): State<WebServerState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::stats::get_completed_transfers;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let group = params.get("group").cloned();

    let value = get_completed_transfers(rclone_state, group)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

async fn get_jobs_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::state::job::get_jobs;
    let job_cache = state.app_handle.state::<JobCache>();
    let jobs = get_jobs(job_cache).await.map_err(anyhow::Error::msg)?;
    let json_jobs = serde_json::to_value(jobs)?;
    Ok(Json(ApiResponse::success(json_jobs)))
}

async fn get_active_jobs_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::state::job::get_active_jobs;
    let job_cache = state.app_handle.state::<JobCache>();

    let active_jobs = get_active_jobs(job_cache)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_active_jobs = serde_json::to_value(active_jobs)?;
    Ok(Json(ApiResponse::success(json_active_jobs)))
}

#[derive(Deserialize)]
struct JobStatusQuery {
    jobid: u64,
}

async fn get_job_status_handler(
    State(state): State<WebServerState>,
    Query(query): Query<JobStatusQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::state::job::get_job_status;

    let job_cache = state.app_handle.state::<JobCache>();

    let opt = get_job_status(job_cache, query.jobid)
        .await
        .map_err(anyhow::Error::msg)?;
    let json = match opt {
        Some(j) => serde_json::to_value(j)?,
        None => serde_json::Value::Null,
    };
    Ok(Json(ApiResponse::success(json)))
}

#[derive(Deserialize)]
struct StopJobBody {
    jobid: u64,
    #[serde(rename = "remoteName")]
    remote_name: String,
}

async fn stop_job_handler(
    State(state): State<WebServerState>,
    Json(body): Json<StopJobBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::commands::job::stop_job;

    let job_cache = state.app_handle.state::<JobCache>();
    let scheduled_cache = state.app_handle.state::<ScheduledTasksCache>();
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    stop_job(
        state.app_handle.clone(),
        job_cache,
        scheduled_cache,
        body.jobid,
        body.remote_name,
        rclone_state,
    )
    .await
    .map_err(anyhow::Error::msg)?;

    Ok(Json(ApiResponse::success(
        "Job stopped successfully".to_string(),
    )))
}

#[derive(Deserialize)]
struct DeleteJobBody {
    jobid: u64,
}

async fn delete_job_handler(
    State(state): State<WebServerState>,
    Json(body): Json<DeleteJobBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::state::job::delete_job;

    let job_cache = state.app_handle.state::<JobCache>();

    delete_job(job_cache, body.jobid)
        .await
        .map_err(anyhow::Error::msg)?;

    Ok(Json(ApiResponse::success(
        "Job deleted successfully".to_string(),
    )))
}

/// Body for profile-based commands from frontend
/// Frontend sends: { "params": { "remote_name": "...", "profile_name": "..." } }
#[derive(Deserialize)]
struct ProfileParamsBody {
    params: ProfileParamsInner,
}

#[derive(Deserialize)]
struct ProfileParamsInner {
    remote_name: String,
    profile_name: String,
}

async fn start_sync_profile_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ProfileParamsBody>,
) -> Result<Json<ApiResponse<u64>>, AppError> {
    use crate::rclone::commands::sync::start_sync_profile;

    let params = ProfileParams {
        remote_name: body.params.remote_name,
        profile_name: body.params.profile_name,
    };

    let job_cache = state.app_handle.state::<JobCache>();
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let jobid = start_sync_profile(state.app_handle.clone(), job_cache, rclone_state, params)
        .await
        .map_err(anyhow::Error::msg)?;

    Ok(Json(ApiResponse::success(jobid)))
}

async fn start_copy_profile_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ProfileParamsBody>,
) -> Result<Json<ApiResponse<u64>>, AppError> {
    use crate::rclone::commands::sync::start_copy_profile;

    let params = ProfileParams {
        remote_name: body.params.remote_name,
        profile_name: body.params.profile_name,
    };

    let job_cache = state.app_handle.state::<JobCache>();
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let jobid = start_copy_profile(state.app_handle.clone(), job_cache, rclone_state, params)
        .await
        .map_err(anyhow::Error::msg)?;

    Ok(Json(ApiResponse::success(jobid)))
}

async fn start_move_profile_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ProfileParamsBody>,
) -> Result<Json<ApiResponse<u64>>, AppError> {
    use crate::rclone::commands::sync::start_move_profile;

    let params = ProfileParams {
        remote_name: body.params.remote_name,
        profile_name: body.params.profile_name,
    };

    let job_cache = state.app_handle.state::<JobCache>();
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let jobid = start_move_profile(state.app_handle.clone(), job_cache, rclone_state, params)
        .await
        .map_err(anyhow::Error::msg)?;

    Ok(Json(ApiResponse::success(jobid)))
}

async fn start_bisync_profile_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ProfileParamsBody>,
) -> Result<Json<ApiResponse<u64>>, AppError> {
    use crate::rclone::commands::sync::start_bisync_profile;

    let params = ProfileParams {
        remote_name: body.params.remote_name,
        profile_name: body.params.profile_name,
    };

    let job_cache = state.app_handle.state::<JobCache>();
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let jobid = start_bisync_profile(state.app_handle.clone(), job_cache, rclone_state, params)
        .await
        .map_err(anyhow::Error::msg)?;

    Ok(Json(ApiResponse::success(jobid)))
}

async fn get_mounted_remotes_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_mounted_remotes;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let remotes = get_mounted_remotes(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_remotes = serde_json::to_value(remotes)?;
    Ok(Json(ApiResponse::success(json_remotes)))
}

async fn get_settings_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::state::cache::get_settings;
    let cache = state.app_handle.state::<RemoteCache>();
    let settings = get_settings(cache).await.map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(settings)))
}

async fn load_settings_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::core::settings::operations::core::load_settings;

    let settings_state: tauri::State<crate::utils::types::settings::SettingsState<tauri::Wry>> =
        state.app_handle.state();

    let settings = load_settings(settings_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_settings = serde_json::to_value(settings)?;
    Ok(Json(ApiResponse::success(json_settings)))
}

async fn get_rclone_info_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_rclone_info;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let info = get_rclone_info(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_info = serde_json::to_value(info)?;
    Ok(Json(ApiResponse::success(json_info)))
}

async fn get_rclone_pid_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_rclone_pid;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let pid = get_rclone_pid(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_pid = serde_json::to_value(pid)?;
    Ok(Json(ApiResponse::success(json_pid)))
}

async fn get_rclone_rc_url_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::state::engine::get_rclone_rc_url;

    let url = get_rclone_rc_url();
    Ok(Json(ApiResponse::success(url)))
}

async fn get_memory_stats_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_memory_stats;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let stats = get_memory_stats(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_stats = serde_json::to_value(stats)?;
    Ok(Json(ApiResponse::success(json_stats)))
}

async fn get_bandwidth_limit_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<crate::utils::types::all_types::BandwidthLimitResponse>>, AppError> {
    use crate::rclone::queries::get_bandwidth_limit;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let limit = get_bandwidth_limit(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(limit)))
}

#[derive(Deserialize)]
struct FsInfoQuery {
    remote: String,
    path: Option<String>,
}

async fn get_fs_info_handler(
    State(state): State<WebServerState>,
    Query(query): Query<FsInfoQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_fs_info;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let info = get_fs_info(query.remote, query.path, rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(info)))
}

#[derive(Deserialize)]
struct DiskUsageQuery {
    remote: String,
    path: Option<String>,
}

async fn get_disk_usage_handler(
    State(state): State<WebServerState>,
    Query(query): Query<DiskUsageQuery>,
) -> Result<Json<ApiResponse<crate::utils::types::all_types::DiskUsage>>, AppError> {
    use crate::rclone::queries::get_disk_usage;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let usage = get_disk_usage(query.remote, query.path, rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(usage)))
}

async fn get_local_drives_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<Vec<crate::rclone::queries::filesystem::LocalDrive>>>, AppError> {
    use crate::rclone::queries::filesystem::get_local_drives;

    let drives = get_local_drives().await.map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(drives)))
}

#[derive(Deserialize)]
struct GetSizeQuery {
    remote: String,
    path: Option<String>,
}

async fn get_size_handler(
    State(state): State<WebServerState>,
    Query(query): Query<GetSizeQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::filesystem::get_size;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let result = get_size(query.remote, query.path, rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize)]
struct MkdirBody {
    remote: String,
    path: String,
}

async fn mkdir_handler(
    State(state): State<WebServerState>,
    Json(body): Json<MkdirBody>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    use crate::rclone::commands::filesystem::mkdir;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    mkdir(body.remote, body.path, rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(())))
}

#[derive(Deserialize)]
struct CleanupBody {
    remote: String,
    path: Option<String>,
}

async fn cleanup_handler(
    State(state): State<WebServerState>,
    Json(body): Json<CleanupBody>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    use crate::rclone::commands::filesystem::cleanup;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    cleanup(body.remote, body.path, rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(())))
}

#[derive(Deserialize)]
struct CopyUrlBody {
    remote: String,
    path: String,
    #[serde(rename = "urlToCopy")]
    url_to_copy: String,
    #[serde(rename = "autoFilename")]
    auto_filename: bool,
}

async fn copy_url_handler(
    State(state): State<WebServerState>,
    Json(body): Json<CopyUrlBody>,
) -> Result<Json<ApiResponse<u64>>, AppError> {
    use crate::rclone::commands::filesystem::copy_url;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let jobid = copy_url(
        state.app_handle.clone(),
        rclone_state,
        body.remote,
        body.path,
        body.url_to_copy,
        body.auto_filename,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(jobid)))
}

#[derive(Deserialize)]
struct RemotePathsBody {
    remote: String,
    path: Option<String>,
    options: Option<serde_json::Value>,
}

async fn get_remote_paths_handler(
    State(state): State<WebServerState>,
    Json(body): Json<RemotePathsBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_remote_paths;
    use crate::utils::types::all_types::ListOptions;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let options = body.options.map(|v| {
        // Try to deserialize into ListOptions
        serde_json::from_value::<ListOptions>(v).unwrap_or(ListOptions {
            extra: std::collections::HashMap::new(),
        })
    });

    let value = get_remote_paths(body.remote, body.path, options, rclone_state)
        .await
        .map_err(anyhow::Error::msg)
        .map_err(AppError::BadRequest)?;
    Ok(Json(ApiResponse::success(value)))
}

#[derive(Deserialize)]
struct ConvertFileSrcQuery {
    path: String,
}

async fn convert_file_src_handler(
    State(state): State<WebServerState>,
    Query(query): Query<ConvertFileSrcQuery>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::queries::filesystem::convert_file_src;

    let url = convert_file_src(state.app_handle.clone(), query.path)
        .map_err(anyhow::Error::msg)
        .map_err(AppError::BadRequest)?;
    Ok(Json(ApiResponse::success(url)))
}

#[derive(Deserialize)]
struct SaveRemoteSettingsBody {
    #[serde(rename = "remoteName")]
    remote_name: String,
    settings: serde_json::Value,
}

async fn save_remote_settings_handler(
    State(state): State<WebServerState>,
    Json(body): Json<SaveRemoteSettingsBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::remote::manager::save_remote_settings;

    let settings_state: tauri::State<crate::utils::types::settings::SettingsState<tauri::Wry>> =
        state.app_handle.state();
    let task_cache = state.app_handle.state::<ScheduledTasksCache>();
    let cron_cache = state.app_handle.state::<CronScheduler>();

    save_remote_settings(
        body.remote_name,
        body.settings,
        settings_state,
        task_cache,
        cron_cache,
        state.app_handle.clone(),
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Remote settings saved successfully".to_string(),
    )))
}

async fn is_network_metered_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    use crate::utils::io::network::is_network_metered;

    let metered = is_network_metered();
    Ok(Json(ApiResponse::success(metered)))
}

#[derive(Deserialize)]
struct CheckRcloneAvailableQuery {
    path: Option<String>,
}

async fn check_rclone_available_handler(
    State(state): State<WebServerState>,
    Query(query): Query<CheckRcloneAvailableQuery>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    use crate::core::check_binaries::check_rclone_available;

    let path = query.path.as_deref().unwrap_or("");
    let available = check_rclone_available(state.app_handle.clone(), path)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(available)))
}

async fn check_mount_plugin_installed_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    use crate::utils::rclone::mount::check_mount_plugin_installed;

    let installed = check_mount_plugin_installed();
    Ok(Json(ApiResponse::success(installed)))
}

#[derive(Deserialize)]
struct KillProcessByPidQuery {
    pid: u32,
}

async fn kill_process_by_pid_handler(
    State(_state): State<WebServerState>,
    Query(query): Query<KillProcessByPidQuery>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::utils::process::process_manager::kill_process_by_pid;

    kill_process_by_pid(query.pid).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(format!(
        "Process {} killed successfully",
        query.pid
    ))))
}

#[derive(Deserialize)]
struct SaveSettingBody {
    category: String,
    key: String,
    value: serde_json::Value,
}

async fn save_setting_handler(
    State(state): State<WebServerState>,
    Json(body): Json<SaveSettingBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::operations::core::save_setting;

    let settings_state: tauri::State<crate::utils::types::settings::SettingsState<tauri::Wry>> =
        state.app_handle.state();

    save_setting(
        body.category,
        body.key,
        body.value,
        settings_state,
        state.app_handle.clone(),
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Setting saved successfully".to_string(),
    )))
}

#[derive(Deserialize)]
struct ResetSettingBody {
    category: String,
    key: String,
}

async fn reset_setting_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ResetSettingBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::core::settings::operations::core::reset_setting;

    let settings_state: tauri::State<crate::utils::types::settings::SettingsState<tauri::Wry>> =
        state.app_handle.state();

    let default_value = reset_setting(
        body.category,
        body.key,
        settings_state,
        state.app_handle.clone(),
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(default_value)))
}

async fn check_links_handler(
    State(_state): State<WebServerState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::utils::io::network::check_links;

    // Extract links from query parameters (multiple 'links' parameters)
    let links: Vec<String> = params
        .iter()
        .filter(|(key, _)| key == &"links")
        .map(|(_, value)| value.clone())
        .collect();

    if links.is_empty() {
        return Err(AppError::BadRequest(anyhow::anyhow!("No links provided")));
    }

    let max_retries = params
        .get("maxRetries")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(2);

    let retry_delay_secs = params
        .get("retryDelaySecs")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(3);

    let result = check_links(links, max_retries, retry_delay_secs)
        .await
        .map_err(anyhow::Error::msg)?;

    // Convert CheckResult to JSON value
    let json_result = serde_json::to_value(result).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_result)))
}

#[derive(Deserialize)]
struct CheckRcloneUpdateQuery {
    channel: Option<String>,
}

async fn check_rclone_update_handler(
    State(state): State<WebServerState>,
    Query(query): Query<CheckRcloneUpdateQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::utils::rclone::updater::check_rclone_update;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let result = check_rclone_update(state.app_handle.clone(), rclone_state, query.channel)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize)]
struct UpdateRcloneQuery {
    channel: Option<String>,
}

async fn update_rclone_handler(
    State(state): State<WebServerState>,
    Query(query): Query<UpdateRcloneQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::utils::rclone::updater::update_rclone;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let result = update_rclone(rclone_state, state.app_handle.clone(), query.channel)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize)]
struct ProvisionRcloneQuery {
    path: Option<String>,
}

async fn provision_rclone_handler(
    State(state): State<WebServerState>,
    Query(query): Query<ProvisionRcloneQuery>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::utils::rclone::provision::provision_rclone;

    // Treat "null" string as None
    let path = query.path.filter(|p| p != "null");

    let message = provision_rclone(state.app_handle.clone(), path)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(message)))
}

#[derive(Deserialize)]
struct ValidateCronQuery {
    #[serde(rename = "cronExpression")]
    cron_expression: String,
}

async fn validate_cron_handler(
    State(_state): State<WebServerState>,
    Query(query): Query<ValidateCronQuery>,
) -> Result<Json<ApiResponse<CronValidationResponse>>, AppError> {
    let result = validate_cron(query.cron_expression)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

async fn get_cached_mounted_remotes_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::state::cache::get_cached_mounted_remotes;
    let cache = state.app_handle.state::<RemoteCache>();
    let mounted_remotes = get_cached_mounted_remotes(cache)
        .await
        .map_err(anyhow::Error::msg)?;

    // Convert to JSON value
    let json_mounted_remotes = serde_json::to_value(mounted_remotes).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_mounted_remotes)))
}

async fn get_cached_serves_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::state::cache::get_cached_serves;
    let cache = state.app_handle.state::<RemoteCache>();
    let serves = get_cached_serves(cache).await.map_err(anyhow::Error::msg)?;

    // Convert to JSON value
    let json_serves = serde_json::to_value(serves).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_serves)))
}

async fn start_serve_profile_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ProfileParamsBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::commands::serve::start_serve_profile;

    let params = ProfileParams {
        remote_name: body.params.remote_name,
        profile_name: body.params.profile_name,
    };

    let resp = start_serve_profile(state.app_handle.clone(), params)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        serde_json::to_value(resp).unwrap(),
    )))
}

#[derive(Deserialize)]
struct StopServeBody {
    #[serde(rename = "serverId")]
    server_id: String,
    #[serde(rename = "remoteName")]
    remote_name: String,
}

async fn stop_serve_handler(
    State(state): State<WebServerState>,
    Json(body): Json<StopServeBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::commands::serve::stop_serve;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let msg = stop_serve(
        state.app_handle.clone(),
        body.server_id,
        body.remote_name,
        rclone_state,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(msg)))
}

async fn handle_shutdown_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    // Spawn shutdown task so we can return a response to the HTTP client.
    let app_handle = state.app_handle.clone();
    tokio::spawn(async move {
        handle_shutdown(app_handle).await;
    });

    Ok(Json(ApiResponse::success("Shutdown initiated".to_string())))
}

async fn get_configs_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::state::cache::get_configs;
    let cache = state.app_handle.state::<RemoteCache>();
    let configs = get_configs(cache).await.map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(configs)))
}

#[derive(Deserialize)]
struct ReloadScheduledTasksBody {
    remote_configs: serde_json::Value,
}

async fn reload_scheduled_tasks_from_configs_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ReloadScheduledTasksBody>,
) -> Result<Json<ApiResponse<usize>>, AppError> {
    use crate::rclone::state::scheduled_tasks::reload_scheduled_tasks_from_configs;

    let cache = state.app_handle.state::<ScheduledTasksCache>();
    let scheduler = state.app_handle.state::<CronScheduler>();

    let count = reload_scheduled_tasks_from_configs(cache, scheduler, body.remote_configs)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(count)))
}

async fn get_scheduled_tasks_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::state::scheduled_tasks::get_scheduled_tasks;

    let cache = state.app_handle.state::<ScheduledTasksCache>();

    let tasks = get_scheduled_tasks(cache)
        .await
        .map_err(anyhow::Error::msg)?;

    // Convert to JSON value
    let json_tasks = serde_json::to_value(tasks).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_tasks)))
}

#[derive(Deserialize)]
struct ToggleScheduledTaskBody {
    #[serde(rename = "taskId")]
    task_id: String,
}

async fn toggle_scheduled_task_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ToggleScheduledTaskBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::core::scheduler::commands::toggle_scheduled_task;

    let cache = state.app_handle.state::<ScheduledTasksCache>();
    let scheduler = state.app_handle.state::<CronScheduler>();

    let task = toggle_scheduled_task(cache, scheduler, body.task_id)
        .await
        .map_err(anyhow::Error::msg)?;

    // Convert to JSON value
    let json_task = serde_json::to_value(task).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_task)))
}

async fn get_scheduled_tasks_stats_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::state::scheduled_tasks::get_scheduled_tasks_stats;

    let cache = state.app_handle.state::<ScheduledTasksCache>();

    let stats = get_scheduled_tasks_stats(cache)
        .await
        .map_err(anyhow::Error::msg)?;

    // Convert to JSON value
    let json_stats = serde_json::to_value(stats).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_stats)))
}

/// SSE endpoint for streaming Tauri events to web clients
async fn sse_handler(
    State(state): State<WebServerState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let mut rx = state.event_tx.subscribe();

    let stream = async_stream::stream! {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    // Serialize the event to JSON
                    let data = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
                    // Send data as the default message type so the browser `EventSource.onmessage`
                    // handler receives all events (frontend SseClientService uses `onmessage`).
                    // The JSON payload still contains the event name so frontend can dispatch.
                    yield Ok(Event::default().data(data));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    // Handle lagged receiver (channel full)
                    yield Ok(Event::default()
                        .event("error")
                        .data("{\"error\":\"event stream lagged\"}"));
                }
                Err(broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    };

    info!("📡 New SSE client connected");
    Sse::new(stream).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("keep-alive"),
    )
}

async fn mount_remote_profile_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ProfileParamsBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::commands::mount::mount_remote_profile;

    let params = ProfileParams {
        remote_name: body.params.remote_name,
        profile_name: body.params.profile_name,
    };

    let remote_cache = state.app_handle.state::<RemoteCache>();

    mount_remote_profile(state.app_handle.clone(), remote_cache, params)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Remote mounted successfully".to_string(),
    )))
}

async fn unmount_remote_handler(
    State(state): State<WebServerState>,
    Json(body): Json<UnmountRemoteBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::commands::mount::unmount_remote;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let message = unmount_remote(
        state.app_handle.clone(),
        body.mount_point,
        body.remote_name,
        rclone_state,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(message)))
}

#[derive(Deserialize)]
struct UnmountRemoteBody {
    #[serde(rename = "mountPoint")]
    mount_point: String,
    #[serde(rename = "remoteName")]
    remote_name: String,
}

async fn get_grouped_options_with_values_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_grouped_options_with_values;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let options = get_grouped_options_with_values(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(options)))
}

async fn get_mount_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_mount_flags;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let flags = get_mount_flags(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

async fn get_copy_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_copy_flags;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let flags = get_copy_flags(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

async fn get_sync_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_sync_flags;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let flags = get_sync_flags(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

async fn get_bisync_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_bisync_flags;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let flags = get_bisync_flags(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

async fn get_move_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_move_flags;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let flags = get_move_flags(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

async fn get_filter_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_filter_flags;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let flags = get_filter_flags(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

async fn get_vfs_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_vfs_flags;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let flags = get_vfs_flags(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

async fn get_backend_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_backend_flags;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let flags = get_backend_flags(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_flags = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_flags)))
}

async fn save_rclone_backend_option_handler(
    State(state): State<WebServerState>,
    Json(body): Json<SaveRCloneBackendOptionBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::rclone_backend::save_rclone_backend_option;

    save_rclone_backend_option(
        state.app_handle.clone(),
        body.block,
        body.option,
        body.value,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "RClone backend option saved successfully".to_string(),
    )))
}

#[derive(Deserialize)]
struct SaveRCloneBackendOptionBody {
    block: String,
    option: String,
    value: serde_json::Value,
}

async fn set_rclone_option_handler(
    State(state): State<WebServerState>,
    Json(body): Json<SetRCloneOptionBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::set_rclone_option;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let result = set_rclone_option(rclone_state, body.block_name, body.option_name, body.value)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize)]
struct SetRCloneOptionBody {
    #[serde(rename = "blockName")]
    block_name: String,
    #[serde(rename = "optionName")]
    option_name: String,
    value: serde_json::Value,
}

async fn remove_rclone_backend_option_handler(
    State(state): State<WebServerState>,
    Json(body): Json<RemoveRCloneBackendOptionBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::rclone_backend::remove_rclone_backend_option;

    remove_rclone_backend_option(state.app_handle.clone(), body.block, body.option)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "RClone backend option removed successfully".to_string(),
    )))
}

#[derive(Deserialize)]
struct RemoveRCloneBackendOptionBody {
    block: String,
    option: String,
}

async fn get_oauth_supported_remotes_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_oauth_supported_remotes;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let remotes = get_oauth_supported_remotes(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;

    // Convert to JSON value
    let json_remotes = serde_json::to_value(remotes).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_remotes)))
}

async fn get_cached_remotes_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<Vec<String>>>, AppError> {
    use crate::rclone::state::cache::get_cached_remotes;
    let cache = state.app_handle.state::<RemoteCache>();
    let remotes = get_cached_remotes(cache)
        .await
        .map_err(anyhow::Error::msg)?;
    info!("Fetched cached remotes: {:?}", remotes);
    Ok(Json(ApiResponse::success(remotes)))
}

#[derive(Deserialize)]
struct CreateRemoteBody {
    name: String,
    parameters: serde_json::Value,
}

async fn create_remote_handler(
    State(state): State<WebServerState>,
    Json(body): Json<CreateRemoteBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    create_remote(
        state.app_handle.clone(),
        body.name,
        body.parameters,
        rclone_state,
    )
    .await
    .map_err(anyhow::Error::msg)?;

    Ok(Json(ApiResponse::success(
        "Remote created successfully".to_string(),
    )))
}

#[derive(Deserialize)]
struct CreateRemoteInteractiveBody {
    name: String,
    #[serde(rename = "rclone_type")]
    rclone_type: Option<String>,
    #[serde(rename = "rcloneType")]
    rclone_type_alt: Option<String>,
    parameters: Option<serde_json::Value>,
    opt: Option<serde_json::Value>,
}

async fn create_remote_interactive_handler(
    State(state): State<WebServerState>,
    Json(body): Json<CreateRemoteInteractiveBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::commands::remote::create_remote_interactive;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let rclone_type = body
        .rclone_type
        .clone()
        .or(body.rclone_type_alt.clone())
        .unwrap_or_else(|| "".to_string());

    let value = create_remote_interactive(
        state.app_handle.clone(),
        body.name,
        rclone_type,
        body.parameters,
        body.opt,
        rclone_state,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

#[derive(Deserialize)]
struct ContinueCreateRemoteInteractiveBody {
    name: String,
    #[serde(rename = "state_token")]
    state_token: Option<String>,
    #[serde(rename = "stateToken")]
    state_token_alt: Option<String>,
    result: serde_json::Value,
    parameters: Option<serde_json::Value>,
    opt: Option<serde_json::Value>,
}

async fn continue_create_remote_interactive_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ContinueCreateRemoteInteractiveBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::commands::remote::continue_create_remote_interactive;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let state_token = body
        .state_token
        .clone()
        .or(body.state_token_alt.clone())
        .unwrap_or_else(|| "".to_string());

    let value = continue_create_remote_interactive(
        state.app_handle.clone(),
        body.name,
        state_token,
        body.result,
        body.parameters,
        body.opt,
        rclone_state,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

async fn quit_rclone_oauth_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::commands::system::quit_rclone_oauth;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    quit_rclone_oauth(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "RClone OAuth process quit successfully".to_string(),
    )))
}

async fn get_cached_encryption_status_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<Option<bool>>>, (StatusCode, Json<ApiResponse<Option<bool>>>)> {
    use crate::core::security::commands::get_cached_encryption_status;

    let status = get_cached_encryption_status();
    Ok(Json(ApiResponse::success(status)))
}

async fn has_stored_password_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    use crate::core::security::commands::has_stored_password;

    let credential_store = state
        .app_handle
        .state::<crate::core::security::CredentialStore>();

    let has_password = has_stored_password(credential_store)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(has_password)))
}

async fn is_config_encrypted_cached_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    use crate::core::security::commands::is_config_encrypted_cached;

    let is_encrypted = is_config_encrypted_cached(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(is_encrypted)))
}

async fn has_config_password_env_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    use crate::core::security::commands::has_config_password_env;

    let env_manager = state
        .app_handle
        .state::<crate::core::security::SafeEnvironmentManager>();

    let has_password = has_config_password_env(env_manager)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(has_password)))
}

async fn remove_config_password_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::security::commands::remove_config_password;

    let env_manager = state
        .app_handle
        .state::<crate::core::security::SafeEnvironmentManager>();
    let credential_store = state
        .app_handle
        .state::<crate::core::security::CredentialStore>();

    remove_config_password(env_manager, credential_store)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Password removed successfully".to_string(),
    )))
}

#[derive(Deserialize)]
struct ValidateRclonePasswordQuery {
    password: String,
}

async fn validate_rclone_password_handler(
    State(state): State<WebServerState>,
    Query(query): Query<ValidateRclonePasswordQuery>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::security::commands::validate_rclone_password;

    validate_rclone_password(state.app_handle.clone(), query.password)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Password validation successful".to_string(),
    )))
}

#[derive(Deserialize)]
struct StoreConfigPasswordBody {
    password: String,
}

async fn store_config_password_handler(
    State(state): State<WebServerState>,
    Json(body): Json<StoreConfigPasswordBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::security::commands::store_config_password;

    let env_manager = state
        .app_handle
        .state::<crate::core::security::SafeEnvironmentManager>();
    let credential_store = state
        .app_handle
        .state::<crate::core::security::CredentialStore>();

    store_config_password(
        state.app_handle.clone(),
        env_manager,
        credential_store,
        body.password,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Password stored successfully".to_string(),
    )))
}

#[derive(Deserialize)]
struct UnencryptConfigBody {
    password: String,
}

async fn unencrypt_config_handler(
    State(state): State<WebServerState>,
    Json(body): Json<UnencryptConfigBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::security::commands::unencrypt_config;

    let env_manager = state
        .app_handle
        .state::<crate::core::security::SafeEnvironmentManager>();

    unencrypt_config(state.app_handle.clone(), env_manager, body.password)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Configuration unencrypted successfully".to_string(),
    )))
}

#[derive(Deserialize)]
struct EncryptConfigBody {
    password: String,
}

async fn encrypt_config_handler(
    State(state): State<WebServerState>,
    Json(body): Json<EncryptConfigBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::security::commands::encrypt_config;

    let env_manager = state
        .app_handle
        .state::<crate::core::security::SafeEnvironmentManager>();
    let credential_store = state
        .app_handle
        .state::<crate::core::security::CredentialStore>();

    encrypt_config(
        state.app_handle.clone(),
        env_manager,
        credential_store,
        body.password,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Configuration encrypted successfully".to_string(),
    )))
}

async fn get_mount_types_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::get_mount_types;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let types = get_mount_types(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_types = serde_json::to_value(types).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_types)))
}

async fn get_serve_types_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::serve::get_serve_types;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let types = get_serve_types(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let value = serde_json::to_value(types).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

async fn get_serve_flags_handler(
    State(state): State<WebServerState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_serve_flags;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    // Accept both serveType and serve_type query param names
    let serve_type = params
        .get("serveType")
        .cloned()
        .or_else(|| params.get("serve_type").cloned())
        .unwrap_or_else(|| "".to_string());

    let flags = get_serve_flags(Some(serve_type), rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let value = serde_json::to_value(flags).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

#[derive(Deserialize)]
struct DeleteRemoteSettingsBody {
    #[serde(rename = "remoteName")]
    remote_name: String,
}

async fn delete_remote_settings_handler(
    State(state): State<WebServerState>,
    Json(body): Json<DeleteRemoteSettingsBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::remote::manager::delete_remote_settings;

    let settings_state: tauri::State<crate::utils::types::settings::SettingsState<tauri::Wry>> =
        state.app_handle.state();

    delete_remote_settings(body.remote_name, settings_state, state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Remote settings deleted successfully".to_string(),
    )))
}

#[derive(Deserialize)]
struct DeleteRemoteBody {
    name: String,
}

async fn delete_remote_handler(
    State(state): State<WebServerState>,
    Json(body): Json<DeleteRemoteBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::commands::remote::delete_remote;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let cache = state.app_handle.state::<ScheduledTasksCache>();
    let scheduler = state.app_handle.state::<CronScheduler>();

    delete_remote(
        state.app_handle.clone(),
        body.name,
        rclone_state,
        cache,
        scheduler,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Remote deleted successfully".to_string(),
    )))
}

#[derive(Deserialize)]
struct RemoteLogsQuery {
    #[serde(rename = "remoteName")]
    remote_name: Option<String>,
}

async fn get_remote_logs_handler(
    State(state): State<WebServerState>,
    Query(query): Query<RemoteLogsQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::state::log::get_remote_logs;

    let log_cache = state.app_handle.state::<LogCache>();

    let logs = get_remote_logs(log_cache, query.remote_name)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_logs = serde_json::to_value(logs).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_logs)))
}

async fn clear_remote_logs_handler(
    State(state): State<WebServerState>,
    Query(query): Query<RemoteLogsQuery>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::state::log::clear_remote_logs;

    let log_cache = state.app_handle.state::<LogCache>();

    clear_remote_logs(log_cache, query.remote_name)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Remote logs cleared successfully".to_string(),
    )))
}

// ============================================================================
// VFS Handlers
// ============================================================================

async fn vfs_list_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::vfs::vfs_list;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let value = vfs_list(rclone_state).await.map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

#[derive(Deserialize)]
struct VfsForgetBody {
    fs: Option<String>,
    file: Option<String>,
}

async fn vfs_forget_handler(
    State(state): State<WebServerState>,
    Json(body): Json<VfsForgetBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::vfs::vfs_forget;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let value = vfs_forget(rclone_state, body.fs, body.file)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

#[derive(Deserialize)]
struct VfsRefreshBody {
    fs: Option<String>,
    dir: Option<String>,
    #[serde(default)]
    recursive: bool,
}

async fn vfs_refresh_handler(
    State(state): State<WebServerState>,
    Json(body): Json<VfsRefreshBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::vfs::vfs_refresh;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let value = vfs_refresh(rclone_state, body.fs, body.dir, body.recursive)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

#[derive(Deserialize)]
struct VfsStatsQuery {
    fs: Option<String>,
}

async fn vfs_stats_handler(
    State(state): State<WebServerState>,
    Query(query): Query<VfsStatsQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::vfs::vfs_stats;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let value = vfs_stats(rclone_state, query.fs)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

#[derive(Deserialize)]
struct VfsPollIntervalBody {
    fs: Option<String>,
    interval: Option<String>,
    timeout: Option<String>,
}

async fn vfs_poll_interval_handler(
    State(state): State<WebServerState>,
    Json(body): Json<VfsPollIntervalBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::vfs::vfs_poll_interval;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let value = vfs_poll_interval(rclone_state, body.fs, body.interval, body.timeout)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

#[derive(Deserialize)]
struct VfsQueueQuery {
    fs: Option<String>,
}

async fn vfs_queue_handler(
    State(state): State<WebServerState>,
    Query(query): Query<VfsQueueQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::vfs::vfs_queue;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let value = vfs_queue(rclone_state, query.fs)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

#[derive(Deserialize)]
struct VfsQueueSetExpiryBody {
    fs: Option<String>,
    id: u64,
    expiry: f64,
    #[serde(default)]
    relative: bool,
}

async fn vfs_queue_set_expiry_handler(
    State(state): State<WebServerState>,
    Json(body): Json<VfsQueueSetExpiryBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::vfs::vfs_queue_set_expiry;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let value = vfs_queue_set_expiry(rclone_state, body.fs, body.id, body.expiry, body.relative)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(value)))
}

// ============================================================================
// Backup & Restore Handlers
// ============================================================================

#[derive(Deserialize)]
struct BackupSettingsQuery {
    #[serde(rename = "backupDir")]
    backup_dir: String,
    #[serde(rename = "exportType")]
    export_type: crate::utils::types::backup_types::ExportType,
    password: Option<String>,
    #[serde(rename = "remoteName")]
    remote_name: Option<String>,
    #[serde(rename = "userNote")]
    user_note: Option<String>,
}

async fn backup_settings_handler(
    State(state): State<WebServerState>,
    Query(query): Query<BackupSettingsQuery>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::backup::backup_manager::backup_settings;

    let settings_state: tauri::State<SettingsState<tauri::Wry>> = state.app_handle.state();

    let result = backup_settings(
        query.backup_dir,
        query.export_type,
        query.password,
        query.remote_name,
        query.user_note,
        settings_state,
        state.app_handle.clone(),
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize)]
struct AnalyzeBackupFileQuery {
    path: String,
}

async fn analyze_backup_file_handler(
    State(_state): State<WebServerState>,
    Query(query): Query<AnalyzeBackupFileQuery>,
) -> Result<Json<ApiResponse<crate::utils::types::backup_types::BackupAnalysis>>, AppError> {
    use crate::core::settings::backup::backup_manager::analyze_backup_file;
    use std::path::PathBuf;

    let path = PathBuf::from(query.path);

    let analysis = analyze_backup_file(path)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(analysis)))
}

#[derive(Deserialize)]
struct RestoreSettingsBody {
    #[serde(rename = "backupPath")]
    backup_path: String,
    password: Option<String>,
}

async fn restore_settings_handler(
    State(state): State<WebServerState>,
    Json(body): Json<RestoreSettingsBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::backup::restore_manager::restore_settings;
    use std::path::PathBuf;

    let settings_state: tauri::State<SettingsState<tauri::Wry>> = state.app_handle.state();
    let backup_path = PathBuf::from(body.backup_path);

    let result = restore_settings(
        backup_path,
        body.password,
        settings_state,
        state.app_handle.clone(),
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

async fn reload_scheduled_tasks_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::scheduler::commands::reload_scheduled_tasks;

    let cache = state.app_handle.state::<ScheduledTasksCache>();
    let scheduler = state.app_handle.state::<CronScheduler>();

    reload_scheduled_tasks(cache, scheduler)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Scheduled tasks reloaded successfully".to_string(),
    )))
}

async fn clear_all_scheduled_tasks_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::scheduler::commands::clear_all_scheduled_tasks;

    let cache = state.app_handle.state::<ScheduledTasksCache>();
    let scheduler = state.app_handle.state::<CronScheduler>();

    clear_all_scheduled_tasks(cache, scheduler)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "All scheduled tasks cleared successfully".to_string(),
    )))
}

async fn get_config_password_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::security::commands::get_config_password;

    let credential_store = state
        .app_handle
        .state::<crate::core::security::CredentialStore>();

    let password = get_config_password(credential_store)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(password)))
}

async fn set_config_password_env_handler(
    State(state): State<WebServerState>,
    Json(body): Json<SetConfigPasswordEnvBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::security::commands::set_config_password_env;

    let env_manager = state
        .app_handle
        .state::<crate::core::security::SafeEnvironmentManager>();

    set_config_password_env(state.app_handle.clone(), env_manager, body.password)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Config password environment variable set successfully".to_string(),
    )))
}

#[derive(Deserialize)]
struct SetConfigPasswordEnvBody {
    password: String,
}

async fn clear_config_password_env_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::security::commands::clear_config_password_env;

    let env_manager = state
        .app_handle
        .state::<crate::core::security::SafeEnvironmentManager>();

    clear_config_password_env(env_manager)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Config password environment variable cleared successfully".to_string(),
    )))
}

async fn clear_encryption_cache_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::security::commands::clear_encryption_cache;

    clear_encryption_cache();
    Ok(Json(ApiResponse::success(
        "Encryption cache cleared successfully".to_string(),
    )))
}

async fn change_config_password_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ChangeConfigPasswordBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::security::commands::change_config_password;

    let env_manager = state
        .app_handle
        .state::<crate::core::security::SafeEnvironmentManager>();
    let credential_store = state
        .app_handle
        .state::<crate::core::security::CredentialStore>();

    change_config_password(
        state.app_handle.clone(),
        env_manager,
        credential_store,
        body.current_password,
        body.new_password,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Config password changed successfully".to_string(),
    )))
}

#[derive(Deserialize)]
struct ChangeConfigPasswordBody {
    #[serde(rename = "currentPassword")]
    current_password: String,
    #[serde(rename = "newPassword")]
    new_password: String,
}

async fn reset_settings_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::operations::core::reset_settings;

    let settings_state: tauri::State<SettingsState<tauri::Wry>> = state.app_handle.state();

    reset_settings(settings_state, state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Settings reset successfully".to_string(),
    )))
}

async fn save_rclone_backend_options_handler(
    State(state): State<WebServerState>,
    Json(body): Json<SaveRCloneBackendOptionsBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::rclone_backend::save_rclone_backend_options;

    save_rclone_backend_options(state.app_handle.clone(), body.options)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "RClone backend options saved successfully".to_string(),
    )))
}

#[derive(Deserialize)]
struct SaveRCloneBackendOptionsBody {
    options: serde_json::Value,
}

async fn reset_rclone_backend_options_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::rclone_backend::reset_rclone_backend_options;

    reset_rclone_backend_options(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "RClone backend options reset successfully".to_string(),
    )))
}

async fn get_rclone_backend_store_path_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::core::settings::rclone_backend::get_rclone_backend_store_path;

    let settings_state: tauri::State<SettingsState<tauri::Wry>> = state.app_handle.state();

    let path = get_rclone_backend_store_path(settings_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(path)))
}

async fn update_remote_handler(
    State(state): State<WebServerState>,
    Json(body): Json<UpdateRemoteBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::commands::remote::update_remote;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    update_remote(
        state.app_handle.clone(),
        body.name,
        body.parameters,
        rclone_state,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Remote updated successfully".to_string(),
    )))
}

#[derive(Deserialize)]
struct UpdateRemoteBody {
    name: String,
    parameters: std::collections::HashMap<String, serde_json::Value>,
}

async fn get_stat_handler(
    State(state): State<WebServerState>,
    Query(query): Query<GetStatQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::filesystem::get_stat;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let result = get_stat(query.remote, query.path, rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize)]
struct GetStatQuery {
    remote: String,
    path: String,
}

async fn get_option_blocks_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use crate::rclone::queries::flags::get_option_blocks;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let blocks = get_option_blocks(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(blocks)))
}

async fn get_flags_by_category_handler(
    State(state): State<WebServerState>,
    Query(query): Query<GetFlagsByCategoryQuery>,
) -> Result<Json<ApiResponse<Vec<serde_json::Value>>>, AppError> {
    use crate::rclone::queries::flags::get_flags_by_category;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let flags = get_flags_by_category(
        rclone_state,
        query.category,
        query.filter_groups,
        query.exclude_flags,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(flags)))
}

#[derive(Deserialize)]
struct GetFlagsByCategoryQuery {
    category: String,
    #[serde(rename = "filterGroups")]
    filter_groups: Option<Vec<String>>,
    #[serde(rename = "excludeFlags")]
    exclude_flags: Option<Vec<String>>,
}

async fn get_scheduled_task_handler(
    State(state): State<WebServerState>,
    Query(query): Query<GetScheduledTaskQuery>,
) -> Result<Json<ApiResponse<Option<serde_json::Value>>>, AppError> {
    use crate::rclone::state::scheduled_tasks::get_scheduled_task;

    let cache = state.app_handle.state::<ScheduledTasksCache>();

    let task = get_scheduled_task(cache, query.task_id)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_task = task.map(|t| serde_json::to_value(t)).transpose()?;
    Ok(Json(ApiResponse::success(json_task)))
}

#[derive(Deserialize)]
struct GetScheduledTaskQuery {
    #[serde(rename = "taskId")]
    task_id: String,
}

async fn force_check_serves_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::rclone::state::watcher::force_check_serves;

    force_check_serves(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Serves checked successfully".to_string(),
    )))
}

#[cfg(feature = "updater")]
async fn fetch_update_handler(
    State(state): State<WebServerState>,
    Query(query): Query<FetchUpdateQuery>,
) -> Result<Json<ApiResponse<Option<serde_json::Value>>>, AppError> {
    let pending_update = state.app_handle.state::<PendingUpdate>();
    let download_state = state.app_handle.state::<DownloadState>();

    let result = fetch_update(
        state.app_handle.clone(),
        pending_update,
        download_state,
        query.channel,
    )
    .await
    .map_err(anyhow::Error::msg)?;

    let json_result = result.map(|r| serde_json::to_value(r)).transpose()?;
    Ok(Json(ApiResponse::success(json_result)))
}

#[derive(Deserialize)]
struct FetchUpdateQuery {
    channel: String,
}

#[cfg(feature = "updater")]
async fn get_download_status_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    let download_state = state.app_handle.state::<DownloadState>();

    let status = get_download_status(download_state)
        .await
        .map_err(anyhow::Error::msg)?;

    let json_status = serde_json::to_value(status)?;
    Ok(Json(ApiResponse::success(json_status)))
}

#[cfg(feature = "updater")]
async fn install_update_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    let pending_update = state.app_handle.state::<PendingUpdate>();
    let download_state = state.app_handle.state::<DownloadState>();

    install_update(state.app_handle.clone(), pending_update, download_state)
        .await
        .map_err(anyhow::Error::msg)?;

    Ok(Json(ApiResponse::success(
        "Update installed successfully".to_string(),
    )))
}

async fn relaunch_app_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use crate::utils::app::platform::relaunch_app;

    relaunch_app(state.app_handle.clone());
    Ok(Json(ApiResponse::success(
        "App relaunched successfully".to_string(),
    )))
}

async fn are_updates_disabled_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    use crate::utils::app::platform::are_updates_disabled;

    let disabled = are_updates_disabled();
    Ok(Json(ApiResponse::success(disabled)))
}

async fn get_build_type_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<Option<String>>>, AppError> {
    use crate::utils::app::platform::get_build_type;

    let build_type = get_build_type().map(|s| s.to_string());
    Ok(Json(ApiResponse::success(build_type)))
}
