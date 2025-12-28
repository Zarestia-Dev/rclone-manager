use log::{debug, error, info};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::core::settings::schema::AppSettings;
use crate::{
    core::{event_listener::setup_event_listener, scheduler::engine::CronScheduler},
    rclone::{
        commands::system::set_bandwidth_limit,
        queries::flags::set_rclone_option,
        state::{
            scheduled_tasks::ScheduledTasksCache,
            watcher::{start_mounted_remote_watcher, start_serve_watcher},
        },
    },
    utils::types::all_types::{RcApiEngine, RcloneState},
};

#[cfg(all(desktop, not(feature = "web-server")))]
use crate::utils::app::builder::setup_tray;

/// Get the directory containing the executable (for portable mode)
#[cfg(feature = "portable")]
fn get_executable_directory() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|e| format!("Failed to get executable path: {e}"))?
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "Failed to get executable directory".to_string())
}

// ============================================================================
// Rclone State Initialization
// ============================================================================

/// Initializes Rclone API and OAuth state, and launches the Rclone engine.
pub fn init_rclone_state(
    app_handle: &tauri::AppHandle,
    _settings: &AppSettings,
) -> Result<(), String> {
    // BACKEND_MANAGER is already initialized with default ports (51900, 51901)
    // Load any persistent connections
    use crate::rclone::backend::BACKEND_MANAGER;
    tauri::async_runtime::block_on(async {
        // Load persistent connections
        let settings_state = app_handle.state::<rcman::SettingsManager<rcman::JsonStorage>>();
        if let Err(e) = BACKEND_MANAGER
            .load_from_settings(settings_state.inner())
            .await
        {
            error!("Failed to load persistent connections: {e}");
        }
    });

    let mut engine = RcApiEngine::lock_engine()?;
    engine.init(app_handle);

    info!("🔄 Rclone engine initialized");
    Ok(())
}

// ============================================================================
// Config Directory Management
// ============================================================================

/// Sets up the configuration directory for the application.
///
/// In portable mode (`--features portable`), uses a `config` directory
/// next to the executable. Otherwise, uses the system's app data directory.
#[cfg(feature = "portable")]
pub fn setup_config_dir(_app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let exe_dir = get_executable_directory()?;
    let config_dir = exe_dir.join("config");

    info!("📦 Running in PORTABLE mode");
    info!("📁 Config directory: {}", config_dir.display());

    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create portable config directory: {e}"))?;

    Ok(config_dir)
}

/// Sets up the configuration directory for the application (standard mode).
#[cfg(not(feature = "portable"))]
pub fn setup_config_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config directory: {e}"))?;

    Ok(config_dir)
}

/// Get the app's config directory from managed state.
/// This is the central place to retrieve the config directory after initialization.
pub fn get_config_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Access the config directory via rcman SettingsManager
    if let Some(manager) = app_handle.try_state::<rcman::SettingsManager<rcman::JsonStorage>>() {
        let path = manager.inner().config().settings_path();
        return Ok(path.parent().unwrap_or(&path).to_path_buf());
    }

    // Fallback/Error if manager not available
    Err("Settings manager not available".to_string())
}

