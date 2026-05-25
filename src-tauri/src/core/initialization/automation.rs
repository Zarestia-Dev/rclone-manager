use crate::core::automation::engine::AutomationScheduler;
use crate::core::settings::AppSettingsManager;
use crate::rclone::backend::BackendManager;
use crate::rclone::state::automations::AutomationsCache;
use log::info;
use tauri::{AppHandle, Manager};

/// Initialize the cron scheduler with tasks loaded from remote configs.
pub async fn initialize_automations(app_handle: AppHandle) -> Result<(), String> {
    let cache_state = app_handle.state::<AutomationsCache>();
    let scheduler_state = app_handle.state::<AutomationScheduler>();
    let manager = app_handle.state::<AppSettingsManager>();

    let backend_manager = app_handle.state::<BackendManager>();
    let remote_names = backend_manager.remote_cache.get_remotes().await;

    let all_settings = crate::core::settings::remote::manager::get_all_remote_settings_sync(
        manager.inner(),
        &remote_names,
    );

    info!("📋 Loading automations from remote configs...");

    let backend_name = backend_manager.get_active_name().await;

    let result = cache_state
        .load_from_remote_configs(&all_settings, &backend_name, Some(&app_handle))
        .await?;

    for automation in &result.removed {
        if let Some(job_id_str) = &automation.scheduler_job_id
            && let Ok(job_id) = uuid::Uuid::parse_str(job_id_str)
        {
            let _ = scheduler_state.unschedule_automation(job_id).await;
        }
    }

    info!("📅 Loaded {} automation(s)", result.added.len());

    scheduler_state.initialize(app_handle.clone()).await?;
    scheduler_state.start().await?;
    scheduler_state
        .reload_automations(app_handle.clone())
        .await?;

    let watcher_manager = app_handle.state::<crate::core::automation::watcher::WatcherManager>();
    if let Err(e) = watcher_manager.sync_watchers(app_handle.clone()).await {
        log::error!("Failed to initialize watchers: {e}");
    }

    Ok(())
}
