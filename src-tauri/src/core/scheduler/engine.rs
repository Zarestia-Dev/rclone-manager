use crate::rclone::commands::sync::{BisyncParams, CopyParams, MoveParams, SyncParams};
use crate::rclone::state::scheduled_tasks::SCHEDULED_TASKS_CACHE;
use crate::utils::types::events::{SCHEDULED_TASK_COMPLETED, SCHEDULED_TASK_ERROR};
use crate::utils::types::scheduled_task::{ScheduledTask, TaskStatus, TaskType};
use chrono::{Local, Utc};
use log::{debug, error, info, warn};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;
use tokio_cron_scheduler::{JobBuilder, JobScheduler};
use uuid::Uuid;

/// Global scheduler instance
pub struct CronScheduler {
    scheduler: Arc<RwLock<Option<JobScheduler>>>,
    app_handle: Arc<RwLock<Option<AppHandle>>>,
}

impl CronScheduler {
    pub fn new() -> Self {
        Self {
            scheduler: Arc::new(RwLock::new(None)),
            app_handle: Arc::new(RwLock::new(None)),
        }
    }

    /// Initialize the scheduler with the app handle in Local.
    pub async fn initialize(&self, app_handle: AppHandle) -> Result<(), String> {
        info!("🕐 Initializing cron scheduler in Local...");

        let scheduler = JobScheduler::new()
            .await
            .map_err(|e| format!("Failed to create job scheduler: {}", e))?;

        *self.scheduler.write().await = Some(scheduler);
        *self.app_handle.write().await = Some(app_handle);

        info!("✅ Cron scheduler initialized");
        Ok(())
    }

    /// Start the scheduler
    pub async fn start(&mut self) -> Result<(), String> {
        let mut scheduler_guard = self.scheduler.write().await;
        let scheduler = scheduler_guard
            .as_mut()
            .ok_or("Scheduler not initialized")?;

        scheduler
            .start()
            .await
            .map_err(|e| format!("Failed to start scheduler: {}", e))?;

        info!("▶️  Cron scheduler started");
        Ok(())
    }

    /// Stop the scheduler
    pub async fn stop(&mut self) -> Result<(), String> {
        let mut scheduler_guard = self.scheduler.write().await;
        let scheduler = scheduler_guard
            .as_mut()
            .ok_or("Scheduler not initialized")?;

        scheduler
            .shutdown()
            .await
            .map_err(|e| format!("Failed to stop scheduler: {}", e))?;

        info!("⏸️  Cron scheduler stopped");
        Ok(())
    }

    /// Schedule a task
    pub async fn schedule_task(&self, task: &ScheduledTask) -> Result<Uuid, String> {
        if task.status != TaskStatus::Enabled {
            return Err("Task is not enabled".to_string());
        }

        let scheduler_guard = self.scheduler.read().await;
        let scheduler = scheduler_guard
            .as_ref()
            .ok_or("Scheduler not initialized")?;

        let app_guard = self.app_handle.read().await;
        let app_handle = app_guard
            .as_ref()
            .ok_or("App handle not initialized")?
            .clone();

        let task_id = task.id.clone();
        let task_name = task.name.clone();
        let task_type = task.task_type.clone();
        let cron_expr_5_field = task.cron_expression.clone();
        // tokio-cron-scheduler requires 6 fields, but users provide 5.
        // Prepend "0 " to represent "at second 0".
        let cron_expr_6_field = format!("0 {}", cron_expr_5_field);

        // 2. Create the job using JobBuilder to apply the local timezone
        let job = JobBuilder::new()
            .with_timezone(Local) // <-- This is the magic: run job in local time
            .with_cron_job_type()
            .with_schedule(&cron_expr_6_field) // <-- Use the user's cron string directly
            .map_err(|e| format!("Invalid cron schedule ('{}'): {}", cron_expr_6_field, e))?
            .with_run_async(Box::new(move |_uuid, _l| {
                // This is the async closure that runs on schedule
                let task_id = task_id.clone();
                let task_name = task_name.clone();
                let task_type = task_type.clone();
                let app_handle = app_handle.clone();

                Box::pin(async move {
                    info!(
                        "⏰ Executing task with local timezone: {} ({}) - Type: {:?}",
                        task_name, task_id, task_type
                    );

                    if let Err(e) = execute_scheduled_task(&task_id, &app_handle).await {
                        error!("❌ Task execution failed {}: {}", task_id, e);
                        // Emit error event to frontend
                        let _ = app_handle.emit(
                            SCHEDULED_TASK_ERROR,
                            serde_json::json!({
                                "taskId": task_id,
                                "error": e,
                            }),
                        );
                    } else {
                        info!("✅ Task execution completed: {}", task_id);
                        // Emit success event to frontend
                        let _ = app_handle.emit(
                            SCHEDULED_TASK_COMPLETED,
                            serde_json::json!({
                                "taskId": task_id,
                            }),
                        );
                    }
                })
            }))
            .build()
            .map_err(|e| format!("Failed to build job: {}", e))?;

        // 3. Add the newly built job to the scheduler
        let job_id = scheduler
            .add(job)
            .await
            .map_err(|e| format!("Failed to add job to scheduler: {}", e))?;

        // 4. Store the scheduler's job ID in our task cache
        SCHEDULED_TASKS_CACHE
            .update_task(&task.id, |t| {
                t.scheduler_job_id = Some(job_id.to_string());
            })
            .await
            .ok(); // Log errors but don't fail the whole operation

        info!(
            "📅 Scheduled task '{}' with local timezone: {} (job ID: {})",
            task.name, cron_expr_6_field, job_id
        );

        Ok(job_id)
    }

