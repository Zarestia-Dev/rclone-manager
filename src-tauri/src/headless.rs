// RClone Manager - Headless Web Server
// For now its on the test state.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use axum::{
    Router,
    extract::{Query, State},
    http::{Method, StatusCode, header::AUTHORIZATION},
    middleware::Next,
    response::{IntoResponse, Json, Sse, sse::Event},
    routing::{get, post},
};
use axum_server::tls_rustls::RustlsConfig;
use base64::Engine;
use clap::Parser;
use futures::stream::Stream;
use log::{error, info};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    convert::Infallible,
    sync::{Arc, atomic::AtomicBool},
};
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::Mutex;
use tokio::sync::broadcast;
use tower_http::cors::{AllowOrigin, CorsLayer};

// Re-export from lib
use rclone_manager_lib::core::lifecycle::startup::handle_startup;
use rclone_manager_lib::core::scheduler::commands::validate_cron;
use rclone_manager_lib::core::scheduler::engine::CronScheduler;
use rclone_manager_lib::core::settings::operations::core::load_startup_settings;
use rclone_manager_lib::core::{
    initialization::{init_rclone_state, initialization, setup_config_dir},
    lifecycle::shutdown::handle_shutdown,
};
use rclone_manager_lib::rclone::commands::mount::{MountParams, mount_remote};
use rclone_manager_lib::rclone::commands::remote::create_remote;
use rclone_manager_lib::utils::io::network::monitor_network_changes;
use rclone_manager_lib::utils::logging::log::init_logging;
use rclone_manager_lib::utils::types::all_types::{LogCache, RemoteCache};
use rclone_manager_lib::utils::types::scheduled_task::CronValidationResponse;
use rclone_manager_lib::utils::types::settings::SettingsState;
use rclone_manager_lib::{
    rclone::state::scheduled_tasks::ScheduledTasksCache,
    utils::types::all_types::{JobCache, RcloneState},
    utils::types::events::*,
};
use tauri_plugin_store::StoreBuilder;

/// Command line arguments for headless mode
#[derive(Parser, Debug)]
#[command(name = "rclone-manager-headless")]
#[command(about = "RClone Manager Headless Web Server", long_about = None)]
struct Args {
    /// Port to run the web server on
    #[arg(short, long, default_value_t = 8080)]
    port: u16,

    /// Host to bind the web server to
    #[arg(long, default_value = "0.0.0.0")]
    host: String,

    /// Username for basic authentication
    #[arg(long)]
    username: Option<String>,

    /// Password for basic authentication
    #[arg(long)]
    password: Option<String>,

    /// Path to the TLS certificate file (pem/crt)
    #[arg(long)]
    tls_cert: Option<std::path::PathBuf>,

