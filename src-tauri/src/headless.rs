// RClone Manager - Headless Web Server
// For now its on the test state.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use axum::{
    Router,
    extract::{Query, State},
    http::{Method, StatusCode},
    response::{Json, Sse, sse::Event},
    routing::{get, post},
};
use clap::Parser;
use futures::stream::Stream;
use log::{error, info};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, convert::Infallible, sync::Arc};
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};

// Re-export from lib
use rclone_manager_lib::core::initialization::async_startup;
use rclone_manager_lib::core::lifecycle::startup::handle_startup;
use rclone_manager_lib::utils::io::network::monitor_network_changes;
use rclone_manager_lib::utils::types::all_types::RcloneState;

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
}

/// Shared state for web server handlers
#[derive(Clone)]
struct WebServerState {
    app_handle: AppHandle,
    event_tx: Arc<broadcast::Sender<TauriEvent>>,
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

fn main() {
    // Parse command line arguments
    let args = Args::parse();

    info!("🚀 Starting RClone Manager Headless Server");
    info!("📡 Server will run on {}:{}", args.host, args.port);

    // Initialize Tauri in headless mode (no window)
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_handle = app.handle();

            // Initialize the same state as desktop version
            use rclone_manager_lib::{
                core::initialization::{init_rclone_state, setup_config_dir},
                core::settings::operations::core::load_startup_settings,
                utils::types::{all_types::RcloneState, settings::SettingsState},
            };
            use std::sync::{Arc, atomic::AtomicBool};
            use tauri_plugin_store::StoreBuilder;
            use tokio::sync::Mutex;

            // Setup config directory
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

            // Initialize RClone Backend Store
            use rclone_manager_lib::core::settings::rclone_backend::RCloneBackendStore;
            let rclone_backend_store = RCloneBackendStore::new(app_handle, &config_dir)
                .map_err(|e| format!("Failed to initialize RClone backend store: {e}"))?;
            app.manage(rclone_backend_store);

            // Initialize SafeEnvironmentManager
            use rclone_manager_lib::core::security::{CredentialStore, SafeEnvironmentManager};
            let env_manager = SafeEnvironmentManager::new();
            let credential_store = CredentialStore::new();

            if let Err(e) = env_manager.init_with_stored_credentials(&credential_store) {
                error!("Failed to initialize environment manager: {e}");
            }

            app.manage(env_manager);
            app.manage(credential_store);

            // Load settings using block_in_place to handle blocking calls in async context
            let settings = tokio::task::block_in_place(|| {
                load_startup_settings(&app.state::<SettingsState<tauri::Wry>>())
            })
            .map_err(|e| format!("Failed to load settings: {e}"))?;

            // Create RcloneState
            app.manage(RcloneState {
                client: reqwest::Client::new(),
                rclone_config_file: Arc::new(std::sync::RwLock::new(
                    settings.core.rclone_config_file.clone(),
                )),
                tray_enabled: Arc::new(std::sync::RwLock::new(false)),
                is_shutting_down: AtomicBool::new(false),
                notifications_enabled: Arc::new(std::sync::RwLock::new(false)),
                rclone_path: Arc::new(std::sync::RwLock::new(
                    settings.core.rclone_path.clone().into(),
                )),
                restrict_mode: Arc::new(std::sync::RwLock::new(settings.general.restrict)),
                terminal_apps: Arc::new(std::sync::RwLock::new(
                    settings.core.terminal_apps.clone(),
                )),
            });

            // Initialize logging
            use rclone_manager_lib::utils::logging::log::init_logging;
            init_logging(settings.developer.debug_logging)
                .map_err(|e| format!("Failed to initialize logging: {e}"))?;

            // Initialize rclone state
            init_rclone_state(app_handle, &settings)
                .map_err(|e| format!("Rclone initialization failed: {e}"))?;

            let app_handle_clone = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                async_startup(app_handle_clone.clone(), settings).await;
                handle_startup(app_handle_clone.clone()).await;
                monitor_network_changes(app_handle_clone).await;
            });

            info!("✅ Tauri state initialized successfully");

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Error building Tauri application");

    let app_handle = app.handle().clone();
    let host = args.host.clone();
    let port = args.port;

    // Start web server in background using Tauri's async runtime
    tauri::async_runtime::spawn(async move {
        if let Err(e) = start_web_server(app_handle, host, port).await {
            error!("Web server error: {e}");
        }
    });

    // Run Tauri event loop (headless - no window)
    info!("🎯 Tauri event loop starting");
    app.run(|_app_handle, _event| {});
}

