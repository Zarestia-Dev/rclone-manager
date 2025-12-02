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
use std::{
    collections::HashMap,
    convert::Infallible,
    sync::{Arc, atomic::AtomicBool},
};
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::Mutex;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};

// Re-export from lib
use rclone_manager_lib::core::lifecycle::startup::handle_startup;
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
use rclone_manager_lib::utils::types::settings::SettingsState;
use rclone_manager_lib::{
    rclone::state::scheduled_tasks::ScheduledTasksCache,
    utils::types::all_types::{JobCache, RcloneState},
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
            tauri::async_runtime::spawn(async move {
                info!("🌐 Starting web server spawn");
                if let Err(e) = start_web_server(app_handle_for_web, host, port).await {
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

async fn start_web_server(
    app_handle: AppHandle,
    host: String,
    port: u16,
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
        "rclone_api_url_updated",
        "engine_restarted",
        // RClone engine
        "rclone_engine_ready",
        "rclone_engine_error",
        "rclone_engine_password_error",
        "rclone_engine_path_error",
        "rclone_engine_updating",
        "rclone_password_stored",
        // Remote management & state changes
        "remote_state_changed",
        "remote_presence_changed",
        "remote_cache_updated",
        // System & settings
        "system_settings_changed",
        "bandwidth_limit_changed",
        "rclone_config_unlocked",
        // UI & cache events
        "tray_menu_updated",
        "job_cache_changed",
        "notify_ui",
        "mount_state_changed",
        "serve_state_changed",
        // Plugins / installs
        "mount_plugin_installed",
        // Network
        "network_status_changed",
        // Scheduled tasks
        "scheduled_task_error",
        "scheduled_task_completed",
        "scheduled_task_stopped",
        // App wide events
        "app_event",
        // UI-specific job events
        "ui_job_update",
        "ui_job_completed",
        // Other / updater
        "update-available",
        "update-downloaded",
        "download-progress",
        // OAuth
        "rclone_oauth",
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
        .route("/start-sync", post(start_sync_handler))
        .route("/start-copy", post(start_copy_handler))
        .route("/start-move", post(start_move_handler))
        .route("/start-bisync", post(start_bisync_handler))
        .route("/:id/status", get(get_job_status_handler))
        .with_state(state.clone());

    // Build API router
    let api_router = Router::new()
        .route("/remotes", get(get_remotes_handler))
        .route("/remote/:name", get(get_remote_config_handler))
        .route("/remote-types", get(get_remote_types_handler))
        .route("/stats", get(get_stats_handler))
        .route("/stats/filtered", get(get_core_stats_filtered_handler))
        .route("/transfers/completed", get(get_completed_transfers_handler))
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
        .route("/get-rclone-rc-url", get(get_rclone_rc_url_handler))
        .route("/memory-stats", get(get_memory_stats_handler))
        .route("/bandwidth/limit", get(get_bandwidth_limit_handler))
        .route("/fs/info", get(get_fs_info_handler))
        .route("/disk-usage", get(get_disk_usage_handler))
        .route("/get-local-drives", get(get_local_drives_handler))
        .route("/get-size", get(get_size_handler))
        .route("/mkdir", post(mkdir_handler))
        .route("/cleanup", post(cleanup_handler))
        .route("/copy-url", post(copy_url_handler))
        .route("/provision-rclone", get(provision_rclone_handler))
        .route("/remote/paths", post(get_remote_paths_handler))
        .route(
            "/get-cached-mounted-remotes",
            get(get_cached_mounted_remotes_handler),
        )
        .route("/get-cached-remotes", get(get_cached_remotes_handler))
        .route("/get-cached-serves", get(get_cached_serves_handler))
        .route("/serve/start", post(start_serve_handler))
        .route("/serve/stop", post(stop_serve_handler))
        .route("/handle-shutdown", post(handle_shutdown_handler))
        .route("/get-configs", get(get_configs_handler))
        .route("/save-remote-settings", post(save_remote_settings_handler))
        .route("/events", get(sse_handler))
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
        .route("/mount-remote", post(mount_remote_handler))
        .route("/unmount-remote", post(unmount_remote_handler))
        .route(
            "/get-grouped-options-with-values",
            get(get_grouped_options_with_values_handler),
        )
        .route("/flags/mount", get(get_mount_flags_handler))
        .route("/flags/copy", get(get_copy_flags_handler))
        .route("/flags/sync", get(get_sync_flags_handler))
        .route("/flags/filter", get(get_filter_flags_handler))
        .route("/flags/vfs", get(get_vfs_flags_handler))
        .route("/flags/backend", get(get_backend_flags_handler))
        .route("/serve/types", get(get_serve_types_handler))
        .route("/serve/flags", get(get_serve_flags_handler))
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
            "/get-oauth-supported-remotes",
            get(get_oauth_supported_remotes_handler),
        )
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
        .route("/mount-types", get(get_mount_types_handler))
        .route("/is-7z-available", get(is_7z_available_handler))
        .route(
            "/delete-remote-settings",
            post(delete_remote_settings_handler),
        )
        .route("/delete-remote", post(delete_remote_handler))
        .route("/get-remote-logs", get(get_remote_logs_handler))
        .route("/clear-remote-logs", get(clear_remote_logs_handler))
        // VFS endpoints
        .route("/vfs/list", get(vfs_list_handler))
        .route("/vfs/forget", post(vfs_forget_handler))
        .route("/vfs/refresh", post(vfs_refresh_handler))
        .route("/vfs/stats", get(vfs_stats_handler))
        .route("/vfs/poll-interval", post(vfs_poll_interval_handler))
        .route("/vfs/queue", get(vfs_queue_handler))
        .route("/vfs/queue/set-expiry", post(vfs_queue_set_expiry_handler))
        // Backup & Restore endpoints
        .route("/backup-settings", get(backup_settings_handler))
        .route("/analyze-backup-file", get(analyze_backup_file_handler))
        .route("/restore-settings", post(restore_settings_handler))
        .with_state(state.clone());

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
    info!("   GET  /api/stats/filtered - Get filtered core stats");
    info!("   GET  /api/transfers/completed - Get completed transfers");
    info!("   POST /api/remote/paths - List remote paths (body: {{ remote, path, options }})");
    info!("   GET  /api/jobs - Get active jobs");
    info!("   GET  /api/jobs/:id/status - Get job status");
    info!("   POST /api/jobs/start-sync - Start a sync job");
    info!("   POST /api/jobs/start-copy - Start a copy job");
    info!("   POST /api/jobs/start-move - Start a move job");
    info!("   POST /api/jobs/start-bisync - Start a bisync job");
    info!("   POST /api/jobs/stop - Stop a running job");
    info!("   GET  /api/get-scheduled-tasks - Get scheduled tasks");
    info!("   POST /api/toggle-scheduled-task - Toggle scheduled task");
    info!("   GET  /api/get-scheduled-tasks-stats - Get scheduled tasks stats");
    info!("   GET  /api/get-cached-encryption-status - Get cached encryption status");
    info!("   GET  /api/has-stored-password - Check if password is stored");
    info!("   GET  /api/is-config-encrypted-cached - Check cached config encryption");
    info!("   GET  /api/has-config-password-env - Check config password env var");
    info!("   POST /api/remove-config-password - Remove stored config password");
    info!("   GET  /api/validate-rclone-password - Validate rclone password");
    info!("   POST /api/store-config-password - Store config password");
    info!("   POST /api/unencrypt-config - Unencrypt config");
    info!("   POST /api/encrypt-config - Encrypt config");
    info!("   GET  /api/mount-types - Get mount types");
    info!("   POST /api/create-remote-interactive - Start non-interactive remote creation");
    info!("   POST /api/continue-create-remote-interactive - Continue remote creation flow");
    info!("   GET  /api/flags/mount - Get mount flags");
    info!("   GET  /api/flags/copy - Get copy flags");
    info!("   GET  /api/flags/sync - Get sync flags");
    info!("   GET  /api/flags/filter - Get filter flags");
    info!("   GET  /api/flags/vfs - Get vfs flags");
    info!("   GET  /api/flags/backend - Get backend flags");
    info!("   GET  /api/serve/types - Get serve types");
    info!("   GET  /api/serve/flags - Get serve flags (query param: serveType)");
    info!("   GET  /api/is-7z-available - Check if 7z (7-Zip) is installed/available");
    info!("   POST /api/delete-remote-settings - Delete remote settings (body: {{ remoteName }})");
    info!("   POST /api/delete-remote - Delete remote (body: {{ name }})");
    info!("   GET  /api/get-remote-logs - Get remote logs (query param: remoteName)");
    info!("   GET  /api/clear-remote-logs - Clear remote logs (query param: remoteName)");
    info!("   GET  /api/get-rclone-rc-url - Get rclone RC URL");
    info!("   GET  /api/get-local-drives - Get local drives");
    info!("   GET  /api/vfs/list - List active VFS");
    info!("   POST /api/vfs/forget - Forget VFS paths (body: {{ fs?, file? }})");
    info!("   POST /api/vfs/refresh - Refresh VFS cache (body: {{ fs?, dir?, recursive? }})");
    info!("   GET  /api/vfs/stats - Get VFS stats (query param: fs?)");
    info!("   POST /api/vfs/poll-interval - Get/set VFS poll interval (body: {{ fs?, interval?, timeout? }})");
    info!("   GET  /api/vfs/queue - Get VFS queue (query param: fs?)");
    info!("   POST /api/vfs/queue/set-expiry - Set VFS queue expiry (body: {{ fs?, id, expiry, relative? }})");
    info!("   GET  /api/backup-settings - Backup settings (query params: backupDir, exportType, password?, remoteName?, userNote?)");
    info!("   GET  /api/analyze-backup-file - Analyze backup file (query param: path)");
    info!("   POST /api/restore-settings - Restore settings (body: {{ backupPath, password? }})");

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

async fn get_remotes_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<Vec<String>>>, (StatusCode, Json<ApiResponse<Vec<String>>>)> {
    use rclone_manager_lib::rclone::state::cache::get_cached_remotes;
    let cache = state.app_handle.state::<RemoteCache>();
    match get_cached_remotes(cache).await {
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

    let rclone_state = state.app_handle.state::<RcloneState>();

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

async fn get_core_stats_filtered_handler(
    State(state): State<WebServerState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::stats::get_core_stats_filtered;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let jobid = params.get("jobid").and_then(|s| s.parse::<u64>().ok());

    let group = params.get("group").cloned();

    match get_core_stats_filtered(rclone_state, jobid, group).await {
        Ok(value) => Ok(Json(ApiResponse::success(value))),
        Err(e) => {
            error!("Failed to get filtered core stats: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get filtered core stats: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_completed_transfers_handler(
    State(state): State<WebServerState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::stats::get_completed_transfers;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let group = params.get("group").cloned();

    match get_completed_transfers(rclone_state, group).await {
        Ok(value) => Ok(Json(ApiResponse::success(value))),
        Err(e) => {
            error!("Failed to get completed transfers: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get completed transfers: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_jobs_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::state::job::get_jobs;
    let job_cache = state.app_handle.state::<JobCache>();
    match get_jobs(job_cache).await {
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
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::state::job::get_active_jobs;
    let job_cache = state.app_handle.state::<JobCache>();

    match get_active_jobs(job_cache).await {
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

#[derive(Deserialize)]
struct JobStatusQuery {
    jobid: u64,
}

async fn get_job_status_handler(
    State(state): State<WebServerState>,
    Query(query): Query<JobStatusQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::state::job::get_job_status;

    let job_cache = state.app_handle.state::<JobCache>();

    match get_job_status(job_cache, query.jobid).await {
        Ok(opt) => match opt {
            Some(j) => match serde_json::to_value(j) {
                Ok(json) => Ok(Json(ApiResponse::success(json))),
                Err(e) => {
                    error!("Failed to serialize job: {}", e);
                    Err((
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ApiResponse::error("Failed to serialize job".to_string())),
                    ))
                }
            },
            None => Ok(Json(ApiResponse::success(serde_json::Value::Null))),
        },
        Err(e) => {
            error!("Failed to get job status: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get job status: {}",
                    e
                ))),
            ))
        }
    }
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
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    use rclone_manager_lib::rclone::commands::job::stop_job;

    let job_cache = state.app_handle.state::<JobCache>();
    let scheduled_cache = state.app_handle.state::<ScheduledTasksCache>();
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match stop_job(
        state.app_handle.clone(),
        job_cache,
        scheduled_cache,
        body.jobid,
        body.remote_name,
        rclone_state,
    )
    .await
    {
        Ok(_) => Ok(Json(ApiResponse::success(
            "Job stopped successfully".to_string(),
        ))),
        Err(e) => {
            error!("Failed to stop job: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to stop job: {}", e))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct StartSyncBody {
    params: serde_json::Value,
}

async fn start_sync_handler(
    State(state): State<WebServerState>,
    Json(body): Json<StartSyncBody>,
) -> Result<Json<ApiResponse<u64>>, (StatusCode, Json<ApiResponse<u64>>)> {
    use rclone_manager_lib::rclone::commands::sync::{SyncParams, start_sync};

    let params_result: Result<SyncParams, _> = serde_json::from_value(body.params);

    let params = match params_result {
        Ok(p) => p,
        Err(e) => {
            error!("Invalid start_sync parameters: {}", e);
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ApiResponse::error(format!(
                    "Invalid start_sync parameters: {}",
                    e
                ))),
            ));
        }
    };

    let job_cache = state.app_handle.state::<JobCache>();
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match start_sync(state.app_handle.clone(), job_cache, rclone_state, params).await {
        Ok(jobid) => Ok(Json(ApiResponse::success(jobid))),
        Err(e) => {
            error!("Failed to start sync: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to start sync: {}", e))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct StartCopyBody {
    params: serde_json::Value,
}

async fn start_copy_handler(
    State(state): State<WebServerState>,
    Json(body): Json<StartCopyBody>,
) -> Result<Json<ApiResponse<u64>>, (StatusCode, Json<ApiResponse<u64>>)> {
    use rclone_manager_lib::rclone::commands::sync::{CopyParams, start_copy};

    let params_result: Result<CopyParams, _> = serde_json::from_value(body.params);

    let params = match params_result {
        Ok(p) => p,
        Err(e) => {
            error!("Invalid start_copy parameters: {}", e);
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ApiResponse::error(format!(
                    "Invalid start_copy parameters: {}",
                    e
                ))),
            ));
        }
    };

    let job_cache = state.app_handle.state::<JobCache>();
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match start_copy(state.app_handle.clone(), job_cache, rclone_state, params).await {
        Ok(jobid) => Ok(Json(ApiResponse::success(jobid))),
        Err(e) => {
            error!("Failed to start copy: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to start copy: {}", e))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct StartMoveBody {
    params: serde_json::Value,
}

async fn start_move_handler(
    State(state): State<WebServerState>,
    Json(body): Json<StartMoveBody>,
) -> Result<Json<ApiResponse<u64>>, (StatusCode, Json<ApiResponse<u64>>)> {
    use rclone_manager_lib::rclone::commands::sync::{MoveParams, start_move};

    let params_result: Result<MoveParams, _> = serde_json::from_value(body.params);

    let params = match params_result {
        Ok(p) => p,
        Err(e) => {
            error!("Invalid start_move parameters: {}", e);
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ApiResponse::error(format!(
                    "Invalid start_move parameters: {}",
                    e
                ))),
            ));
        }
    };

    let job_cache = state.app_handle.state::<JobCache>();
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match start_move(state.app_handle.clone(), job_cache, rclone_state, params).await {
        Ok(jobid) => Ok(Json(ApiResponse::success(jobid))),
        Err(e) => {
            error!("Failed to start move: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to start move: {}", e))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct StartBisyncBody {
    params: serde_json::Value,
}

async fn start_bisync_handler(
    State(state): State<WebServerState>,
    Json(body): Json<StartBisyncBody>,
) -> Result<Json<ApiResponse<u64>>, (StatusCode, Json<ApiResponse<u64>>)> {
    use rclone_manager_lib::rclone::commands::sync::{BisyncParams, start_bisync};

    let params_result: Result<BisyncParams, _> = serde_json::from_value(body.params);

    let params = match params_result {
        Ok(p) => p,
        Err(e) => {
            error!("Invalid start_bisync parameters: {}", e);
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ApiResponse::error(format!(
                    "Invalid start_bisync parameters: {}",
                    e
                ))),
            ));
        }
    };

    let job_cache = state.app_handle.state::<JobCache>();
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match start_bisync(state.app_handle.clone(), job_cache, rclone_state, params).await {
        Ok(jobid) => Ok(Json(ApiResponse::success(jobid))),
        Err(e) => {
            error!("Failed to start bisync: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to start bisync: {}", e))),
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
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::state::cache::get_settings;
    let cache = state.app_handle.state::<RemoteCache>();
    match get_settings(cache).await {
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

async fn get_rclone_rc_url_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)>
{
    use rclone_manager_lib::rclone::state::engine::get_rclone_rc_url;

    let url = get_rclone_rc_url();
    Ok(Json(ApiResponse::success(url)))
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

async fn get_local_drives_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<Vec<rclone_manager_lib::rclone::queries::filesystem::LocalDrive>>>, (StatusCode, Json<ApiResponse<Vec<rclone_manager_lib::rclone::queries::filesystem::LocalDrive>>>)>
{
    use rclone_manager_lib::rclone::queries::filesystem::get_local_drives;

    match get_local_drives().await {
        Ok(drives) => Ok(Json(ApiResponse::success(drives))),
        Err(e) => {
            error!("Failed to get local drives: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get local drives: {}",
                    e
                ))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct GetSizeQuery {
    remote: String,
    path: Option<String>,
}

async fn get_size_handler(
    State(state): State<WebServerState>,
    Query(query): Query<GetSizeQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::filesystem::get_size;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_size(query.remote, query.path, rclone_state).await {
        Ok(result) => Ok(Json(ApiResponse::success(result))),
        Err(e) => {
            error!("Failed to get size: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to get size: {}", e))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct MkdirBody {
    remote: String,
    path: String,
}

async fn mkdir_handler(
    State(state): State<WebServerState>,
    Json(body): Json<MkdirBody>,
) -> Result<Json<ApiResponse<()>>, (StatusCode, Json<ApiResponse<()>>)>
{
    use rclone_manager_lib::rclone::commands::filesystem::mkdir;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match mkdir(body.remote, body.path, rclone_state).await {
        Ok(_) => Ok(Json(ApiResponse::success(()))),
        Err(e) => {
            error!("Failed to create directory: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to create directory: {}", e))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct CleanupBody {
    remote: String,
    path: Option<String>,
}

async fn cleanup_handler(
    State(state): State<WebServerState>,
    Json(body): Json<CleanupBody>,
) -> Result<Json<ApiResponse<()>>, (StatusCode, Json<ApiResponse<()>>)>
{
    use rclone_manager_lib::rclone::commands::filesystem::cleanup;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match cleanup(body.remote, body.path, rclone_state).await {
        Ok(_) => Ok(Json(ApiResponse::success(()))),
        Err(e) => {
            error!("Failed to cleanup remote: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to cleanup remote: {}", e))),
            ))
        }
    }
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
) -> Result<Json<ApiResponse<u64>>, (StatusCode, Json<ApiResponse<u64>>)>
{
    use rclone_manager_lib::rclone::commands::filesystem::copy_url;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match copy_url(
        state.app_handle.clone(),
        rclone_state,
        body.remote,
        body.path,
        body.url_to_copy,
        body.auto_filename,
    )
    .await
    {
        Ok(jobid) => Ok(Json(ApiResponse::success(jobid))),
        Err(e) => {
            error!("Failed to copy URL: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to copy URL: {}", e))),
            ))
        }
    }
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
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
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

    match get_remote_paths(body.remote, body.path, options, rclone_state).await {
        Ok(value) => Ok(Json(ApiResponse::success(value))),
        Err(e) => {
            error!("Failed to list remote paths: {}", e);
            Err((
                StatusCode::BAD_REQUEST,
                Json(ApiResponse::error(format!(
                    "Failed to list remote paths: {}",
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
    let task_cache = state.app_handle.state::<ScheduledTasksCache>();
    let cron_cache = state.app_handle.state::<CronScheduler>();

    match save_remote_settings(
        body.remote_name,
        body.settings,
        settings_state,
        task_cache,
        cron_cache,
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

async fn is_7z_available_handler(
    State(_state): State<WebServerState>,
) -> Result<Json<ApiResponse<Option<String>>>, (StatusCode, Json<ApiResponse<Option<String>>>)> {
    use rclone_manager_lib::core::check_binaries::is_7z_available;

    match is_7z_available() {
        Some(path) => Ok(Json(ApiResponse::success(Some(path)))),
        None => Ok(Json(ApiResponse::success(None))),
    }
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
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::state::cache::get_cached_mounted_remotes;
    let cache = state.app_handle.state::<RemoteCache>();
    match get_cached_mounted_remotes(cache).await {
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

async fn get_cached_serves_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::state::cache::get_cached_serves;
    let cache = state.app_handle.state::<RemoteCache>();
    match get_cached_serves(cache).await {
        Ok(serves) => {
            // Convert to JSON value
            match serde_json::to_value(serves) {
                Ok(json_serves) => Ok(Json(ApiResponse::success(json_serves))),
                Err(e) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse::error(format!(
                        "Failed to serialize cached serves: {}",
                        e
                    ))),
                )),
            }
        }
        Err(e) => {
            error!("Failed to get cached serves: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get cached serves: {}",
                    e
                ))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct StartServeBody {
    params: serde_json::Value,
}

async fn start_serve_handler(
    State(state): State<WebServerState>,
    Json(body): Json<StartServeBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::commands::serve::{ServeParams, start_serve};

    let params_result: Result<ServeParams, _> = serde_json::from_value(body.params);

    let params = match params_result {
        Ok(p) => p,
        Err(e) => {
            error!("Invalid start_serve parameters: {}", e);
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ApiResponse::error(format!(
                    "Invalid start_serve parameters: {}",
                    e
                ))),
            ));
        }
    };

    let job_cache = state.app_handle.state::<JobCache>();
    match start_serve(state.app_handle.clone(), job_cache, params).await {
        Ok(resp) => Ok(Json(ApiResponse::success(
            serde_json::to_value(resp).unwrap(),
        ))),
        Err(e) => {
            error!("Failed to start serve: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to start serve: {}", e))),
            ))
        }
    }
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
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    use rclone_manager_lib::rclone::commands::serve::stop_serve;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match stop_serve(
        state.app_handle.clone(),
        body.server_id,
        body.remote_name,
        rclone_state,
    )
    .await
    {
        Ok(msg) => Ok(Json(ApiResponse::success(msg))),
        Err(e) => {
            error!("Failed to stop serve: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to stop serve: {}", e))),
            ))
        }
    }
}

async fn handle_shutdown_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    // Spawn shutdown task so we can return a response to the HTTP client.
    let app_handle = state.app_handle.clone();
    tokio::spawn(async move {
        handle_shutdown(app_handle).await;
    });

    Ok(Json(ApiResponse::success("Shutdown initiated".to_string())))
}

async fn get_configs_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::state::cache::get_configs;
    let cache = state.app_handle.state::<RemoteCache>();
    match get_configs(cache).await {
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

#[derive(Deserialize)]
struct ReloadScheduledTasksBody {
    remote_configs: serde_json::Value,
}

async fn reload_scheduled_tasks_from_configs_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ReloadScheduledTasksBody>,
) -> Result<Json<ApiResponse<usize>>, (StatusCode, Json<ApiResponse<usize>>)> {
    use rclone_manager_lib::rclone::state::scheduled_tasks::reload_scheduled_tasks_from_configs;

    let cache = state.app_handle.state::<ScheduledTasksCache>();
    let scheduler = state.app_handle.state::<CronScheduler>();

    match reload_scheduled_tasks_from_configs(cache, scheduler, body.remote_configs).await {
        Ok(count) => Ok(Json(ApiResponse::success(count))),
        Err(e) => {
            error!("Failed to reload scheduled tasks from configs: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to reload scheduled tasks from configs: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_scheduled_tasks_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::state::scheduled_tasks::get_scheduled_tasks;

    let cache = state.app_handle.state::<ScheduledTasksCache>();

    match get_scheduled_tasks(cache).await {
        Ok(tasks) => {
            // Convert to JSON value
            match serde_json::to_value(tasks) {
                Ok(json_tasks) => Ok(Json(ApiResponse::success(json_tasks))),
                Err(e) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse::error(format!(
                        "Failed to serialize scheduled tasks: {}",
                        e
                    ))),
                )),
            }
        }
        Err(e) => {
            error!("Failed to get scheduled tasks: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get scheduled tasks: {}",
                    e
                ))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct ToggleScheduledTaskBody {
    #[serde(rename = "taskId")]
    task_id: String,
}

async fn toggle_scheduled_task_handler(
    State(state): State<WebServerState>,
    Json(body): Json<ToggleScheduledTaskBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::core::scheduler::commands::toggle_scheduled_task;

    let cache = state.app_handle.state::<ScheduledTasksCache>();
    let scheduler = state.app_handle.state::<CronScheduler>();

    match toggle_scheduled_task(cache, scheduler, body.task_id).await {
        Ok(task) => {
            // Convert to JSON value
            match serde_json::to_value(task) {
                Ok(json_task) => Ok(Json(ApiResponse::success(json_task))),
                Err(e) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse::error(format!(
                        "Failed to serialize toggled task: {}",
                        e
                    ))),
                )),
            }
        }
        Err(e) => {
            error!("Failed to toggle scheduled task: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to toggle scheduled task: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_scheduled_tasks_stats_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::state::scheduled_tasks::get_scheduled_tasks_stats;

    let cache = state.app_handle.state::<ScheduledTasksCache>();

    match get_scheduled_tasks_stats(cache).await {
        Ok(stats) => {
            // Convert to JSON value
            match serde_json::to_value(stats) {
                Ok(json_stats) => Ok(Json(ApiResponse::success(json_stats))),
                Err(e) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse::error(format!(
                        "Failed to serialize scheduled tasks stats: {}",
                        e
                    ))),
                )),
            }
        }
        Err(e) => {
            error!("Failed to get scheduled tasks stats: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get scheduled tasks stats: {}",
                    e
                ))),
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
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    let job_cache = state.app_handle.state::<JobCache>();
    let remote_cache = state.app_handle.state::<RemoteCache>();

    match mount_remote(
        state.app_handle.clone(),
        job_cache,
        remote_cache,
        body.params,
    )
    .await
    {
        Ok(_) => Ok(Json(ApiResponse::success(
            "Remote mounted successfully".to_string(),
        ))),
        Err(e) => {
            error!("Failed to mount remote: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to mount remote: {}", e))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct MountRemoteBody {
    params: MountParams,
}

async fn unmount_remote_handler(
    State(state): State<WebServerState>,
    Json(body): Json<UnmountRemoteBody>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    use rclone_manager_lib::rclone::commands::mount::unmount_remote;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match unmount_remote(
        state.app_handle.clone(),
        body.mount_point,
        body.remote_name,
        rclone_state,
    )
    .await
    {
        Ok(message) => Ok(Json(ApiResponse::success(message))),
        Err(e) => {
            error!("Failed to unmount remote: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to unmount remote: {}",
                    e
                ))),
            ))
        }
    }
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
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::flags::get_grouped_options_with_values;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_grouped_options_with_values(rclone_state).await {
        Ok(options) => Ok(Json(ApiResponse::success(options))),
        Err(e) => {
            error!("Failed to get grouped options with values: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get grouped options with values: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_mount_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::flags::get_mount_flags;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_mount_flags(rclone_state).await {
        Ok(flags) => match serde_json::to_value(flags) {
            Ok(json_flags) => Ok(Json(ApiResponse::success(json_flags))),
            Err(e) => Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to serialize mount flags: {}",
                    e
                ))),
            )),
        },
        Err(e) => {
            error!("Failed to get mount flags: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get mount flags: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_copy_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::flags::get_copy_flags;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_copy_flags(rclone_state).await {
        Ok(flags) => match serde_json::to_value(flags) {
            Ok(json_flags) => Ok(Json(ApiResponse::success(json_flags))),
            Err(e) => Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to serialize copy flags: {}",
                    e
                ))),
            )),
        },
        Err(e) => {
            error!("Failed to get copy flags: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get copy flags: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_sync_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::flags::get_sync_flags;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_sync_flags(rclone_state).await {
        Ok(flags) => match serde_json::to_value(flags) {
            Ok(json_flags) => Ok(Json(ApiResponse::success(json_flags))),
            Err(e) => Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to serialize sync flags: {}",
                    e
                ))),
            )),
        },
        Err(e) => {
            error!("Failed to get sync flags: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get sync flags: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_filter_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::flags::get_filter_flags;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_filter_flags(rclone_state).await {
        Ok(flags) => match serde_json::to_value(flags) {
            Ok(json_flags) => Ok(Json(ApiResponse::success(json_flags))),
            Err(e) => Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to serialize filter flags: {}",
                    e
                ))),
            )),
        },
        Err(e) => {
            error!("Failed to get filter flags: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get filter flags: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_vfs_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::flags::get_vfs_flags;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_vfs_flags(rclone_state).await {
        Ok(flags) => match serde_json::to_value(flags) {
            Ok(json_flags) => Ok(Json(ApiResponse::success(json_flags))),
            Err(e) => Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to serialize vfs flags: {}",
                    e
                ))),
            )),
        },
        Err(e) => {
            error!("Failed to get vfs flags: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get vfs flags: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_backend_flags_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::flags::get_backend_flags;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_backend_flags(rclone_state).await {
        Ok(flags) => match serde_json::to_value(flags) {
            Ok(json_flags) => Ok(Json(ApiResponse::success(json_flags))),
            Err(e) => Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to serialize backend flags: {}",
                    e
                ))),
            )),
        },
        Err(e) => {
            error!("Failed to get backend flags: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get backend flags: {}",
                    e
                ))),
            ))
        }
    }
}

