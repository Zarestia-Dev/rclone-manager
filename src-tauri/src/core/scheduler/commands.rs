use crate::core::scheduler::engine::{
    CronScheduler, get_cron_description, get_next_run, validate_cron_expression,
};
use crate::rclone::state::scheduled_tasks::SCHEDULED_TASKS_CACHE;
use crate::utils::types::scheduled_task::{
    CreateScheduledTaskRequest, CronValidationResponse, ScheduledTask, TaskStatus,
    UpdateScheduledTaskRequest,
};
use log::{error, info, warn};
use once_cell::sync::Lazy;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Global scheduler instance
pub static SCHEDULER: Lazy<Arc<RwLock<CronScheduler>>> =
    Lazy::new(|| Arc::new(RwLock::new(CronScheduler::new())));

/// Add a new scheduled task
#[tauri::command]
pub async fn add_scheduled_task(
    request: CreateScheduledTaskRequest,
) -> Result<ScheduledTask, String> {
    info!("📝 Adding new scheduled task: {}", request.name);

    validate_cron_expression(&request.cron_expression)?;
    let next_run = get_next_run(&request.cron_expression).ok();

    let mut task = ScheduledTask::new(
        request.name,
        request.task_type,
        request.cron_expression,
        request.args,
    );
    task.next_run = next_run;

    let task = SCHEDULED_TASKS_CACHE.add_task(task).await?;

    let scheduler = SCHEDULER.read().await;
    match scheduler.schedule_task(&task).await {
        Ok(job_id) => {
            info!("✅ Task scheduled successfully with ID: {}", job_id);
        }
        Err(e) => {
            error!("⚠️  Failed to schedule task: {}", e);
        }
    }

    Ok(task)
}

/// Remove a scheduled task
#[tauri::command]
pub async fn remove_scheduled_task(task_id: String) -> Result<(), String> {
    info!("🗑️  Removing scheduled task: {}", task_id);

    let task = SCHEDULED_TASKS_CACHE.get_task(&task_id).await;

    if let Some(task) = task {
        if let Some(job_id_str) = task.scheduler_job_id {
            if let Ok(job_id) = uuid::Uuid::parse_str(&job_id_str) {
                let scheduler = SCHEDULER.read().await;
                if let Err(e) = scheduler.unschedule_task(job_id).await {
                    warn!("Failed to unschedule job {}: {}", job_id, e);
                } else {
                    info!("Unscheduled job {} for task {}", job_id, task_id);
                }
            }
        }
    } else {
        return Err("Task not found in cache".to_string());
    }

    SCHEDULED_TASKS_CACHE.remove_task(&task_id).await?;

    info!("✅ Task removed successfully");
    Ok(())
}

/// Update a scheduled task
#[tauri::command]
pub async fn update_scheduled_task(
    task_id: String,
    request: UpdateScheduledTaskRequest,
) -> Result<ScheduledTask, String> {
    info!("🔄 Updating scheduled task: {}", task_id);

    if let Some(ref cron_expr) = request.cron_expression {
        validate_cron_expression(cron_expr)?;
    }

    let updated_task = SCHEDULED_TASKS_CACHE
        .update_task(&task_id, |task| {
            if let Some(name) = &request.name {
                task.name = name.clone();
            }
            if let Some(cron_expr) = &request.cron_expression {
                task.cron_expression = cron_expr.clone();
                task.next_run = get_next_run(cron_expr).ok();
            }
            if let Some(status) = &request.status {
                task.status = status.clone();
            }
            if let Some(args) = &request.args {
                task.args = args.clone();
            }
        })
        .await?;

    let scheduler = SCHEDULER.read().await;
    if let Err(e) = scheduler.reschedule_task(&updated_task).await {
        error!("⚠️  Failed to reschedule task: {}", e);
    } else {
        info!("✅ Task rescheduled successfully");
    }

    Ok(updated_task)
}

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
            let human_readable = get_cron_description(&cron_expression).ok();

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