async fn start_web_server(
    app_handle: AppHandle,
    host: String,
    port: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    // Create broadcast channel for SSE events
    let (event_tx, _) = broadcast::channel::<TauriEvent>(100);
    let event_tx = Arc::new(event_tx);

    // Setup Tauri event listeners to forward all events to SSE clients
    // List of all events emitted by the application
    let events_to_forward = vec![
        // Settings
        "system_settings_changed",
        // RClone engine
        "rclone_engine",
        "rclone-engine",
        // State changes
        "remote_state_changed",
        // App updates
        "update-available",
        "update-downloaded",
        "download-progress",
        // Other events (add more as needed)
    ];

    for event_name in events_to_forward {
        let event_tx_for_listener = event_tx.clone();
        let event_name_owned = event_name.to_string();
        app_handle.listen(event_name, move |event| {
            if let Ok(payload) = serde_json::to_value(&event.payload()) {
                let tauri_event = TauriEvent {
                    event: event_name_owned.clone(),
                    payload,
                };
                // Send to all SSE clients (ignore if no receivers)
                let _ = event_tx_for_listener.send(tauri_event);
            }
        });
    }

    let state = WebServerState {
        app_handle: app_handle.clone(),
        event_tx,
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
        .with_state(state.clone());

    // Build API router
    let api_router = Router::new()
        .route("/remotes", get(get_remotes_handler))
        .route("/remote/:name", get(get_remote_config_handler))
        .route("/remote-types", get(get_remote_types_handler))
        .route("/stats", get(get_stats_handler))
        .nest("/jobs", jobs_router)
        .route("/mounted-remotes", get(get_mounted_remotes_handler))
        .route("/settings", get(get_settings_handler))
        .route("/settings/load", get(load_settings_handler))
        .route("/save-setting", post(save_setting_handler))
        .route("/reset-setting", post(reset_setting_handler))
        .route("/check-links", get(check_links_handler))
        .route("/check-rclone-update", get(check_rclone_update_handler))
        .route("/update-rclone", get(update_rclone_handler))
        .route("/is-network-metered", get(is_network_metered_handler))
        .route(
            "/check-rclone-available",
            get(check_rclone_available_handler),
        )
        .route(
            "/check-mount-plugin-installed",
            get(check_mount_plugin_installed_handler),
        )
        .route("/kill-process-by-pid", get(kill_process_by_pid_handler))
        .route("/rclone-info", get(get_rclone_info_handler))
        .route("/rclone-pid", get(get_rclone_pid_handler))
        .route("/memory-stats", get(get_memory_stats_handler))
        .route("/bandwidth/limit", get(get_bandwidth_limit_handler))
        .route("/fs/info", get(get_fs_info_handler))
        .route("/disk-usage", get(get_disk_usage_handler))
        .route("/provision-rclone", get(provision_rclone_handler))
        .route(
            "/get-cached-mounted-remotes",
            get(get_cached_mounted_remotes_handler),
        )
        .route("/get-configs", get(get_configs_handler))
        .route("/save-remote-settings", post(save_remote_settings_handler))
        .route("/events", get(sse_handler))
        .with_state(state);

    // Configure CORS to allow requests from any origin (including localhost/127.0.0.1)
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(Any)
        .allow_credentials(false);

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

    let addr = format!("{}:{}", host, port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;

    info!("🌐 Web server listening on http://{}", addr);
    info!("📋 API endpoints:");
    info!("   GET  /health - Health check");
    info!("   GET  /api/remotes - List all remotes");
    info!("   GET  /api/stats - Get core stats");
    info!("   GET  /api/jobs - Get active jobs");
    info!("");
    info!("🌍 Open http://{}:{} in your browser", host, port);

    axum::serve(listener, app).await?;

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

async fn get_remotes_handler()
-> Result<Json<ApiResponse<Vec<String>>>, (StatusCode, Json<ApiResponse<Vec<String>>>)> {
    use rclone_manager_lib::rclone::state::get_cached_remotes;

    match get_cached_remotes().await {
        Ok(remotes) => {
            info!("Fetched remotes: {:?}", remotes);
            Ok(Json(ApiResponse::success(remotes)))
        }
        Err(e) => {
            error!("Failed to get remotes: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to get remotes: {}", e))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct RemoteNameQuery {
    name: String,
}

async fn get_remote_config_handler(
    State(state): State<WebServerState>,
    Query(query): Query<RemoteNameQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::get_remote_config;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_remote_config(query.name, rclone_state).await {
        Ok(config) => Ok(Json(ApiResponse::success(config))),
        Err(e) => {
            error!("Failed to get remote config: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get remote config: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_remote_types_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::get_remote_types;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_remote_types(rclone_state).await {
        Ok(types) => {
            // Convert to JSON value
            match serde_json::to_value(types) {
                Ok(json_types) => Ok(Json(ApiResponse::success(json_types))),
                Err(e) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse::error(format!(
                        "Failed to serialize types: {}",
                        e
                    ))),
                )),
            }
        }
        Err(e) => {
            error!("Failed to get remote types: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get remote types: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_stats_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::get_core_stats;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_core_stats(rclone_state).await {
        Ok(stats) => Ok(Json(ApiResponse::success(stats))),
        Err(e) => {
            error!("Failed to get stats: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to get stats: {}", e))),
            ))
        }
    }
}

async fn get_jobs_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::state::get_jobs;

    match get_jobs().await {
        Ok(jobs) => {
            // Convert to JSON value
            match serde_json::to_value(jobs) {
                Ok(json_jobs) => Ok(Json(ApiResponse::success(json_jobs))),
                Err(e) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse::error(format!(
                        "Failed to serialize jobs: {}",
                        e
                    ))),
                )),
            }
        }
        Err(e) => {
            error!("Failed to get jobs: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to get jobs: {}", e))),
            ))
        }
    }
}