    /// Unschedule a task
    pub async fn unschedule_task(&self, job_id: Uuid) -> Result<(), String> {
        let scheduler_guard = self.scheduler.read().await;
        let scheduler = scheduler_guard
            .as_ref()
            .ok_or("Scheduler not initialized")?;

        scheduler
            .remove(&job_id)
            .await
            .map_err(|e| format!("Failed to remove job: {}", e))?;

        debug!("🗑️  Unscheduled task with ID: {}", job_id);
        Ok(())
    }

    /// Atomically replace a job in the scheduler.
    pub async fn reschedule_task(&self, task: &ScheduledTask) -> Result<(), String> {
        // 1. Remove the old job, if it exists
        if let Some(job_id_str) = &task.scheduler_job_id {
            if let Ok(job_id) = Uuid::parse_str(job_id_str) {
                match self.unschedule_task(job_id).await {
                    Ok(_) => info!("Removed old job {} for task {}", job_id, task.name),
                    Err(e) => warn!("Failed to remove old job {}: {}", job_id, e),
                }
            }
        }

        // 2. Schedule the new job, if the task is enabled
        if task.status == TaskStatus::Enabled {
            info!("Task {} is enabled, scheduling it...", task.name);
            match self.schedule_task(task).await {
                Ok(new_job_id) => info!(
                    "Successfully rescheduled task {} with new job {}",
                    task.name, new_job_id
                ),
                Err(e) => {
                    error!("Failed to reschedule task {}: {}", task.name, e);
                    // Mark task as failed if scheduling fails
                    SCHEDULED_TASKS_CACHE
                        .update_task(&task.id, |t| t.mark_failure(e.clone()))
                        .await?;
                    return Err(e);
                }
            }
        } else {
            info!(
                "Task {} is disabled, ensuring it is unscheduled.",
                task.name
            );
            // Task is disabled, clear its job ID
            SCHEDULED_TASKS_CACHE
                .update_task(&task.id, |t| {
                    t.scheduler_job_id = None;
                })
                .await
                .ok();
        }

        Ok(())
    }

    /// Reloads all tasks from the cache and syncs the scheduler state.
    pub async fn reload_tasks(&self) -> Result<(), String> {
        info!("🔄 Reloading all scheduled tasks...");

        let tasks = SCHEDULED_TASKS_CACHE.get_all_tasks().await;
        info!("Found {} tasks in cache to sync", tasks.len());

        for task in tasks {
            if let Err(e) = self.reschedule_task(&task).await {
                error!("Failed to reload task {} ({}): {}", task.name, task.id, e);
            }
        }

        info!("✅ Scheduler reload complete");
        Ok(())
    }
}