async fn save_rclone_backend_option_handler(
    State(state): State<WebServerState>,
    Json(body): Json<SaveRCloneBackendOptionBody>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    use rclone_manager_lib::core::settings::rclone_backend::save_rclone_backend_option;

    match save_rclone_backend_option(
        state.app_handle.clone(),
        body.block,
        body.option,
        body.value,
    )
    .await
    {
        Ok(_) => Ok(Json(ApiResponse::success(
            "RClone backend option saved successfully".to_string(),
        ))),
        Err(e) => {
            error!("Failed to save RClone backend option: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to save RClone backend option: {}",
                    e
                ))),
            ))
        }
    }
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
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::flags::set_rclone_option;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match set_rclone_option(rclone_state, body.block_name, body.option_name, body.value).await {
        Ok(result) => Ok(Json(ApiResponse::success(result))),
        Err(e) => {
            error!("Failed to set RClone option: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to set RClone option: {}",
                    e
                ))),
            ))
        }
    }
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
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    use rclone_manager_lib::core::settings::rclone_backend::remove_rclone_backend_option;

    match remove_rclone_backend_option(state.app_handle.clone(), body.block, body.option).await {
        Ok(_) => Ok(Json(ApiResponse::success(
            "RClone backend option removed successfully".to_string(),
        ))),
        Err(e) => {
            error!("Failed to remove RClone backend option: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to remove RClone backend option: {}",
                    e
                ))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct RemoveRCloneBackendOptionBody {
    block: String,
    option: String,
}

async fn get_oauth_supported_remotes_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::get_oauth_supported_remotes;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_oauth_supported_remotes(rclone_state).await {
        Ok(remotes) => {
            // Convert to JSON value
            match serde_json::to_value(remotes) {
                Ok(json_remotes) => Ok(Json(ApiResponse::success(json_remotes))),
                Err(e) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse::error(format!(
                        "Failed to serialize OAuth supported remotes: {}",
                        e
                    ))),
                )),
            }
        }
        Err(e) => {
            error!("Failed to get OAuth supported remotes: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get OAuth supported remotes: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_cached_remotes_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<Vec<String>>>, (StatusCode, Json<ApiResponse<Vec<String>>>)> {
    use rclone_manager_lib::rclone::state::cache::get_cached_remotes;
    let cache = state.app_handle.state::<RemoteCache>();
    match get_cached_remotes(cache).await {
        Ok(remotes) => {
            info!("Fetched cached remotes: {:?}", remotes);
            Ok(Json(ApiResponse::success(remotes)))
        }
        Err(e) => {
            error!("Failed to get cached remotes: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get cached remotes: {}",
                    e
                ))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct CreateRemoteBody {
    name: String,
    parameters: serde_json::Value,
}

async fn create_remote_handler(
    State(state): State<WebServerState>,
    Json(body): Json<CreateRemoteBody>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match create_remote(
        state.app_handle.clone(),
        body.name,
        body.parameters,
        rclone_state,
    )
    .await
    {
        Ok(_) => Ok(Json(ApiResponse::success(
            "Remote created successfully".to_string(),
        ))),
        Err(e) => {
            error!("Failed to create remote: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to create remote: {}",
                    e
                ))),
            ))
        }
    }
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
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::commands::remote::create_remote_interactive;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let rclone_type = body
        .rclone_type
        .clone()
        .or(body.rclone_type_alt.clone())
        .unwrap_or_else(|| "".to_string());

    match create_remote_interactive(
        state.app_handle.clone(),
        body.name,
        rclone_type,
        body.parameters,
        body.opt,
        rclone_state,
    )
    .await
    {
        Ok(value) => Ok(Json(ApiResponse::success(value))),
        Err(e) => {
            error!("Failed to create remote interactively: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to create remote interactively: {}",
                    e
                ))),
            ))
        }
    }
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
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::commands::remote::continue_create_remote_interactive;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    let state_token = body
        .state_token
        .clone()
        .or(body.state_token_alt.clone())
        .unwrap_or_else(|| "".to_string());

    match continue_create_remote_interactive(
        state.app_handle.clone(),
        body.name,
        state_token,
        body.result,
        body.parameters,
        body.opt,
        rclone_state,
    )
    .await
    {
        Ok(value) => Ok(Json(ApiResponse::success(value))),
        Err(e) => {
            error!("Failed to continue remote creation flow: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to continue remote creation flow: {}",
                    e
                ))),
            ))
        }
    }
}