async fn get_active_jobs_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::state::get_active_jobs;

    match get_active_jobs().await {
        Ok(active_jobs) => {
            // Convert to JSON value
            match serde_json::to_value(active_jobs) {
                Ok(json_active_jobs) => Ok(Json(ApiResponse::success(json_active_jobs))),
                Err(e) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse::error(format!(
                        "Failed to serialize active jobs: {}",
                        e
                    ))),
                )),
            }
        }
        Err(e) => {
            error!("Failed to get active jobs: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get active jobs: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_mounted_remotes_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::get_mounted_remotes;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_mounted_remotes(rclone_state).await {
        Ok(remotes) => {
            // Convert to JSON value
            match serde_json::to_value(remotes) {
                Ok(json_remotes) => Ok(Json(ApiResponse::success(json_remotes))),
                Err(e) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse::error(format!(
                        "Failed to serialize mounted remotes: {}",
                        e
                    ))),
                )),
            }
        }
        Err(e) => {
            error!("Failed to get mounted remotes: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get mounted remotes: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_settings_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::state::get_settings;

    match get_settings().await {
        Ok(settings) => Ok(Json(ApiResponse::success(settings))),
        Err(e) => {
            error!("Failed to get settings: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to get settings: {}", e))),
            ))
        }
    }
}