    /// Path to the TLS private key file (key)
    #[arg(long)]
    tls_key: Option<std::path::PathBuf>,
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
            AppError::BadRequest(e) => {
                // For bad requests, don't log as error, maybe just warn
                (StatusCode::BAD_REQUEST, e)
            }
            AppError::InternalServerError(e) => {
                // Log internal errors
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
    // If no credentials are configured, allow all requests
    if state.auth_credentials.is_none() {
        return Ok(next.run(request).await);
    }

    let (_username, expected_creds) = state.auth_credentials.as_ref().unwrap();

    // Check Authorization header (Basic Auth)
    if let Some(auth_header) = request.headers().get(AUTHORIZATION) {
        if let Ok(auth_str) = auth_header.to_str() {
            if auth_str.starts_with("Basic ") {
                let creds = &auth_str[6..]; // Remove "Basic "
                if creds == expected_creds {
                    // Credentials are valid, proceed
                    return Ok(next.run(request).await);
                }
            }
        }
    }

    // Check query parameter as fallback (for SSE which doesn't support custom headers)
    if let Some(query_string) = request.uri().query() {
        if let Ok(decoded) = urlencoding::decode(query_string) {
            for param in decoded.split('&') {
                if let Some((key, value)) = param.split_once('=') {
                    if key == "auth" && value == expected_creds {
                        // Credentials are valid via query param, proceed
                        return Ok(next.run(request).await);
                    }
                }
            }
        }
    }

    // Invalid or missing credentials - return 401 with WWW-Authenticate header
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

fn main() {
    // Initialize crypto provider for TLS
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    // Parse command line arguments
    let args = Args::parse();

    // Setup authentication credentials
    let auth_credentials =
        if let (Some(username), Some(password)) = (&args.username, &args.password) {
            let credentials = format!("{}:{}", username, password);
            let encoded = base64::engine::general_purpose::STANDARD.encode(&credentials);
            info!("🔐 Authentication enabled with username: {}", username);
            Some((username.clone(), encoded))
        } else {
            info!("🔓 No authentication configured - server is open");
            None
        };

    info!("🚀 Starting RClone Manager Headless Server");
    info!("📡 Server will run on {}:{}", args.host, args.port);
    if auth_credentials.is_some() {
        info!(
            "🔐 Access the web UI at: http://{}:{}/",
            args.host, args.port
        );
        info!("   Browser will prompt for username and password");
    } else {
        info!("⚠️  No authentication configured - server is open to all requests!");
        info!(
            "🌍 Access the web UI at: http://{}:{}/",
            args.host, args.port
        );
    }

    // Initialize Tauri in headless mode (no window)
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let app_handle = app.handle();
            let config_dir = setup_config_dir(app_handle)?;
            let store_path = config_dir.join("settings.json");

            let store = Mutex::new(
                StoreBuilder::new(&app_handle.clone(), store_path)
                    .build()
                    .map_err(|e| format!("Failed to create settings store: {e}"))?,
            );

            app.manage(SettingsState {
                store,
                config_dir: config_dir.clone(),
            });

            use rclone_manager_lib::core::settings::rclone_backend::RCloneBackendStore;
            let rclone_backend_store = RCloneBackendStore::new(app_handle, &config_dir)
                .map_err(|e| format!("Failed to initialize RClone backend store: {e}"))?;
            app.manage(rclone_backend_store);

            // Initialize SafeEnvironmentManager for secure password handling
            use rclone_manager_lib::core::security::{CredentialStore, SafeEnvironmentManager};
            let env_manager = SafeEnvironmentManager::new();
            let credential_store = CredentialStore::new();

            if let Err(e) = env_manager.init_with_stored_credentials(&credential_store) {
                error!("Failed to initialize environment manager with stored credentials: {e}");
            }

            app.manage(env_manager);
            app.manage(credential_store);

            let settings = load_startup_settings(&app.state::<SettingsState<tauri::Wry>>())
                .map_err(|e| format!("Failed to load startup settings: {e}"))?;

            let force_tray = std::env::args().any(|arg| arg == "--tray");
            let tray_enabled = settings.general.tray_enabled || force_tray;

            app.manage(RcloneState {
                client: reqwest::Client::new(),
                rclone_config_file: Arc::new(std::sync::RwLock::new(
                    settings.core.rclone_config_file.clone(),
                )),
                tray_enabled: Arc::new(std::sync::RwLock::new(tray_enabled)),
                is_shutting_down: AtomicBool::new(false),
                notifications_enabled: Arc::new(std::sync::RwLock::new(
                    settings.general.notifications,
                )),
                rclone_path: Arc::new(std::sync::RwLock::new(
                    settings.core.rclone_path.clone().into(),
                )),
                restrict_mode: Arc::new(std::sync::RwLock::new(settings.general.restrict)),
                destroy_window_on_close: Arc::new(std::sync::RwLock::new(false)),
                terminal_apps: Arc::new(std::sync::RwLock::new(
                    settings.core.terminal_apps.clone(),
                )),
                is_restart_required: AtomicBool::new(false),
                is_update_in_progress: AtomicBool::new(false),
                oauth_process: tokio::sync::Mutex::new(None),
            });

            app.manage(JobCache::new());
            app.manage(LogCache::new(1000));
            app.manage(ScheduledTasksCache::new());
            app.manage(CronScheduler::new());
            app.manage(RemoteCache::new());

            // #[cfg(all(desktop, feature = "updater"))]
            // app.manage(PendingUpdate(std::sync::Mutex::new(None)));
            // #[cfg(all(desktop, feature = "updater"))]
            // app.manage(DownloadState::default());

            init_logging(settings.developer.debug_logging, app_handle.clone())
                .map_err(|e| format!("Failed to initialize logging: {e}"))?;

            init_rclone_state(app_handle, &settings)
                .map_err(|e| format!("Rclone initialization failed: {e}"))?;

            let app_handle_clone = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                initialization(app_handle_clone.clone(), settings).await;
                handle_startup(app_handle_clone.clone()).await;
                monitor_network_changes(app_handle_clone).await;
            });