/// Handles async startup tasks
pub async fn initialization(app_handle: tauri::AppHandle, settings: AppSettings) {
    debug!("🚀 Starting async startup tasks");

    setup_event_listener(&app_handle);

    // Step 1: Check connectivity FIRST to ensure backend is ready
    // This allows fallback to Local if Active is down, preventing cache refresh errors
    check_active_backend_connectivity(&app_handle).await;

    // Step 2: Refresh caches (now that we know backend is reachable)
    // Use timeout to prevent indefinite hang if backend becomes unresponsive
    info!("📊 Refreshing caches...");
    use crate::rclone::backend::BACKEND_MANAGER;

    let refresh_future = async {
        let backend = BACKEND_MANAGER.get_active().await;
        let client = app_handle
            .state::<crate::utils::types::all_types::RcloneState>()
            .client
            .clone();

        BACKEND_MANAGER
            .remote_cache
            .refresh_all(&client, &backend)
            .await
    };

    match tokio::time::timeout(std::time::Duration::from_secs(15), refresh_future).await {
        Ok(Ok(_)) => info!("✅ Caches refreshed successfully"),
        Ok(Err(e)) => error!("❌ Failed to refresh caches: {e}"),
        Err(_) => error!("❌ Cache refresh timed out (backend may be unresponsive)"),
    }

    // Step 2: Initialize and start scheduler with loaded config
    info!("⏰ Initializing cron scheduler...");
    match initialize_scheduler(app_handle.clone()).await {
        Ok(_) => {
            info!("✅ Cron scheduler initialized and started successfully");
        }
        Err(e) => {
            error!("❌ Failed to initialize cron scheduler: {}", e);
        }
    }

    // Step 3: Start watchers
    info!("📡 Starting mounted remote watcher...");
    tokio::spawn(start_mounted_remote_watcher(app_handle.clone()));

    info!("📡 Starting serve watcher...");
    start_serve_watcher(app_handle.clone());

    // Step 4: Setup tray if needed (desktop only)
    #[cfg(all(desktop, not(feature = "web-server")))]
    {
        let force_tray = std::env::args().any(|arg| arg == "--tray");
        if settings.general.tray_enabled || force_tray {
            if force_tray {
                debug!("🧊 Setting up tray (forced by --tray argument)");
            } else {
                debug!("🧊 Setting up tray (enabled in settings)");
            }
            if let Err(e) = setup_tray(app_handle.clone(), settings.core.max_tray_items).await {
                error!("Failed to setup tray: {e}");
            }
        }
    }

    #[cfg(feature = "web-server")]
    info!("ℹ️  Tray disabled (web-server mode)");

    info!("🎉 Initialization complete");
}

/// Initialize the cron scheduler with tasks loaded from remote configs
async fn initialize_scheduler(app_handle: AppHandle) -> Result<(), String> {
    let cache_state = app_handle.state::<ScheduledTasksCache>();
    let scheduler_state = app_handle.state::<CronScheduler>();
    let manager = app_handle.state::<rcman::SettingsManager<rcman::JsonStorage>>();

    use crate::rclone::backend::BACKEND_MANAGER;
    let remote_names = BACKEND_MANAGER.remote_cache.get_remotes().await;

    let all_settings = crate::core::settings::remote::manager::get_all_remote_settings_sync(
        manager.inner(),
        &remote_names,
    );

    info!("📋 Loading scheduled tasks from remote configs...");
    let task_count = cache_state
        .load_from_remote_configs(&all_settings, scheduler_state.clone())
        .await?;

    info!("📅 Loaded {} scheduled task(s)", task_count);

    scheduler_state.initialize(app_handle.clone()).await?;
    scheduler_state.start().await?;
    scheduler_state.reload_tasks(cache_state).await?;

    Ok(())
}

pub async fn apply_core_settings(app_handle: &tauri::AppHandle, settings: &AppSettings) {
    if !settings.core.bandwidth_limit.is_empty() {
        debug!(
            "🌐 Setting bandwidth limit: {}",
            settings.core.bandwidth_limit
        );
        let rclone_state = app_handle.state::<RcloneState>();

        if let Err(e) = set_bandwidth_limit(
            app_handle.clone(),
            Some(settings.core.bandwidth_limit.clone()),
            rclone_state,
        )
        .await
        {
            error!("Failed to set bandwidth limit: {e}");
        }
    }

    // Apply RClone backend settings from backend.json
    if let Err(e) = apply_backend_settings(app_handle).await {
        error!("Failed to apply backend settings: {e}");
    }
}

