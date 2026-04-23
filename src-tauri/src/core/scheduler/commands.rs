use crate::core::scheduler::engine::{CronScheduler, get_next_run, validate_cron_expression};
use crate::rclone::state::scheduled_tasks::ScheduledTasksCache;
use crate::utils::types::scheduled_task::{CronValidationResponse, ScheduledTask, TaskStatus};
use log::{error, info, warn};
use tauri::{AppHandle, Manager};

/// Toggle task scheduling state.
#[tauri::command]
pub async fn toggle_scheduled_task(
    app: AppHandle,
    task_id: String,
) -> Result<ScheduledTask, String> {
    info!("🔄 Toggling scheduled task: {task_id}");

    let cache = app.state::<ScheduledTasksCache>();
    let scheduler = app.state::<CronScheduler>();

    let task = cache.toggle_task_status(&task_id, Some(&app)).await?;

    if let Err(e) = scheduler.reschedule_task(&task, cache.clone()).await {
        error!("⚠️  Failed to reload tasks after toggle: {e}");
    } else {
        info!(
            "✅ Task {} {}",
            match task.status {
                TaskStatus::Enabled => "enabled and scheduled",
                TaskStatus::Stopping => "disabling after current run",
                _ => "disabled and unscheduled",
            },
            task.name
        );
    }

    Ok(task)
}

/// Validate a cron expression
#[tauri::command]
pub async fn validate_cron(cron_expression: String) -> Result<CronValidationResponse, String> {
    match validate_cron_expression(&cron_expression) {
        Ok(()) => {
            let next_run = get_next_run(&cron_expression).ok();

            Ok(CronValidationResponse {
                is_valid: true,
                error_message: None,
                next_run,
            })
        }
        Err(e) => Ok(CronValidationResponse {
            is_valid: false,
            error_message: Some(e),
            next_run: None,
        }),
    }
}

/// Reload all scheduled tasks
#[tauri::command]
pub async fn reload_scheduled_tasks(app: AppHandle) -> Result<(), String> {
    info!("🔄 Reloading all scheduled tasks");
    let scheduler = app.state::<CronScheduler>();

    scheduler.reload_tasks(app.clone()).await?;

    info!("✅ Scheduled tasks reloaded");
    Ok(())
}

/// Clear all scheduled tasks
#[tauri::command]
pub async fn clear_all_scheduled_tasks(app: AppHandle) -> Result<(), String> {
    info!("⚠️  Clearing all scheduled tasks");

    let cache = app.state::<ScheduledTasksCache>();
    let scheduler = app.state::<CronScheduler>();

    let tasks = cache.get_all_tasks().await;

    for task in tasks {
        if let Some(job_id_str) = task.scheduler_job_id
            && let Ok(job_id) = uuid::Uuid::parse_str(&job_id_str)
            && let Err(e) = scheduler.unschedule_task(job_id).await
        {
            warn!("Failed to unschedule job {job_id}: {e}");
        }
    }

    cache.clear_all_tasks(Some(&app)).await?;

    info!("✅ All scheduled tasks cleared");
    Ok(())
}

/// Reload scheduled tasks from remote configs
#[tauri::command]
pub async fn reload_scheduled_tasks_from_configs(
    app: AppHandle,
    all_settings: serde_json::Value,
) -> Result<usize, String> {
    info!("🔄 Reloading scheduled tasks from configs...");

    let cache = app.state::<ScheduledTasksCache>();
    let scheduler = app.state::<CronScheduler>();
    let backend_manager = app.state::<crate::rclone::backend::BackendManager>();
    let backend_name = backend_manager.get_active_name().await;

    let result = cache
        .load_from_remote_configs(&all_settings, &backend_name, Some(&app))
        .await?;

    let counts = (
        result.added.len(),
        result.updated.len(),
        result.removed.len(),
    );

    scheduler.apply_cache_result(&result, cache).await?;

    info!(
        "📅 Reload complete: {} added, {} updated, {} removed",
        counts.0, counts.1, counts.2,
    );

    Ok(counts.0)
}
