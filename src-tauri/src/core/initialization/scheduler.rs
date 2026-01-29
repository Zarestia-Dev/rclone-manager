use crate::core::scheduler::engine::CronScheduler;
use crate::core::settings::AppSettingsManager;
use crate::rclone::state::scheduled_tasks::ScheduledTasksCache;
use log::info;
use tauri::{AppHandle, Manager};

/// Initialize the cron scheduler with tasks loaded from remote configs
pub async fn initialize_scheduler(app_handle: AppHandle) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    // TODO: Add scheduler initialization tests
    // - Test task loading from configs
    // - Test scheduler start/stop
    // - Test empty config handling
    // - Test error handling for invalid tasks
}