async fn quit_rclone_oauth_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    use rclone_manager_lib::rclone::commands::system::quit_rclone_oauth;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match quit_rclone_oauth(rclone_state).await {
        Ok(_) => Ok(Json(ApiResponse::success(
            "RClone OAuth process quit successfully".to_string(),
        ))),
        Err(e) => {
            error!("Failed to quit RClone OAuth process: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to quit RClone OAuth process: {}",
                    e
                ))),
            ))
        }
    }
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
) -> Result<Json<ApiResponse<bool>>, (StatusCode, Json<ApiResponse<bool>>)> {
    use rclone_manager_lib::core::security::commands::has_stored_password;

    let credential_store = state
        .app_handle
        .state::<rclone_manager_lib::core::security::CredentialStore>();

    match has_stored_password(credential_store).await {
        Ok(has_password) => Ok(Json(ApiResponse::success(has_password))),
        Err(e) => {
            error!("Failed to check if password is stored: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to check if password is stored: {}",
                    e
                ))),
            ))
        }
    }
}

async fn is_config_encrypted_cached_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<bool>>, (StatusCode, Json<ApiResponse<bool>>)> {
    use rclone_manager_lib::core::security::commands::is_config_encrypted_cached;

    match is_config_encrypted_cached(state.app_handle.clone()).await {
        Ok(is_encrypted) => Ok(Json(ApiResponse::success(is_encrypted))),
        Err(e) => {
            error!("Failed to check cached config encryption status: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to check cached config encryption status: {}",
                    e
                ))),
            ))
        }
    }
}

