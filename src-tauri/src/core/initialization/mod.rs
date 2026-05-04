/// Initialization submodules
pub mod apply_settings;
pub mod bootstrap;
pub mod cache;
pub mod connectivity;
pub mod scheduler;
pub mod watchers;

use crate::core::cli::CliArgs;
use crate::core::lifecycle::startup::handle_startup;
use crate::core::settings::AppSettingsManager;
use crate::utils::types::events::SYSTEM_SETTINGS_CHANGED;
use log::{debug, error, info};
use tauri::{AppHandle, Emitter, Manager};

/// Handles async startup tasks using a phased approach
pub async fn initialization(app_handle: tauri::AppHandle) {
    debug!("🚀 Starting async startup tasks");

    // Phase 1: Bootstrap (State, Events, Environment, Engine, Alerts, Network)
    if let Err(e) = bootstrap::init_all(&app_handle).await {
        error!("🔥 Phase 1 Bootstrap failed: {e}");
        return;
    }

    // Phase 2: Connectivity (Health check & Fallback)
    info!("🔍 Phase 2: Checking backend connectivity...");
    connectivity::check_active_backend_connectivity(&app_handle).await;

    // Phase 3: Data (Cache hydration & Defaults)
    if let Err(e) = cache::initialize_caches(&app_handle).await {
        error!("⚠️ Phase 3 Data hydration failed: {e}");
    }

    // Phase 4: Services (Long-running logic)
    info!("⏰ Phase 4: Starting services...");

    // Scheduler
    if let Err(e) = scheduler::initialize_scheduler(app_handle.clone()).await {
        error!("❌ Failed to initialize cron scheduler: {e}");
    }

    // Watchers
    watchers::start_all_watchers(&app_handle);

    // Auto Updater
    #[cfg(desktop)]
    crate::core::lifecycle::auto_updater::init_auto_updater(app_handle.clone());

    // Phase 5: Runtime Application
    info!("🎉 Phase 5: Applying runtime settings");
    let settings_manager = app_handle.state::<AppSettingsManager>();
    let cli_args = app_handle.state::<CliArgs>();

    if let Ok(settings) = settings_manager.get_all() {
        apply_settings::apply_core_settings(&app_handle, &settings).await;

        // Tray Setup (Moved from lib.rs)
        #[cfg(feature = "tray")]
        {
            let force_tray = cli_args.general.tray;
            if (settings.general.tray_enabled || force_tray)
                && let Err(e) = crate::utils::app::builder::setup_tray(app_handle.clone()).await
            {
                error!("Failed to setup tray: {e}");
            }
        }
    }

    // Phase 6: Post-Initialization Tasks
    info!("🚀 Phase 6: Running post-initialization tasks");
    handle_startup(app_handle.clone()).await;

    info!("🎉 Initialization complete");

    // Enable engine health monitoring now that startup is complete
    crate::rclone::engine::lifecycle::mark_startup_complete();
}

/// Fully refreshes all system components after settings change or restore.
#[tauri::command]
pub async fn refresh_system(app_handle: AppHandle) -> Result<(), String> {
    info!("🔄 Initiating full system refresh...");

    let manager = app_handle.state::<AppSettingsManager>();

    // 1. Invalidate manager cache so it reads fresh from disk (essential after restore)
    manager.invalidate_cache();
    let settings = manager.get_all().map_err(|e| e.to_string())?;

    // 2. Re-bootstrap (Reload Backends & Security Environment)
    // We don't call bootstrap::init_all because we don't want to re-setup event listeners
    let backend_manager = app_handle.state::<crate::rclone::backend::BackendManager>();
    backend_manager
        .load_from_settings(manager.inner())
        .await
        .map_err(|e| format!("Failed to reload backends: {e}"))?;

    use crate::core::security::SafeEnvironmentManager;
    if let Some(env_manager) = app_handle.try_state::<SafeEnvironmentManager>() {
        let _ = env_manager.init_with_stored_credentials(manager.inner());
    }

    // 3. Refresh Caches (Remote Caches & Alerts)
    cache::initialize_caches(&app_handle).await?;

    // 4. Reload Scheduler (from remote configs)
    let remote_names = backend_manager.remote_cache.get_remotes().await;
    let all_configs = crate::core::settings::remote::manager::get_all_remote_settings_sync(
        manager.inner(),
        &remote_names,
    );
    if let Err(e) = crate::core::scheduler::commands::reload_scheduled_tasks_from_configs(
        app_handle.clone(),
        all_configs,
    )
    .await
    {
        error!("⚠️ Failed to reload scheduled tasks: {e}");
    }

    // 5. Apply Core Settings (bandwidth limits, backend options, language, log level)
    apply_settings::apply_core_settings(&app_handle, &settings).await;

    // 6. Tray update
    #[cfg(feature = "tray")]
    {
        use crate::core::tray::core::update_tray_menu;
        let _ = update_tray_menu(app_handle.clone()).await;
    }

    // 7. Inform frontend to reload all settings
    app_handle
        .emit(
            SYSTEM_SETTINGS_CHANGED,
            crate::utils::types::events::SettingsChangeEvent {
                category: "*".to_string(),
                key: "*".to_string(),
                value: serde_json::Value::Null,
            },
        )
        .ok();

    info!("✅ System successfully refreshed");
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_module_structure() {
        // Verify modules are accessible
        // This is a compile-time check
    }

    // TODO: Add integration tests for full initialization flow
    // - Test initialization with Local backend
    // - Test initialization with Remote backend
    // - Test initialization with engine errors
    // - Test scheduler initialization
    // - Test watcher startup
}
