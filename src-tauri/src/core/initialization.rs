use crate::core::settings::AppSettingsManager;
use log::{debug, error, info};
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
pub async fn init_rclone_state(app_handle: &tauri::AppHandle) -> Result<(), String> {
    // Load any persistent connections
    use crate::rclone::backend::BackendManager;
    use crate::utils::types::core::EngineState;

    // Load persistent connections
    let backend_manager = app_handle.state::<BackendManager>();
    let settings_state = app_handle.state::<AppSettingsManager>();
    if let Err(e) = backend_manager
        .load_from_settings(settings_state.inner())
        .await
    {
        error!("Failed to load persistent connections: {e}");
    }

    // Initialize engine
    let engine_state = app_handle.state::<EngineState>();
    let mut engine = engine_state.lock().await;
    engine.init(app_handle).await;

    info!("🔄 Rclone engine initialized");
    Ok(())
}

/// Handles async startup tasks
pub async fn initialization(app_handle: tauri::AppHandle) {
    debug!("🚀 Starting async startup tasks");

    init_rclone_state(&app_handle)
        .await
        .map_err(|e| format!("Rclone initialization failed: {e}"))
        .unwrap();

    setup_event_listener(&app_handle);

    // Step 1: Check connectivity FIRST to ensure backend is ready
    // This allows fallback to Local if Active is down, preventing cache refresh errors
    // Use the injected BackendManager to handle connectivity checks and fallbacks
    check_active_backend_connectivity(&app_handle).await;

    // Step 2: Refresh caches (now that we know backend is reachable)
    info!("📊 Refreshing caches...");
    use crate::rclone::backend::BackendManager;
    let backend_manager = app_handle.state::<BackendManager>();

    let client = app_handle.state::<RcloneState>().client.clone();

    // We can directly call refresh_active_backend now, as ensure_connectivity_or_fallback
    // guarantees a reachable backend (active or fallback Local)
    match backend_manager.refresh_active_backend(&client).await {
        Ok(_) => info!("✅ Caches refreshed successfully"),
        Err(e) => error!("❌ Failed to refresh caches: {e}"),
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

    // Enable engine health monitoring now that startup is complete
    crate::rclone::engine::lifecycle::mark_startup_complete();
}

/// Initialize the cron scheduler with tasks loaded from remote configs
async fn initialize_scheduler(app_handle: AppHandle) -> Result<(), String> {
    let cache_state = app_handle.state::<ScheduledTasksCache>();
    let scheduler_state = app_handle.state::<CronScheduler>();
    let manager = app_handle.state::<AppSettingsManager>();

    use crate::rclone::backend::BackendManager;
    let backend_manager = app_handle.state::<BackendManager>();
    let remote_names = backend_manager.remote_cache.get_remotes().await;

    let all_settings = crate::core::settings::remote::manager::get_all_remote_settings_sync(
        manager.inner(),
        &remote_names,
    );

    info!("📋 Loading scheduled tasks from remote configs...");

    // Get the active backend name
    let backend_name = backend_manager.get_active_name().await;

    let task_count = cache_state
        .load_from_remote_configs(
            &all_settings,
            &backend_name,
            scheduler_state.clone(),
            Some(&app_handle),
        )
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

        if let Err(e) = set_bandwidth_limit(
            app_handle.clone(),
            Some(settings.core.bandwidth_limit.clone()),
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

    if let Some(backend_obj) = backend_options.as_object() {
        for (block_name, block_options) in backend_obj {
            if let Some(options_obj) = block_options.as_object() {
                for (option_name, option_value) in options_obj {
                    debug!(
                        "🔧 Setting RClone option: {}.{} = {:?}",
                        block_name, option_name, option_value
                    );

                    if let Err(e) = set_rclone_option(
                        app_handle.clone(),
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
    use crate::rclone::backend::BackendManager;
    let backend_manager = app_handle.state::<BackendManager>();

    // Always check Local backend (sets status to connected)
    let client = app_handle.state::<RcloneState>().client.clone();

    // Check connectivity with automatic fallback
    // This single call handles:
    // 1. Checking Active (Remote or Local)
    // 2. Retrying (if Local)
    // 3. Fallback to Local (if Remote fails)
    // 4. Logging success/failure
    if let Err(e) = backend_manager
        .ensure_connectivity_or_fallback(&client, BACKEND_CONNECTIVITY_TIMEOUT)
        .await
    {
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
    use crate::rclone::backend::BackendManager;
    let backend_manager = app_handle.state::<BackendManager>();

    let client = app_handle.state::<RcloneState>().client.clone();

    backend_manager.check_other_backends(&client).await;
}