async fn has_config_password_env_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<bool>>, (StatusCode, Json<ApiResponse<bool>>)> {
    use rclone_manager_lib::core::security::commands::has_config_password_env;

    let env_manager = state
        .app_handle
        .state::<rclone_manager_lib::core::security::SafeEnvironmentManager>();

    match has_config_password_env(env_manager).await {
        Ok(has_password) => Ok(Json(ApiResponse::success(has_password))),
        Err(e) => {
            error!(
                "Failed to check if config password environment variable is set: {}",
                e
            );
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to check if config password environment variable is set: {}",
                    e
                ))),
            ))
        }
    }
}

async fn remove_config_password_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    use rclone_manager_lib::core::security::commands::remove_config_password;

    let env_manager = state
        .app_handle
        .state::<rclone_manager_lib::core::security::SafeEnvironmentManager>();
    let credential_store = state
        .app_handle
        .state::<rclone_manager_lib::core::security::CredentialStore>();

    match remove_config_password(env_manager, credential_store).await {
        Ok(()) => Ok(Json(ApiResponse::success(
            "Password removed successfully".to_string(),
        ))),
        Err(e) => {
            error!("Failed to remove config password: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to remove config password: {}",
                    e
                ))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct ValidateRclonePasswordQuery {
    password: String,
}

async fn validate_rclone_password_handler(
    State(state): State<WebServerState>,
    Query(query): Query<ValidateRclonePasswordQuery>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    use rclone_manager_lib::core::security::commands::validate_rclone_password;

    match validate_rclone_password(state.app_handle.clone(), query.password).await {
        Ok(()) => Ok(Json(ApiResponse::success(
            "Password validation successful".to_string(),
        ))),
        Err(e) => {
            error!("Failed to validate rclone password: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to validate rclone password: {}",
                    e
                ))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct StoreConfigPasswordBody {
    password: String,
}

async fn store_config_password_handler(
    State(state): State<WebServerState>,
    Json(body): Json<StoreConfigPasswordBody>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    use rclone_manager_lib::core::security::commands::store_config_password;

    let env_manager = state
        .app_handle
        .state::<rclone_manager_lib::core::security::SafeEnvironmentManager>();
    let credential_store = state
        .app_handle
        .state::<rclone_manager_lib::core::security::CredentialStore>();

    match store_config_password(
        state.app_handle.clone(),
        env_manager,
        credential_store,
        body.password,
    )
    .await
    {
        Ok(()) => Ok(Json(ApiResponse::success(
            "Password stored successfully".to_string(),
        ))),
        Err(e) => {
            error!("Failed to store config password: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to store config password: {}",
                    e
                ))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct UnencryptConfigBody {
    password: String,
}

async fn unencrypt_config_handler(
    State(state): State<WebServerState>,
    Json(body): Json<UnencryptConfigBody>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    use rclone_manager_lib::core::security::commands::unencrypt_config;

    let env_manager = state
        .app_handle
        .state::<rclone_manager_lib::core::security::SafeEnvironmentManager>();

    match unencrypt_config(state.app_handle.clone(), env_manager, body.password).await {
        Ok(()) => Ok(Json(ApiResponse::success(
            "Configuration unencrypted successfully".to_string(),
        ))),
        Err(e) => {
            error!("Failed to unencrypt config: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to unencrypt config: {}",
                    e
                ))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct EncryptConfigBody {
    password: String,
}

async fn encrypt_config_handler(
    State(state): State<WebServerState>,
    Json(body): Json<EncryptConfigBody>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    use rclone_manager_lib::core::security::commands::encrypt_config;

    let env_manager = state
        .app_handle
        .state::<rclone_manager_lib::core::security::SafeEnvironmentManager>();
    let credential_store = state
        .app_handle
        .state::<rclone_manager_lib::core::security::CredentialStore>();

    match encrypt_config(
        state.app_handle.clone(),
        env_manager,
        credential_store,
        body.password,
    )
    .await
    {
        Ok(()) => Ok(Json(ApiResponse::success(
            "Configuration encrypted successfully".to_string(),
        ))),
        Err(e) => {
            error!("Failed to encrypt config: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to encrypt config: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_mount_types_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::get_mount_types;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_mount_types(rclone_state).await {
        Ok(types) => {
            // Convert to JSON value
            match serde_json::to_value(types) {
                Ok(json_types) => Ok(Json(ApiResponse::success(json_types))),
                Err(e) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse::error(format!(
                        "Failed to serialize mount types: {}",
                        e
                    ))),
                )),
            }
        }
        Err(e) => {
            error!("Failed to get mount types: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get mount types: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_serve_types_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::serve::get_serve_types;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match get_serve_types(rclone_state).await {
        Ok(types) => match serde_json::to_value(types) {
            Ok(value) => Ok(Json(ApiResponse::success(value))),
            Err(e) => Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to serialize serve types: {}",
                    e
                ))),
            )),
        },
        Err(e) => {
            error!("Failed to get serve types: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get serve types: {}",
                    e
                ))),
            ))
        }
    }
}