pub fn validate_cron_expression(cron_expr: &str) -> Result<(), String> {
    croner::parser::CronParser::new()
        .parse(cron_expr)
        .map_err(|e| format!("Invalid cron expression: {}", e))?;
    Ok(())
}

/// Get next run time for a cron expression
pub fn get_next_run(cron_expr: &str) -> Result<chrono::DateTime<Utc>, String> {
    let cron = croner::parser::CronParser::new()
        .parse(cron_expr)
        .map_err(|e| format!("Invalid cron expression: {}", e))?;

    // Calculate next occurrence in local time
    let next_local = cron
        .find_next_occurrence(&Local::now(), false)
        .map_err(|e| format!("Failed to calculate next run: {}", e))?;

    // Return as UTC for consistent storage/display
    Ok(next_local.with_timezone(&Utc))
}

/// Execute a scheduled task
async fn execute_scheduled_task(task_id: &str, app_handle: &AppHandle) -> Result<(), String> {
    let task = SCHEDULED_TASKS_CACHE
        .get_task(task_id)
        .await
        .ok_or("Task not found")?;

    if !task.can_run() {
        return Err(format!("Task cannot run (status: {:?})", task.status));
    }

    SCHEDULED_TASKS_CACHE
        .update_task(task_id, |t| {
            t.mark_starting();
        })
        .await?;

    let result = match task.task_type {
        TaskType::Copy => execute_copy_task(&task, app_handle).await,
        TaskType::Sync => execute_sync_task(&task, app_handle).await,
        TaskType::Move => execute_move_task(&task, app_handle).await,
        TaskType::Bisync => execute_bisync_task(&task, app_handle).await,
    };

    match result {
        Ok(job_id) => {
            if let Some(rclone_job_id) = job_id {
                SCHEDULED_TASKS_CACHE
                    .update_task(task_id, |t| {
                        t.mark_running(rclone_job_id);
                    })
                    .await
                    .ok();
            }
            Ok(())
        }
        Err(e) => {
            let next_run = get_next_run(&task.cron_expression).ok();

            SCHEDULED_TASKS_CACHE
                .update_task(task_id, |t| {
                    t.mark_failure(e.clone());
                    t.next_run = next_run;
                })
                .await?;
            Err(e)
        }
    }
}

/// Execute copy task
async fn execute_copy_task(
    task: &ScheduledTask,
    app_handle: &AppHandle,
) -> Result<Option<u64>, String> {
    use crate::rclone::commands::sync::start_copy;

    let params: CopyParams = serde_json::from_value(task.args.clone())
        .map_err(|e| format!("Failed to parse copy task args: {}", e))?;

    let result = start_copy(app_handle.clone(), params).await?;
    Ok(Some(result))
}

/// Execute sync task
async fn execute_sync_task(
    task: &ScheduledTask,
    app_handle: &AppHandle,
) -> Result<Option<u64>, String> {
    use crate::rclone::commands::sync::start_sync;

    let params: SyncParams = serde_json::from_value(task.args.clone())
        .map_err(|e| format!("Failed to parse sync task args: {}", e))?;

    let result = start_sync(app_handle.clone(), params).await?;
    Ok(Some(result))
}

/// Execute move task
async fn execute_move_task(
    task: &ScheduledTask,
    app_handle: &AppHandle,
) -> Result<Option<u64>, String> {
    use crate::rclone::commands::sync::start_move;

    let params: MoveParams = serde_json::from_value(task.args.clone())
        .map_err(|e| format!("Failed to parse move task args: {}", e))?;

    let result = start_move(app_handle.clone(), params).await?;
    Ok(Some(result))
}

/// Execute bisync task
async fn execute_bisync_task(
    task: &ScheduledTask,
    app_handle: &AppHandle,
) -> Result<Option<u64>, String> {
    use crate::rclone::commands::sync::start_bisync;

    let params: BisyncParams = serde_json::from_value(task.args.clone())
        .map_err(|e| format!("Failed to parse bisync task args: {}", e))?;

    let result = start_bisync(app_handle.clone(), params).await?;
    Ok(Some(result))
}
