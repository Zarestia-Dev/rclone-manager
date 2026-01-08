use log::{debug, error, info, warn};
use crate::core::settings::AppSettingsManager;
use tauri::{AppHandle, Manager};

use crate::{
    core::{
        event_listener::setup_event_listener, scheduler::engine::CronScheduler,
        settings::schema::AppSettings,
    },
    rclone::{
        commands::system::set_bandwidth_limit,
        queries::flags::set_rclone_option,
        state::{
            scheduled_tasks::ScheduledTasksCache,
            watcher::{start_mounted_remote_watcher, start_serve_watcher},
        },
    },
    utils::types::core::RcloneState,
};

// ============================================================================
// Constants
// ============================================================================

/// Timeout for backend connectivity checks (10 seconds)
/// After this timeout, the app will fallback to Local backend
const BACKEND_CONNECTIVITY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

// ============================================================================
// Rclone State Initialization
// ============================================================================

/// Initializes Rclone API and OAuth state, and launches the Rclone engine.
pub fn init_rclone_state(app_handle: &tauri::AppHandle) -> Result<(), String> {
    // Load any persistent connections
    use crate::rclone::backend::BACKEND_MANAGER;
    use crate::utils::types::core::EngineState;

    tauri::async_runtime::block_on(async {
        // Load persistent connections
        let settings_state = app_handle.state::<AppSettingsManager>();
        if let Err(e) = BACKEND_MANAGER
            .load_from_settings(settings_state.inner())
            .await
        {
            error!("Failed to load persistent connections: {e}");
        }

        // Initialize engine
        let engine_state = app_handle.state::<EngineState>();
        let mut engine = engine_state.lock().await;
        engine.init(app_handle).await;
    });

    info!("🔄 Rclone engine initialized");
    Ok(())
}

/// Handles async startup tasks
pub async fn initialization(app_handle: tauri::AppHandle) {
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
        let client = app_handle.state::<RcloneState>().client.clone();

        BACKEND_MANAGER
            .remote_cache
            .refresh_all(&client, &backend)
            .await
    };

    match tokio::time::timeout(std::time::Duration::from_secs(15), refresh_future).await {
        Ok(Ok(_)) => info!("✅ Caches refreshed successfully"),
        Ok(Err(e)) => {
            error!("❌ Failed to refresh caches: {e}");
            // Fallback to Local if active is remote and failing
            let active = BACKEND_MANAGER.get_active_name().await;
            if active != "Local" {
                warn!(
                    "↩️ Startup: Active backend '{}' has weak connection. Falling back to Local.",
                    active
                );
                let manager = app_handle.state::<AppSettingsManager>();
                if let Err(err) = BACKEND_MANAGER.switch_to(manager.inner(), "Local").await {
                    error!("Critical: Failed to fallback to Local backend: {}", err);
                } else {
                    info!("✅ Fallback to Local successful. Retrying cache refresh for Local...");
                    // Retry refresh for Local to ensure app starts with some data
                    let client = app_handle.state::<RcloneState>().client.clone();
                    let local_backend = BACKEND_MANAGER.get("Local").await.unwrap();
                    let _ = BACKEND_MANAGER
                        .remote_cache
                        .refresh_all(&client, &local_backend)
                        .await;
                }
            }
        }
        Err(_) => {
            error!("❌ Cache refresh timed out (backend may be unresponsive)");
            // Fallback to Local on timeout
            let active = BACKEND_MANAGER.get_active_name().await;
            if active != "Local" {
                warn!(
                    "↩️ Startup: Active backend '{}' timed out. Falling back to Local.",
                    active
                );
                let manager = app_handle.state::<AppSettingsManager>();
                if let Err(err) = BACKEND_MANAGER.switch_to(manager.inner(), "Local").await {
                    error!("Critical: Failed to fallback to Local backend: {}", err);
                } else {
                    info!("✅ Fallback to Local successful. Retrying cache refresh for Local...");
                    let client = app_handle.state::<RcloneState>().client.clone();
                    if let Some(local_backend) = BACKEND_MANAGER.get("Local").await {
                        let _ = BACKEND_MANAGER
                            .remote_cache
                            .refresh_all(&client, &local_backend)
                            .await;
                    }
                }
            }
        }
    }

    // Step 3: Initialize and start scheduler with loaded config
    info!("⏰ Initializing cron scheduler...");
    match initialize_scheduler(app_handle.clone()).await {
        Ok(_) => {
            info!("✅ Cron scheduler initialized and started successfully");
        }
        Err(e) => {
            error!("❌ Failed to initialize cron scheduler: {}", e);
        }
    }

    // Step 4: Start watchers
    info!("📡 Starting mounted remote watcher...");
    tokio::spawn(start_mounted_remote_watcher(app_handle.clone()));

    info!("📡 Starting serve watcher...");
    start_serve_watcher(app_handle.clone());

    info!("🎉 Initialization complete");
}

/// Initialize the cron scheduler with tasks loaded from remote configs
async fn initialize_scheduler(app_handle: AppHandle) -> Result<(), String> {
    let cache_state = app_handle.state::<ScheduledTasksCache>();
    let scheduler_state = app_handle.state::<CronScheduler>();
    let manager = app_handle.state::<AppSettingsManager>();

    use crate::rclone::backend::BACKEND_MANAGER;
    let remote_names = BACKEND_MANAGER.remote_cache.get_remotes().await;

    let all_settings = crate::core::settings::remote::manager::get_all_remote_settings_sync(
        manager.inner(),
        &remote_names,
    );

    info!("📋 Loading scheduled tasks from remote configs...");
    let task_count = cache_state
        .load_from_remote_configs(&all_settings, scheduler_state.clone(), Some(&app_handle))
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

    let manager = app_handle.state::<AppSettingsManager>();
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
    // Always check Local backend (sets status to connected)
    let client = app_handle.state::<RcloneState>().client.clone();

    // Check connectivity with automatic fallback
    // This single call handles:
    // 1. Checking Active (Remote or Local)
    // 2. Retrying (if Local)
    // 3. Fallback to Local (if Remote fails)
    // 4. Logging success/failure
    if let Err(e) = BACKEND_MANAGER
        .ensure_connectivity_or_fallback(&client, BACKEND_CONNECTIVITY_TIMEOUT)
        .await
    {
        // This only happens if fallback also failed (critical error)
        error!("🔥 Critical startup failure: {}", e);
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

    let client = app_handle.state::<RcloneState>().client.clone();

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