            // Start web server
            let app_handle_for_web = app.handle().clone();
            let host = args.host.clone();
            let port = args.port;
            let auth_creds = auth_credentials.clone();
            tauri::async_runtime::spawn(async move {
                info!("🌐 Starting web server spawn");
                if let Err(e) = start_web_server(
                    app_handle_for_web,
                    host,
                    port,
                    auth_creds,
                    args.tls_cert,
                    args.tls_key,
                )
                .await
                {
                    error!("Web server error: {e}");
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Error building Tauri application");
    // Run Tauri event loop (headless - no window)
    info!("🎯 Tauri event loop starting");
    app.run(|_app_handle, _event| {});
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
}

fn file_operations_routes() -> Router<WebServerState> {
    Router::new()
        .route("/fs/info", get(get_fs_info_handler))
        .route("/disk-usage", get(get_disk_usage_handler))
        .route("/get-local-drives", get(get_local_drives_handler))
        .route("/get-size", get(get_size_handler))
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
        .route("/serve/start", post(start_serve_handler))
        .route("/serve/stop", post(stop_serve_handler))
        .route("/mount-remote", post(mount_remote_handler))
        .route("/unmount-remote", post(unmount_remote_handler))
        .route("/mount-types", get(get_mount_types_handler))
        .route("/is-7z-available", get(is_7z_available_handler))
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
}

fn flags_routes() -> Router<WebServerState> {
    Router::new()
        .route("/flags/mount", get(get_mount_flags_handler))
        .route("/flags/copy", get(get_copy_flags_handler))
        .route("/flags/sync", get(get_sync_flags_handler))
        .route("/flags/filter", get(get_filter_flags_handler))
        .route("/flags/vfs", get(get_vfs_flags_handler))
        .route("/flags/backend", get(get_backend_flags_handler))
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

async fn start_web_server(
    app_handle: AppHandle,
    host: String,
    port: u16,
    auth_credentials: Option<(String, String)>,
    tls_cert: Option<std::path::PathBuf>,
    tls_key: Option<std::path::PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    info!("🌐 Starting web server on {}:{}", host, port);
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
        NOTIFY_UI,
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

    let state = WebServerState {
        app_handle: app_handle.clone(),
        event_tx,
        auth_credentials,
    };

    // Determine the path to serve static files from
    // Try multiple locations
    let static_dir = {
        // Try relative to current directory first (for development)
        let local_dist = std::path::PathBuf::from("dist/rclone-manager/browser");
        if local_dist.exists() {
            info!("Found static files in current directory");
            Some(local_dist)
        } else {
            // Try relative to src-tauri directory (common dev pattern)
            let src_tauri_dist = std::path::PathBuf::from("../dist/rclone-manager/browser");
            if src_tauri_dist.exists() {
                info!("Found static files in ../dist");
                Some(src_tauri_dist)
            } else {
                // Try relative to binary location
                std::env::current_exe()
                    .ok()
                    .and_then(|path| path.parent().map(|p| p.to_path_buf()))
                    .and_then(|path| {
                        let dist_path = path.join("../../../dist/rclone-manager/browser");
                        if dist_path.exists() {
                            info!("Found static files relative to binary");
                            Some(dist_path)
                        } else {
                            None
                        }
                    })
            }
        }
    };

    // Build jobs sub-router
    let jobs_router = Router::new()
        .route("/", get(get_jobs_handler))
        .route("/active", get(get_active_jobs_handler))
        .route("/stop", post(stop_job_handler))
        .route("/delete", post(delete_job_handler))
        .route("/start-sync", post(start_sync_handler))
        .route("/start-copy", post(start_copy_handler))
        .route("/start-move", post(start_move_handler))
        .route("/start-bisync", post(start_bisync_handler))
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
    use rclone_manager_lib::rclone::state::cache::get_cached_remotes;
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
    use rclone_manager_lib::rclone::queries::get_remote_config;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let config = get_remote_config(query.name, rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(config)))
}

async fn get_remote_types_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use rclone_manager_lib::rclone::queries::get_remote_types;

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
    use rclone_manager_lib::rclone::queries::get_core_stats;

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
    use rclone_manager_lib::rclone::queries::stats::get_core_stats_filtered;

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
    use rclone_manager_lib::rclone::queries::stats::get_completed_transfers;

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
    use rclone_manager_lib::rclone::state::job::get_jobs;
    let job_cache = state.app_handle.state::<JobCache>();
    let jobs = get_jobs(job_cache).await.map_err(anyhow::Error::msg)?;
    let json_jobs = serde_json::to_value(jobs)?;
    Ok(Json(ApiResponse::success(json_jobs)))
}

async fn get_active_jobs_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use rclone_manager_lib::rclone::state::job::get_active_jobs;
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
    use rclone_manager_lib::rclone::state::job::get_job_status;

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
    use rclone_manager_lib::rclone::commands::job::stop_job;

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
    use rclone_manager_lib::rclone::state::job::delete_job;

    let job_cache = state.app_handle.state::<JobCache>();

    delete_job(job_cache, body.jobid)
        .await
        .map_err(anyhow::Error::msg)?;

    Ok(Json(ApiResponse::success(
        "Job deleted successfully".to_string(),
    )))
}

#[derive(Deserialize)]
struct StartSyncBody {
    params: serde_json::Value,
}

async fn start_sync_handler(
    State(state): State<WebServerState>,
    Json(body): Json<StartSyncBody>,
) -> Result<Json<ApiResponse<u64>>, AppError> {
    use rclone_manager_lib::rclone::commands::sync::{SyncParams, start_sync};

    let params: SyncParams = serde_json::from_value(body.params)
        .map_err(|e| AppError::BadRequest(anyhow::Error::msg(e)))?;

    let job_cache = state.app_handle.state::<JobCache>();
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let jobid = start_sync(state.app_handle.clone(), job_cache, rclone_state, params)
        .await
        .map_err(anyhow::Error::msg)?;

    Ok(Json(ApiResponse::success(jobid)))
}

#[derive(Deserialize)]
struct StartCopyBody {
    params: serde_json::Value,
}

async fn start_copy_handler(
    State(state): State<WebServerState>,
    Json(body): Json<StartCopyBody>,
) -> Result<Json<ApiResponse<u64>>, AppError> {
    use rclone_manager_lib::rclone::commands::sync::{CopyParams, start_copy};

    let params: CopyParams = serde_json::from_value(body.params)
        .map_err(|e| AppError::BadRequest(anyhow::Error::msg(e)))?;

    let job_cache = state.app_handle.state::<JobCache>();
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let jobid = start_copy(state.app_handle.clone(), job_cache, rclone_state, params)
        .await
        .map_err(anyhow::Error::msg)?;

    Ok(Json(ApiResponse::success(jobid)))
}

#[derive(Deserialize)]
struct StartMoveBody {
    params: serde_json::Value,
}

async fn start_move_handler(
    State(state): State<WebServerState>,
    Json(body): Json<StartMoveBody>,
) -> Result<Json<ApiResponse<u64>>, AppError> {
    use rclone_manager_lib::rclone::commands::sync::{MoveParams, start_move};

    let params: MoveParams = serde_json::from_value(body.params)
        .map_err(|e| AppError::BadRequest(anyhow::Error::msg(e)))?;

    let job_cache = state.app_handle.state::<JobCache>();
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let jobid = start_move(state.app_handle.clone(), job_cache, rclone_state, params)
        .await
        .map_err(anyhow::Error::msg)?;

    Ok(Json(ApiResponse::success(jobid)))
}

#[derive(Deserialize)]
struct StartBisyncBody {
    params: serde_json::Value,
}

async fn start_bisync_handler(
    State(state): State<WebServerState>,
    Json(body): Json<StartBisyncBody>,
) -> Result<Json<ApiResponse<u64>>, AppError> {
    use rclone_manager_lib::rclone::commands::sync::{BisyncParams, start_bisync};

    let params: BisyncParams = serde_json::from_value(body.params)
        .map_err(|e| AppError::BadRequest(anyhow::Error::msg(e)))?;

    let job_cache = state.app_handle.state::<JobCache>();
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let jobid = start_bisync(state.app_handle.clone(), job_cache, rclone_state, params)
        .await
        .map_err(anyhow::Error::msg)?;

    Ok(Json(ApiResponse::success(jobid)))
}

async fn get_mounted_remotes_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use rclone_manager_lib::rclone::queries::get_mounted_remotes;

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
    use rclone_manager_lib::rclone::state::cache::get_settings;
    let cache = state.app_handle.state::<RemoteCache>();
    let settings = get_settings(cache).await.map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(settings)))
}

