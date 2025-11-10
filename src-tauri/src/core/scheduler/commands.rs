use crate::core::scheduler::engine::{CronScheduler, get_next_run, validate_cron_expression};
use crate::rclone::state::scheduled_tasks::SCHEDULED_TASKS_CACHE;
use crate::utils::types::scheduled_task::{CronValidationResponse, ScheduledTask, TaskStatus};
use log::{error, info, warn};
use once_cell::sync::Lazy;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Global scheduler instance
pub static SCHEDULER: Lazy<Arc<RwLock<CronScheduler>>> =
    Lazy::new(|| Arc::new(RwLock::new(CronScheduler::new())));

/// Toggle task enabled/disabled
#[tauri::command]
pub async fn toggle_scheduled_task(task_id: String) -> Result<ScheduledTask, String> {
    info!("🔄 Toggling scheduled task: {}", task_id);

    let task = SCHEDULED_TASKS_CACHE.toggle_task_status(&task_id).await?;

    let scheduler = SCHEDULER.read().await;
    if let Err(e) = scheduler.reschedule_task(&task).await {
        error!("⚠️  Failed to reload tasks after toggle: {}", e);
    } else {
        info!(
            "✅ Task {} {}",
            if task.status == TaskStatus::Enabled {
                "enabled and scheduled"
            } else {
                "disabled and unscheduled"
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
        Ok(_) => {
            let next_run = get_next_run(&cron_expression).ok();
            let human_readable = Some(cron_expression.to_string());

            Ok(CronValidationResponse {
                is_valid: true,
                error_message: None,
                next_run,
                human_readable,
            })
        }
        Err(e) => Ok(CronValidationResponse {
            is_valid: false,
            error_message: Some(e),
            next_run: None,
            human_readable: None,
        }),
    }
}

/// Reload all scheduled tasks (useful after app restart or manual intervention)
#[tauri::command]
pub async fn reload_scheduled_tasks() -> Result<(), String> {
    info!("🔄 Reloading all scheduled tasks");

    let scheduler = SCHEDULER.read().await;
    scheduler.reload_tasks().await?;

    info!("✅ Scheduled tasks reloaded");
    Ok(())
}

/// Clear all scheduled tasks (dangerous!)
#[tauri::command]
pub async fn clear_all_scheduled_tasks() -> Result<(), String> {
    info!("⚠️  Clearing all scheduled tasks");

    let tasks = SCHEDULED_TASKS_CACHE.get_all_tasks().await;
    let scheduler = SCHEDULER.read().await;

    for task in tasks {
        if let Some(job_id_str) = task.scheduler_job_id {
            if let Ok(job_id) = uuid::Uuid::parse_str(&job_id_str) {
                if let Err(e) = scheduler.unschedule_task(job_id).await {
                    warn!("Failed to unschedule job {}: {}", job_id, e);
                }
            }
        }
    }

    SCHEDULED_TASKS_CACHE.clear_all_tasks().await?;

    info!("✅ All scheduled tasks cleared");
    Ok(())
}