async fn get_serve_flags_handler(
    State(state): State<WebServerState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::serve::get_serve_flags;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    // Accept both serveType and serve_type query param names
    let serve_type = params
        .get("serveType")
        .cloned()
        .or_else(|| params.get("serve_type").cloned())
        .unwrap_or_else(|| "".to_string());

    match get_serve_flags(serve_type, rclone_state).await {
        Ok(flags) => match serde_json::to_value(flags) {
            Ok(value) => Ok(Json(ApiResponse::success(value))),
            Err(e) => Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to serialize serve flags: {}",
                    e
                ))),
            )),
        },
        Err(e) => {
            error!("Failed to get serve flags: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get serve flags: {}",
                    e
                ))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct DeleteRemoteSettingsBody {
    #[serde(rename = "remoteName")]
    remote_name: String,
}

async fn delete_remote_settings_handler(
    State(state): State<WebServerState>,
    Json(body): Json<DeleteRemoteSettingsBody>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    use rclone_manager_lib::core::settings::remote::manager::delete_remote_settings;

    let settings_state: tauri::State<
        rclone_manager_lib::utils::types::settings::SettingsState<tauri::Wry>,
    > = state.app_handle.state();

    match delete_remote_settings(body.remote_name, settings_state, state.app_handle.clone()).await {
        Ok(_) => Ok(Json(ApiResponse::success(
            "Remote settings deleted successfully".to_string(),
        ))),
        Err(e) => {
            error!("Failed to delete remote settings: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to delete remote settings: {}",
                    e
                ))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct DeleteRemoteBody {
    name: String,
}

async fn delete_remote_handler(
    State(state): State<WebServerState>,
    Json(body): Json<DeleteRemoteBody>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    use rclone_manager_lib::rclone::commands::remote::delete_remote;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();
    let cache = state.app_handle.state::<ScheduledTasksCache>();
    let scheduler = state.app_handle.state::<CronScheduler>();

    match delete_remote(
        state.app_handle.clone(),
        body.name,
        rclone_state,
        cache,
        scheduler,
    )
    .await
    {
        Ok(_) => Ok(Json(ApiResponse::success(
            "Remote deleted successfully".to_string(),
        ))),
        Err(e) => {
            error!("Failed to delete remote: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to delete remote: {}",
                    e
                ))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct RemoteLogsQuery {
    #[serde(rename = "remoteName")]
    remote_name: Option<String>,
}

async fn get_remote_logs_handler(
    State(state): State<WebServerState>,
    Query(query): Query<RemoteLogsQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::state::log::get_remote_logs;

    let log_cache = state.app_handle.state::<LogCache>();

    match get_remote_logs(log_cache, query.remote_name).await {
        Ok(logs) => {
            // Convert to JSON value
            match serde_json::to_value(logs) {
                Ok(json_logs) => Ok(Json(ApiResponse::success(json_logs))),
                Err(e) => Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse::error(format!(
                        "Failed to serialize remote logs: {}",
                        e
                    ))),
                )),
            }
        }
        Err(e) => {
            error!("Failed to get remote logs: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to get remote logs: {}",
                    e
                ))),
            ))
        }
    }
}