async fn load_settings_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use rclone_manager_lib::core::settings::operations::core::load_settings;

    let settings_state: tauri::State<
        rclone_manager_lib::utils::types::settings::SettingsState<tauri::Wry>,
    > = state.app_handle.state();

    let settings = load_settings(settings_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_settings = serde_json::to_value(settings)?;
    Ok(Json(ApiResponse::success(json_settings)))
}

async fn get_rclone_info_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use rclone_manager_lib::rclone::queries::get_rclone_info;

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
    use rclone_manager_lib::rclone::queries::get_rclone_pid;

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
    use rclone_manager_lib::rclone::state::engine::get_rclone_rc_url;

    let url = get_rclone_rc_url();
    Ok(Json(ApiResponse::success(url)))
}

async fn get_memory_stats_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use rclone_manager_lib::rclone::queries::get_memory_stats;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let stats = get_memory_stats(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    let json_stats = serde_json::to_value(stats)?;
    Ok(Json(ApiResponse::success(json_stats)))
}

async fn get_bandwidth_limit_handler(
    State(state): State<WebServerState>,
) -> Result<
    Json<ApiResponse<rclone_manager_lib::utils::types::all_types::BandwidthLimitResponse>>,
    AppError,
> {
    use rclone_manager_lib::rclone::queries::get_bandwidth_limit;

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
    use rclone_manager_lib::rclone::queries::get_fs_info;

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
) -> Result<Json<ApiResponse<rclone_manager_lib::utils::types::all_types::DiskUsage>>, AppError> {
    use rclone_manager_lib::rclone::queries::get_disk_usage;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let usage = get_disk_usage(query.remote, query.path, rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(usage)))
}