async fn load_settings_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::core::settings::operations::core::load_settings;

    let settings_state: tauri::State<
        rclone_manager_lib::utils::types::settings::SettingsState<tauri::Wry>,
    > = state.app_handle.state();

    match load_settings(settings_state).await {
        Ok(settings) => {
            // Convert to JSON value for API response
            match serde_json::to_value(settings) {
                Ok(json_settings) => Ok(Json(ApiResponse::success(json_settings))),
                Err(e) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse::error(format!(
                        "Failed to serialize settings: {}",
                        e
                    ))),
                )),
            }
        }
        Err(e) => {
            error!("Failed to load settings: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to load settings: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_rclone_info_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::get_rclone_info;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_rclone_info(rclone_state).await {
        Ok(info) => {
            // Convert to JSON value
            match serde_json::to_value(info) {
                Ok(json_info) => Ok(Json(ApiResponse::success(json_info))),
                Err(e) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse::error(format!(
                        "Failed to serialize rclone info: {}",
                        e
                    ))),
                )),
            }
        }
        Err(e) => {
            error!("Failed to get rclone info: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get rclone info: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_rclone_pid_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::get_rclone_pid;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_rclone_pid(rclone_state).await {
        Ok(pid) => {
            // Convert to JSON value
            match serde_json::to_value(pid) {
                Ok(json_pid) => Ok(Json(ApiResponse::success(json_pid))),
                Err(e) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse::error(format!(
                        "Failed to serialize rclone pid: {}",
                        e
                    ))),
                )),
            }
        }
        Err(e) => {
            error!("Failed to get rclone pid: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get rclone pid: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_memory_stats_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::get_memory_stats;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_memory_stats(rclone_state).await {
        Ok(stats) => {
            // Convert to JSON value
            match serde_json::to_value(stats) {
                Ok(json_stats) => Ok(Json(ApiResponse::success(json_stats))),
                Err(e) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse::error(format!(
                        "Failed to serialize memory stats: {}",
                        e
                    ))),
                )),
            }
        }
        Err(e) => {
            error!("Failed to get memory stats: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get memory stats: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_bandwidth_limit_handler(
    State(state): State<WebServerState>,
) -> Result<
    Json<ApiResponse<rclone_manager_lib::utils::types::all_types::BandwidthLimitResponse>>,
    (
        StatusCode,
        Json<ApiResponse<rclone_manager_lib::utils::types::all_types::BandwidthLimitResponse>>,
    ),
> {
    use rclone_manager_lib::rclone::queries::get_bandwidth_limit;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_bandwidth_limit(rclone_state).await {
        Ok(limit) => Ok(Json(ApiResponse::success(limit))),
        Err(e) => {
            error!("Failed to get bandwidth limit: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get bandwidth limit: {}",
                    e
                ))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct FsInfoQuery {
    remote: String,
    path: Option<String>,
}

async fn get_fs_info_handler(
    State(state): State<WebServerState>,
    Query(query): Query<FsInfoQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::get_fs_info;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_fs_info(query.remote, query.path, rclone_state).await {
        Ok(info) => Ok(Json(ApiResponse::success(info))),
        Err(e) => {
            error!("Failed to get fs info: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to get fs info: {}", e))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct DiskUsageQuery {
    remote: String,
    path: Option<String>,
}

async fn get_disk_usage_handler(
    State(state): State<WebServerState>,
    Query(query): Query<DiskUsageQuery>,
) -> Result<
    Json<ApiResponse<rclone_manager_lib::utils::types::all_types::DiskUsage>>,
    (
        StatusCode,
        Json<ApiResponse<rclone_manager_lib::utils::types::all_types::DiskUsage>>,
    ),
> {
    use rclone_manager_lib::rclone::queries::get_disk_usage;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_disk_usage(query.remote, query.path, rclone_state).await {
        Ok(usage) => Ok(Json(ApiResponse::success(usage))),
        Err(e) => {
            error!("Failed to get disk usage: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get disk usage: {}",
                    e
                ))),
            ))
        }
    }
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
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    use rclone_manager_lib::core::settings::remote::manager::save_remote_settings;

    let settings_state: tauri::State<
        rclone_manager_lib::utils::types::settings::SettingsState<tauri::Wry>,
    > = state.app_handle.state();

    match save_remote_settings(
        body.remote_name,
        body.settings,
        settings_state,
        state.app_handle.clone(),
    )
    .await
    {
        Ok(_) => Ok(Json(ApiResponse::success(
            "Remote settings saved successfully".to_string(),
        ))),
        Err(e) => {
            error!("Failed to save remote settings: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to save remote settings: {}",
                    e
                ))),
            ))
        }
    }
}

async fn is_network_metered_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<bool>>, (StatusCode, Json<ApiResponse<bool>>)> {
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
) -> Result<Json<ApiResponse<bool>>, (StatusCode, Json<ApiResponse<bool>>)> {
    use rclone_manager_lib::core::check_binaries::check_rclone_available;

    let path = query.path.as_deref().unwrap_or("");
    match check_rclone_available(state.app_handle.clone(), path).await {
        Ok(available) => Ok(Json(ApiResponse::success(available))),
        Err(e) => {
            error!("Failed to check rclone availability: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to check rclone availability: {}",
                    e
                ))),
            ))
        }
    }
}

