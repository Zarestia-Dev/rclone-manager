use crate::core::scheduler::engine::{
    CronScheduler, get_cron_description, get_next_run, validate_cron_expression,
};
use crate::rclone::state::scheduled_tasks::SCHEDULED_TASKS_CACHE;
use crate::utils::types::scheduled_task::{
    CreateScheduledTaskRequest, CronValidationResponse, ScheduledTask, UpdateScheduledTaskRequest,
};
use log::{error, info};
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

    // Validate cron expression
    validate_cron_expression(&request.cron_expression)?;

    // Calculate next run
    let next_run = get_next_run(&request.cron_expression).ok();

    // Create task
    let mut task = ScheduledTask::new(
        request.name,
        request.task_type,
        request.cron_expression,
        request.args,
    );
    task.next_run = next_run;

    // Add to cache
    let task = SCHEDULED_TASKS_CACHE.add_task(task).await?;

    // Schedule it
    let scheduler = SCHEDULER.read().await;
    match scheduler.schedule_task(&task).await {
        Ok(job_id) => {
            info!("✅ Task scheduled successfully with ID: {}", job_id);
        }
        Err(e) => {
            error!("⚠️  Failed to schedule task: {}", e);
            // Task is still saved, just not scheduled yet
        }
    }

    Ok(task)
}

/// Remove a scheduled task
#[tauri::command]
pub async fn remove_scheduled_task(task_id: String) -> Result<(), String> {
    info!("🗑️  Removing scheduled task: {}", task_id);

    // Remove from cache (this will also save to store)
    SCHEDULED_TASKS_CACHE.remove_task(&task_id).await?;

    info!("✅ Task removed successfully");

    // Note: We don't have direct access to job_id from task_id
    // The scheduler will handle cleanup on next reload

    Ok(())
}

/// Update a scheduled task
#[tauri::command]
pub async fn update_scheduled_task(
    task_id: String,
    request: UpdateScheduledTaskRequest,
) -> Result<ScheduledTask, String> {
    info!("🔄 Updating scheduled task: {}", task_id);

    // Validate cron if provided
    if let Some(ref cron_expr) = request.cron_expression {
        validate_cron_expression(cron_expr)?;
    }

    // Update task
    let task = SCHEDULED_TASKS_CACHE
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

    // Reschedule if enabled
    if task.status == crate::utils::types::scheduled_task::TaskStatus::Enabled {
        let scheduler = SCHEDULER.read().await;
        match scheduler.schedule_task(&task).await {
            Ok(_) => {
                info!("✅ Task rescheduled successfully");
            }
            Err(e) => {
                error!("⚠️  Failed to reschedule task: {}", e);
            }
        }
    }

    Ok(task)
}

/// Toggle task enabled/disabled
#[tauri::command]
pub async fn toggle_scheduled_task(task_id: String) -> Result<ScheduledTask, String> {
    info!("🔄 Toggling scheduled task: {}", task_id);

    let task = SCHEDULED_TASKS_CACHE.toggle_task_status(&task_id).await?;

    // Reschedule if now enabled
    if task.status == crate::utils::types::scheduled_task::TaskStatus::Enabled {
        let scheduler = SCHEDULER.read().await;
        match scheduler.schedule_task(&task).await {
            Ok(_) => {
                info!("✅ Task enabled and scheduled");
            }
            Err(e) => {
                error!("⚠️  Failed to schedule task: {}", e);
            }
        }
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

    SCHEDULED_TASKS_CACHE.clear_all_tasks().await?;

    info!("✅ All scheduled tasks cleared");

    Ok(())
}