async fn get_local_drives_handler(
    State(_state): State<WebServerState>,
) -> Result<
    Json<ApiResponse<Vec<rclone_manager_lib::rclone::queries::filesystem::LocalDrive>>>,
    AppError,
> {
    use rclone_manager_lib::rclone::queries::filesystem::get_local_drives;

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
    use rclone_manager_lib::rclone::queries::filesystem::get_size;

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
    use rclone_manager_lib::rclone::commands::filesystem::mkdir;

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
    use rclone_manager_lib::rclone::commands::filesystem::cleanup;

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
    use rclone_manager_lib::rclone::commands::filesystem::copy_url;

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
    use rclone_manager_lib::rclone::queries::get_remote_paths;
    use rclone_manager_lib::utils::types::all_types::ListOptions;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let options = body.options.map(|v| {
        // Try to deserialize into ListOptions
        serde_json::from_value::<ListOptions>(v).unwrap_or(ListOptions {
            metadata: false,
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
    use rclone_manager_lib::rclone::queries::filesystem::convert_file_src;

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
    use rclone_manager_lib::core::settings::remote::manager::save_remote_settings;

    let settings_state: tauri::State<
        rclone_manager_lib::utils::types::settings::SettingsState<tauri::Wry>,
    > = state.app_handle.state();
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
    use rclone_manager_lib::utils::io::network::is_network_metered;

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
    use rclone_manager_lib::core::check_binaries::check_rclone_available;

    let path = query.path.as_deref().unwrap_or("");
    let available = check_rclone_available(state.app_handle.clone(), path)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(available)))
}

async fn check_mount_plugin_installed_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    use rclone_manager_lib::utils::rclone::mount::check_mount_plugin_installed;

    let installed = check_mount_plugin_installed();
    Ok(Json(ApiResponse::success(installed)))
}

async fn is_7z_available_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<Option<String>>>, AppError> {
    use rclone_manager_lib::core::check_binaries::is_7z_available;

    let result = is_7z_available();
    Ok(Json(ApiResponse::success(result)))
}

#[derive(Deserialize)]
struct KillProcessByPidQuery {
    pid: u32,
}

async fn kill_process_by_pid_handler(
    State(_state): State<WebServerState>,
    Query(query): Query<KillProcessByPidQuery>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use rclone_manager_lib::utils::process::process_manager::kill_process_by_pid;

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
    use rclone_manager_lib::core::settings::operations::core::save_setting;

    let settings_state: tauri::State<
        rclone_manager_lib::utils::types::settings::SettingsState<tauri::Wry>,
    > = state.app_handle.state();

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
    use rclone_manager_lib::core::settings::operations::core::reset_setting;

    let settings_state: tauri::State<
        rclone_manager_lib::utils::types::settings::SettingsState<tauri::Wry>,
    > = state.app_handle.state();

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
    use rclone_manager_lib::utils::io::network::check_links;

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
    use rclone_manager_lib::utils::rclone::updater::check_rclone_update;

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
    use rclone_manager_lib::utils::rclone::updater::update_rclone;

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
    use rclone_manager_lib::utils::rclone::provision::provision_rclone;

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
    use rclone_manager_lib::rclone::state::cache::get_cached_mounted_remotes;
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
    use rclone_manager_lib::rclone::state::cache::get_cached_serves;
    let cache = state.app_handle.state::<RemoteCache>();
    let serves = get_cached_serves(cache).await.map_err(anyhow::Error::msg)?;

    // Convert to JSON value
    let json_serves = serde_json::to_value(serves).map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(json_serves)))
}