/// Apply RClone backend settings from rcman settings
pub async fn apply_backend_settings(app_handle: &tauri::AppHandle) -> Result<(), String> {
    use crate::core::settings::rclone_backend::load_backend_options_sync;

    debug!("🔧 Applying RClone backend settings from rcman");

    let manager = app_handle.state::<rcman::SettingsManager<rcman::JsonStorage>>();
    let backend_options = load_backend_options_sync(manager.inner());

    let rclone_state = app_handle.state::<RcloneState>();

    if let Some(backend_obj) = backend_options.as_object() {
        for (block_name, block_options) in backend_obj {
            if let Some(options_obj) = block_options.as_object() {
                for (option_name, option_value) in options_obj {
                    debug!(
                        "🔧 Setting RClone option: {}.{} = {:?}",
                        block_name, option_name, option_value
                    );

                    if let Err(e) = set_rclone_option(
                        rclone_state.clone(),
                        block_name.clone(),
                        option_name.clone(),
                        option_value.clone(),
                    )
                    .await
                    {
                        error!(
                            "Failed to set RClone option {}.{}: {}",
                            block_name, option_name, e
                        );
                    }
                }
            }
        }
    }

    info!("✅ RClone backend settings applied successfully");
    Ok(())
}

/// Check if the active backend is reachable; fallback to Local if not.
/// Also spawns background checks for other backends.
async fn check_active_backend_connectivity(app_handle: &tauri::AppHandle) {
    use crate::rclone::backend::BACKEND_MANAGER;
    let active_name = BACKEND_MANAGER.get_active_name().await;

    // Always check Local backend (sets status to connected)
    let client = app_handle
        .state::<crate::utils::types::all_types::RcloneState>()
        .client
        .clone();

    if active_name == "Local" {
        // Check Local backend too (to get version/OS)
        info!("🔍 Checking Local backend for version/OS info");
        if let Err(e) = BACKEND_MANAGER.check_connectivity("Local", &client).await {
            log::warn!("⚠️ Local backend check failed (will retry): {}", e);
            // Still mark as connected since it's managed by us
            BACKEND_MANAGER
                .set_runtime_status("Local", "connected")
                .await;
        }
    } else {
        // Check remote active backend
        info!(
            "🔍 Checking connectivity for active backend: {}",
            active_name
        );
        if let Err(e) = BACKEND_MANAGER
            .check_connectivity(&active_name, &client)
            .await
        {
            log::warn!(
                "⚠️ Active backend '{}' unreachable: {}. Falling back to Local.",
                active_name,
                e
            );
            // Set error status before switching
            BACKEND_MANAGER
                .set_runtime_status(&active_name, &format!("error:{}", e))
                .await;

            if let Err(e) = BACKEND_MANAGER.switch_to("Local").await {
                error!("❌ Failed to fallback to Local backend: {}", e);
            } else {
                info!("✅ Fallback to Local backend successful");
                BACKEND_MANAGER
                    .set_runtime_status("Local", "connected")
                    .await;
            }
        } else {
            info!("✅ Active backend '{}' is reachable", active_name);
        }
    }

    // Spawn background task to check other backends (non-blocking)
    let app_handle_clone = app_handle.clone();
    tokio::spawn(async move {
        check_other_backends(&app_handle_clone).await;
    });
}

/// Background check for non-active backends
async fn check_other_backends(app_handle: &tauri::AppHandle) {
    use crate::rclone::backend::BACKEND_MANAGER;

    let backends = BACKEND_MANAGER.list_all().await;
    let active_name = BACKEND_MANAGER.get_active_name().await;

    let client = app_handle
        .state::<crate::utils::types::all_types::RcloneState>()
        .client
        .clone();

    for backend in backends {
        if backend.name == active_name || backend.name == "Local" {
            continue; // Already checked
        }

        info!("🔍 Background check for backend: {}", backend.name);
        if let Err(e) = BACKEND_MANAGER
            .check_connectivity(&backend.name, &client)
            .await
        {
            log::warn!("⚠️ Backend '{}' unreachable: {}", backend.name, e);
            BACKEND_MANAGER
                .set_runtime_status(&backend.name, &format!("error:{}", e))
                .await;
        } else {
            info!("✅ Backend '{}' is reachable", backend.name);
        }
    }
}
