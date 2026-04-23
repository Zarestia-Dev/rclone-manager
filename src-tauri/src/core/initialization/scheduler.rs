use crate::core::scheduler::engine::CronScheduler;
use crate::core::settings::AppSettingsManager;
use crate::rclone::backend::BackendManager;
use crate::rclone::state::scheduled_tasks::ScheduledTasksCache;
use log::info;
use tauri::{AppHandle, Manager};

/// Initialize the cron scheduler with tasks loaded from remote configs.
pub async fn initialize_scheduler(app_handle: AppHandle) -> Result<(), String> {
    let cache_state = app_handle.state::<ScheduledTasksCache>();
    let scheduler_state = app_handle.state::<CronScheduler>();
    let manager = app_handle.state::<AppSettingsManager>();

    let backend_manager = app_handle.state::<BackendManager>();
    let remote_names = backend_manager.remote_cache.get_remotes().await;

    let all_settings = crate::core::settings::remote::manager::get_all_remote_settings_sync(
        manager.inner(),
        &remote_names,
    );

    info!("📋 Loading scheduled tasks from remote configs...");

    let backend_name = backend_manager.get_active_name().await;

    let result = cache_state
        .load_from_remote_configs(&all_settings, &backend_name, Some(&app_handle))
        .await?;

    for task in &result.removed {
        if let Some(job_id_str) = &task.scheduler_job_id
            && let Ok(job_id) = uuid::Uuid::parse_str(job_id_str)
        {
            let _ = scheduler_state.unschedule_task(job_id).await;
        }
    }

    info!("📅 Loaded {} scheduled task(s)", result.added.len());

    scheduler_state.initialize(app_handle.clone()).await?;
    scheduler_state.start().await?;
    scheduler_state.reload_tasks(app_handle.clone()).await?;

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