#[derive(Deserialize)]
struct StartServeBody {
    params: serde_json::Value,
}

async fn start_serve_handler(
    State(state): State<WebServerState>,
    Json(body): Json<StartServeBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use rclone_manager_lib::rclone::commands::serve::{ServeParams, start_serve};

    let params: ServeParams = serde_json::from_value(body.params)
        .map_err(|e| AppError::BadRequest(anyhow::Error::msg(e)))?;

    let job_cache = state.app_handle.state::<JobCache>();
    let resp = start_serve(state.app_handle.clone(), job_cache, params)
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
    use rclone_manager_lib::rclone::commands::serve::stop_serve;

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
    use rclone_manager_lib::rclone::state::cache::get_configs;
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
    use rclone_manager_lib::rclone::state::scheduled_tasks::reload_scheduled_tasks_from_configs;

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
    use rclone_manager_lib::rclone::state::scheduled_tasks::get_scheduled_tasks;

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
    use rclone_manager_lib::core::scheduler::commands::toggle_scheduled_task;

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
    use rclone_manager_lib::rclone::state::scheduled_tasks::get_scheduled_tasks_stats;

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

async fn mount_remote_handler(
    State(state): State<WebServerState>,
    Json(body): Json<MountRemoteBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    let job_cache = state.app_handle.state::<JobCache>();
    let remote_cache = state.app_handle.state::<RemoteCache>();

    mount_remote(
        state.app_handle.clone(),
        job_cache,
        remote_cache,
        body.params,
    )
    .await
    .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(
        "Remote mounted successfully".to_string(),
    )))
}

#[derive(Deserialize)]
struct MountRemoteBody {
    params: MountParams,
}

async fn unmount_remote_handler(
    State(state): State<WebServerState>,
    Json(body): Json<UnmountRemoteBody>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use rclone_manager_lib::rclone::commands::mount::unmount_remote;

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
    use rclone_manager_lib::rclone::queries::flags::get_grouped_options_with_values;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let options = get_grouped_options_with_values(rclone_state)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(options)))
}

async fn get_mount_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, AppError> {
    use rclone_manager_lib::rclone::queries::flags::get_mount_flags;

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
    use rclone_manager_lib::rclone::queries::flags::get_copy_flags;

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
    use rclone_manager_lib::rclone::queries::flags::get_sync_flags;

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
    use rclone_manager_lib::rclone::queries::flags::get_bisync_flags;

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
    use rclone_manager_lib::rclone::queries::flags::get_move_flags;

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
    use rclone_manager_lib::rclone::queries::flags::get_filter_flags;

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
    use rclone_manager_lib::rclone::queries::flags::get_vfs_flags;

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
    use rclone_manager_lib::rclone::queries::flags::get_backend_flags;

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
    use rclone_manager_lib::core::settings::rclone_backend::save_rclone_backend_option;

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
    use rclone_manager_lib::rclone::queries::flags::set_rclone_option;

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
    use rclone_manager_lib::core::settings::rclone_backend::remove_rclone_backend_option;

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
    use rclone_manager_lib::rclone::queries::get_oauth_supported_remotes;

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
    use rclone_manager_lib::rclone::state::cache::get_cached_remotes;
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
    use rclone_manager_lib::rclone::commands::remote::create_remote_interactive;

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
    use rclone_manager_lib::rclone::commands::remote::continue_create_remote_interactive;

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
    use rclone_manager_lib::rclone::commands::system::quit_rclone_oauth;

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
    use rclone_manager_lib::core::security::commands::get_cached_encryption_status;

    let status = get_cached_encryption_status();
    Ok(Json(ApiResponse::success(status)))
}