async fn clear_remote_logs_handler(
    State(state): State<WebServerState>,
    Query(query): Query<RemoteLogsQuery>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    use rclone_manager_lib::rclone::state::log::clear_remote_logs;

    let log_cache = state.app_handle.state::<LogCache>();

    match clear_remote_logs(log_cache, query.remote_name).await {
        Ok(_) => Ok(Json(ApiResponse::success(
            "Remote logs cleared successfully".to_string(),
        ))),
        Err(e) => {
            error!("Failed to clear remote logs: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!(
                    "Failed to clear remote logs: {}",
                    e
                ))),
            ))
        }
    }
}

// ============================================================================
// VFS Handlers
// ============================================================================

async fn vfs_list_handler(
    State(state): State<WebServerState>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::vfs::vfs_list;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match vfs_list(rclone_state).await {
        Ok(value) => Ok(Json(ApiResponse::success(value))),
        Err(e) => {
            error!("Failed to list VFS: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to list VFS: {}", e))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct VfsForgetBody {
    fs: Option<String>,
    file: Option<String>,
}

async fn vfs_forget_handler(
    State(state): State<WebServerState>,
    Json(body): Json<VfsForgetBody>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::vfs::vfs_forget;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match vfs_forget(rclone_state, body.fs, body.file).await {
        Ok(value) => Ok(Json(ApiResponse::success(value))),
        Err(e) => {
            error!("Failed to forget VFS paths: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to forget VFS paths: {}", e))),
            ))
        }
    }
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
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::vfs::vfs_refresh;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match vfs_refresh(rclone_state, body.fs, body.dir, body.recursive).await {
        Ok(value) => Ok(Json(ApiResponse::success(value))),
        Err(e) => {
            error!("Failed to refresh VFS cache: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to refresh VFS cache: {}", e))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct VfsStatsQuery {
    fs: Option<String>,
}

async fn vfs_stats_handler(
    State(state): State<WebServerState>,
    Query(query): Query<VfsStatsQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::vfs::vfs_stats;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match vfs_stats(rclone_state, query.fs).await {
        Ok(value) => Ok(Json(ApiResponse::success(value))),
        Err(e) => {
            error!("Failed to get VFS stats: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to get VFS stats: {}", e))),
            ))
        }
    }
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
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::vfs::vfs_poll_interval;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match vfs_poll_interval(rclone_state, body.fs, body.interval, body.timeout).await {
        Ok(value) => Ok(Json(ApiResponse::success(value))),
        Err(e) => {
            error!("Failed to get/set VFS poll interval: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to get/set VFS poll interval: {}", e))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct VfsQueueQuery {
    fs: Option<String>,
}

async fn vfs_queue_handler(
    State(state): State<WebServerState>,
    Query(query): Query<VfsQueueQuery>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::vfs::vfs_queue;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match vfs_queue(rclone_state, query.fs).await {
        Ok(value) => Ok(Json(ApiResponse::success(value))),
        Err(e) => {
            error!("Failed to get VFS queue: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to get VFS queue: {}", e))),
            ))
        }
    }
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
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    use rclone_manager_lib::rclone::queries::vfs::vfs_queue_set_expiry;

    let rclone_state: tauri::State<RcloneState> = state.app_handle.state();

    match vfs_queue_set_expiry(rclone_state, body.fs, body.id, body.expiry, body.relative).await {
        Ok(value) => Ok(Json(ApiResponse::success(value))),
        Err(e) => {
            error!("Failed to set VFS queue expiry: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to set VFS queue expiry: {}", e))),
            ))
        }
    }
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
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)>
{
    use rclone_manager_lib::core::settings::backup::backup_manager::backup_settings;

    let settings_state: tauri::State<SettingsState<tauri::Wry>> = state.app_handle.state();

    match backup_settings(
        query.backup_dir,
        query.export_type,
        query.password,
        query.remote_name,
        query.user_note,
        settings_state,
        state.app_handle.clone(),
    )
    .await
    {
        Ok(result) => Ok(Json(ApiResponse::success(result))),
        Err(e) => {
            error!("Failed to backup settings: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to backup settings: {}", e))),
            ))
        }
    }
}