async fn check_mount_plugin_installed_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<bool>>, (StatusCode, Json<ApiResponse<bool>>)> {
    use rclone_manager_lib::utils::rclone::mount::check_mount_plugin_installed;

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
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    use rclone_manager_lib::utils::process::process_manager::kill_process_by_pid;

    match kill_process_by_pid(query.pid) {
        Ok(_) => Ok(Json(ApiResponse::success(format!(
            "Process {} killed successfully",
            query.pid
        )))),
        Err(e) => {
            error!("Failed to kill process {}: {}", query.pid, e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to kill process {}: {}",
                    query.pid, e
                ))),
            ))
        }
    }
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
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    use rclone_manager_lib::core::settings::operations::core::save_setting;

    let settings_state: tauri::State<
        rclone_manager_lib::utils::types::settings::SettingsState<tauri::Wry>,
    > = state.app_handle.state();

    match save_setting(
        body.category,
        body.key,
        body.value,
        settings_state,
        state.app_handle.clone(),
    )
    .await
    {
        Ok(_) => Ok(Json(ApiResponse::success(
            "Setting saved successfully".to_string(),
        ))),
        Err(e) => {
            error!("Failed to save setting: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to save setting: {}", e))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct ResetSettingBody {
    category: String,
    key: String,
}

async fn reset_setting_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ResetSettingBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::core::settings::operations::core::reset_setting;

    let settings_state: tauri::State<
        rclone_manager_lib::utils::types::settings::SettingsState<tauri::Wry>,
    > = state.app_handle.state();

    match reset_setting(
        body.category,
        body.key,
        settings_state,
        state.app_handle.clone(),
    )
    .await
    {
        Ok(default_value) => Ok(Json(ApiResponse::success(default_value))),
        Err(e) => {
            error!("Failed to reset setting: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to reset setting: {}",
                    e
                ))),
            ))
        }
    }
}

async fn check_links_handler(
    State(_state): State<WebServerState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::utils::io::network::check_links;

    // Extract links from query parameters (multiple 'links' parameters)
    let links: Vec<String> = params
        .iter()
        .filter(|(key, _)| key == &"links")
        .map(|(_, value)| value.clone())
        .collect();

    if links.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiResponse::error("No links provided".to_string())),
        ));
    }

    let max_retries = params
        .get("maxRetries")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(2);

    let retry_delay_secs = params
        .get("retryDelaySecs")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(3);

    match check_links(links, max_retries, retry_delay_secs).await {
        Ok(result) => {
            // Convert CheckResult to JSON value
            match serde_json::to_value(result) {
                Ok(json_result) => Ok(Json(ApiResponse::success(json_result))),
                Err(e) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse::error(format!(
                        "Failed to serialize check result: {}",
                        e
                    ))),
                )),
            }
        }
        Err(e) => {
            error!("Failed to check links: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to check links: {}", e))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct CheckRcloneUpdateQuery {
    channel: Option<String>,
}

async fn check_rclone_update_handler(
    State(state): State<WebServerState>,
    Query(query): Query<CheckRcloneUpdateQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::utils::rclone::updater::check_rclone_update;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match check_rclone_update(state.app_handle.clone(), rclone_state, query.channel).await {
        Ok(result) => Ok(Json(ApiResponse::success(result))),
        Err(e) => {
            error!("Failed to check rclone update: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to check rclone update: {}",
                    e
                ))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct UpdateRcloneQuery {
    channel: Option<String>,
}

async fn update_rclone_handler(
    State(state): State<WebServerState>,
    Query(query): Query<UpdateRcloneQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::utils::rclone::updater::update_rclone;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match update_rclone(rclone_state, state.app_handle.clone(), query.channel).await {
        Ok(result) => Ok(Json(ApiResponse::success(result))),
        Err(e) => {
            error!("Failed to update rclone: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to update rclone: {}",
                    e
                ))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct ProvisionRcloneQuery {
    path: Option<String>,
}

async fn provision_rclone_handler(
    State(state): State<WebServerState>,
    Query(query): Query<ProvisionRcloneQuery>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    use rclone_manager_lib::utils::rclone::provision::provision_rclone;

    // Treat "null" string as None
    let path = query.path.filter(|p| p != "null");

    match provision_rclone(state.app_handle.clone(), path).await {
        Ok(message) => Ok(Json(ApiResponse::success(message))),
        Err(e) => {
            error!("Failed to provision rclone: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to provision rclone: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_cached_mounted_remotes_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::state::get_cached_mounted_remotes;

    match get_cached_mounted_remotes().await {
        Ok(mounted_remotes) => {
            // Convert to JSON value
            match serde_json::to_value(mounted_remotes) {
                Ok(json_mounted_remotes) => Ok(Json(ApiResponse::success(json_mounted_remotes))),
                Err(e) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse::error(format!(
                        "Failed to serialize cached mounted remotes: {}",
                        e
                    ))),
                )),
            }
        }
        Err(e) => {
            error!("Failed to get cached mounted remotes: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get cached mounted remotes: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_configs_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::state::get_configs;

    match get_configs().await {
        Ok(configs) => Ok(Json(ApiResponse::success(configs))),
        Err(e) => {
            error!("Failed to get configs: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to get configs: {}", e))),
            ))
        }
    }
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
                    yield Ok(Event::default().event(event.event).data(data));
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