async fn has_stored_password_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    use rclone_manager_lib::core::security::commands::has_stored_password;

    let credential_store = state
        .app_handle
        .state::<rclone_manager_lib::core::security::CredentialStore>();

    let has_password = has_stored_password(credential_store)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(has_password)))
}

async fn is_config_encrypted_cached_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    use rclone_manager_lib::core::security::commands::is_config_encrypted_cached;

    let is_encrypted = is_config_encrypted_cached(state.app_handle.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(is_encrypted)))
}

async fn has_config_password_env_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    use rclone_manager_lib::core::security::commands::has_config_password_env;

    let env_manager = state
        .app_handle
        .state::<rclone_manager_lib::core::security::SafeEnvironmentManager>();

    let has_password = has_config_password_env(env_manager)
        .await
        .map_err(anyhow::Error::msg)?;
    Ok(Json(ApiResponse::success(has_password)))
}

async fn remove_config_password_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, AppError> {
    use rclone_manager_lib::core::security::commands::remove_config_password;

    let env_manager = state
        .app_handle
        .state::<rclone_manager_lib::core::security::SafeEnvironmentManager>();
    let credential_store = state
        .app_handle
        .state::<rclone_manager_lib::core::security::CredentialStore>();

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
    use rclone_manager_lib::core::security::commands::validate_rclone_password;

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
    use rclone_manager_lib::core::security::commands::store_config_password;

    let env_manager = state
        .app_handle
        .state::<rclone_manager_lib::core::security::SafeEnvironmentManager>();
    let credential_store = state
        .app_handle
        .state::<rclone_manager_lib::core::security::CredentialStore>();

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
    use rclone_manager_lib::core::security::commands::unencrypt_config;

    let env_manager = state
        .app_handle
        .state::<rclone_manager_lib::core::security::SafeEnvironmentManager>();

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
    use rclone_manager_lib::core::security::commands::encrypt_config;

    let env_manager = state
        .app_handle
        .state::<rclone_manager_lib::core::security::SafeEnvironmentManager>();
    let credential_store = state
        .app_handle
        .state::<rclone_manager_lib::core::security::CredentialStore>();

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
    use rclone_manager_lib::rclone::queries::get_mount_types;

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
    use rclone_manager_lib::rclone::queries::serve::get_serve_types;

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
    use rclone_manager_lib::rclone::queries::serve::get_serve_flags;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    // Accept both serveType and serve_type query param names
    let serve_type = params
        .get("serveType")
        .cloned()
        .or_else(|| params.get("serve_type").cloned())
        .unwrap_or_else(|| "".to_string());

    let flags = get_serve_flags(serve_type, rclone_state)
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
    use rclone_manager_lib::core::settings::remote::manager::delete_remote_settings;

    let settings_state: tauri::State<
        rclone_manager_lib::utils::types::settings::SettingsState<tauri::Wry>,
    > = state.app_handle.state();

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
    use rclone_manager_lib::rclone::commands::remote::delete_remote;

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
    use rclone_manager_lib::rclone::state::log::get_remote_logs;

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
    use rclone_manager_lib::rclone::state::log::clear_remote_logs;

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
    use rclone_manager_lib::rclone::queries::vfs::vfs_list;

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
    use rclone_manager_lib::rclone::queries::vfs::vfs_forget;

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
    use rclone_manager_lib::rclone::queries::vfs::vfs_refresh;

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
    use rclone_manager_lib::rclone::queries::vfs::vfs_stats;

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
    use rclone_manager_lib::rclone::queries::vfs::vfs_poll_interval;

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
    use rclone_manager_lib::rclone::queries::vfs::vfs_queue;

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
    use rclone_manager_lib::rclone::queries::vfs::vfs_queue_set_expiry;

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
    export_type: rclone_manager_lib::utils::types::backup_types::ExportType,
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
    use rclone_manager_lib::core::settings::backup::backup_manager::backup_settings;

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
) -> Result<
    Json<ApiResponse<rclone_manager_lib::utils::types::backup_types::BackupAnalysis>>,
    AppError,
> {
    use rclone_manager_lib::core::settings::backup::backup_manager::analyze_backup_file;
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
    use rclone_manager_lib::core::settings::backup::restore_manager::restore_settings;
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