#[derive(Deserialize)]
struct AnalyzeBackupFileQuery {
    path: String,
}

async fn analyze_backup_file_handler(
    State(_state): State<WebServerState>,
    Query(query): Query<AnalyzeBackupFileQuery>,
) -> Result<Json<ApiResponse<rclone_manager_lib::utils::types::backup_types::BackupAnalysis>>, (StatusCode, Json<ApiResponse<rclone_manager_lib::utils::types::backup_types::BackupAnalysis>>)>
{
    use rclone_manager_lib::core::settings::backup::backup_manager::analyze_backup_file;
    use std::path::PathBuf;

    let path = PathBuf::from(query.path);
    
    match analyze_backup_file(path).await {
        Ok(analysis) => Ok(Json(ApiResponse::success(analysis))),
        Err(e) => {
            error!("Failed to analyze backup file: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to analyze backup file: {}", e))),
            ))
        }
    }
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
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)>
{
    use rclone_manager_lib::core::settings::backup::restore_manager::restore_settings;
    use std::path::PathBuf;

    let settings_state: tauri::State<SettingsState<tauri::Wry>> = state.app_handle.state();
    let backup_path = PathBuf::from(body.backup_path);

    match restore_settings(
        backup_path,
        body.password,
        settings_state,
        state.app_handle.clone(),
    )
    .await
    {
        Ok(result) => Ok(Json(ApiResponse::success(result))),
        Err(e) => {
            error!("Failed to restore settings: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse::error(format!("Failed to restore settings: {}", e))),
            ))
        }
    }
}
