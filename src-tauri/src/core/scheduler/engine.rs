use crate::rclone::commands::sync::{BisyncParams, CopyParams, MoveParams, SyncParams};
use crate::rclone::state::scheduled_tasks::SCHEDULED_TASKS_CACHE;
use crate::utils::types::events::{SCHEDULED_TASK_COMPLETED, SCHEDULED_TASK_ERROR};
use crate::utils::types::scheduled_task::{ScheduledTask, TaskStatus, TaskType};
use chrono::{Local, Utc};
use log::{debug, error, info, warn};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::RwLock;
use tokio_cron_scheduler::{Job, JobScheduler};
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

    /// Initialize the scheduler with the app handle in UTC.
    pub async fn initialize(&self, app_handle: AppHandle) -> Result<(), String> {
        info!("🕐 Initializing cron scheduler in UTC...");

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
        // ... (this function is correct, no changes needed) ...
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
        let cron_expr = task.cron_expression.clone();

        validate_cron_expression(&cron_expr)?;

        // We must convert the local cron string to a UTC cron string
        // before giving it to the UTC scheduler.
        let utc_cron = convert_local_cron_to_utc(&cron_expr)?;
        let cron_with_seconds = format!("0 {}", utc_cron);

        // Create the job
        let job = Job::new_async(cron_with_seconds.as_str(), move |_uuid, _l| {
            let task_id = task_id.clone();
            let task_name = task_name.clone();
            let task_type = task_type.clone();
            let app_handle = app_handle.clone();

            Box::pin(async move {
                info!(
                    "⏰ Executing scheduled task: {} ({}) - Type: {:?}",
                    task_name, task_id, task_type
                );

                if let Err(e) = execute_scheduled_task(&task_id, &app_handle).await {
                    error!("❌ Failed to execute scheduled task {}: {}", task_id, e);
                    let _ = app_handle.emit(
                        SCHEDULED_TASK_ERROR,
                        serde_json::json!({
                            "taskId": task_id,
                            "error": e,
                        }),
                    );
                } else {
                    info!("✅ Successfully executed scheduled task: {}", task_id);
                    let _ = app_handle.emit(
                        SCHEDULED_TASK_COMPLETED,
                        serde_json::json!({
                            "taskId": task_id,
                        }),
                    );
                }
            })
        })
        .map_err(|e| format!("Failed to create job: {}", e))?;

        let job_id = scheduler
            .add(job)
            .await
            .map_err(|e| format!("Failed to add job to scheduler: {}", e))?;

        // Store the scheduler job ID in the task
        SCHEDULED_TASKS_CACHE
            .update_task(&task.id, |t| {
                t.scheduler_job_id = Some(job_id.to_string());
            })
            .await
            .ok(); // Ignore errors here

        info!(
            "📅 Scheduled task '{}' with cron: {} (UTC: {}) (job ID: {})",
            task.name, cron_expr, utc_cron, job_id
        );

        Ok(job_id)
    }

    /// Unschedule a task
    pub async fn unschedule_task(&self, job_id: Uuid) -> Result<(), String> {
        // ... (this function is correct, no changes needed) ...
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

/// Convert a local time cron expression to UTC
/// Takes a 5-field cron expression in local time and converts it to UTC
pub fn convert_local_cron_to_utc(local_cron: &str) -> Result<String, String> {
    let parts: Vec<&str> = local_cron.trim().split_whitespace().collect();
    if parts.len() != 5 {
        return Err(
            "Cron expression must have 5 fields (minute hour day month weekday)".to_string(),
        );
    }

    let minute = parts[0];
    let hour = parts[1];
    let day = parts[2];
    let month = parts[3];
    let weekday = parts[4];

    // If hour is a wildcard/range, we cannot safely convert it.
    // Return the original string and warn the user.
    if hour.contains('*') || hour.contains('/') || hour.contains('-') || hour.contains(',') {
        warn!(
            "⚠️  Cron expression '{}' uses a wildcard/range for the hour. Scheduling as-is. This may not run at the intended local time.",
            local_cron
        );
        return Ok(local_cron.to_string());
    }

    // Get local timezone offset in hours
    let now = Local::now();
    let offset_seconds = now.offset().local_minus_utc();
    let offset_hours = offset_seconds / 3600; // Can be positive or negative

    let hour_val: i32 = hour
        .parse()
        .map_err(|_| format!("Invalid hour value: {}", hour))?;

    // Calculate UTC hour
    let mut utc_hour = hour_val - offset_hours;
    let mut day_adjustment = 0;

    // Handle day rollover
    if utc_hour < 0 {
        utc_hour += 24;
        day_adjustment = -1; // Ran on the previous day in UTC
    } else if utc_hour >= 24 {
        utc_hour -= 24;
        day_adjustment = 1; // Ran on the next day in UTC
    }

    // If we had a day adjustment, we must check if the day/weekday fields are also restricted.
    // This is a very complex problem (e.g., "0 1 * * 1" -> "0 23 * * 0" in -2 TZ)
    // For now, we will just adjust the hour and warn if a day adjustment happened.
    if day_adjustment != 0 && (day != "*" || weekday != "*") {
        warn!(
            "⚠️  Cron expression '{}' crosses a day boundary when converted to UTC. Day/Weekday fields may not be accurate.",
            local_cron
        );
    }

    let utc_cron = format!("{} {} {} {} {}", minute, utc_hour, day, month, weekday);

    info!(
        "🌐 Converted cron from local to UTC: '{}' -> '{}' (offset: {} hours)",
        local_cron, utc_cron, offset_hours
    );

    Ok(utc_cron)
}

/// Validate a cron expression using the `croner` library
pub fn validate_cron_expression(cron_expr: &str) -> Result<(), String> {
    croner::Cron::new(cron_expr)
        .parse()
        .map_err(|e| format!("Invalid cron expression: {}", e))?;
    Ok(())
}

/// Get next run time for a cron expression
pub fn get_next_run(cron_expr: &str) -> Result<chrono::DateTime<Utc>, String> {
    let cron = croner::Cron::new(cron_expr)
        .parse()
        .map_err(|e| format!("Invalid cron expression: {}", e))?;

    // Calculate next run time from Local::now()
    let next_local = cron
        .find_next_occurrence(&Local::now(), false)
        .map_err(|e| format!("Failed to calculate next run: {}", e))?;

    // Convert the resulting local time to UTC for storage
    Ok(next_local.with_timezone(&Utc))
}

/// Get human-readable description of cron expression
pub fn get_cron_description(cron_expr: &str) -> Result<String, String> {
    let cron = croner::Cron::new(cron_expr)
        .parse()
        .map_err(|e| format!("Invalid cron expression: {}", e))?;
    Ok(cron.pattern.to_string())
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
            SCHEDULED_TASKS_CACHE
                .update_task(task_id, |t| {
                    t.mark_success(job_id);
                })
                .await?;
            Ok(())
        }
        Err(e) => {
            SCHEDULED_TASKS_CACHE
                .update_task(task_id, |t| {
                    t.mark_failure(e.clone());
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
    let state: State<crate::utils::types::all_types::RcloneState> = app_handle.state();

    let params: CopyParams = serde_json::from_value(task.args.clone())
        .map_err(|e| format!("Failed to parse copy task args: {}", e))?;

    let result = start_copy(app_handle.clone(), params, state).await?;
    Ok(Some(result))
}

/// Execute sync task
async fn execute_sync_task(
    task: &ScheduledTask,
    app_handle: &AppHandle,
) -> Result<Option<u64>, String> {
    use crate::rclone::commands::sync::start_sync;
    let state: State<crate::utils::types::all_types::RcloneState> = app_handle.state();

    let params: SyncParams = serde_json::from_value(task.args.clone())
        .map_err(|e| format!("Failed to parse sync task args: {}", e))?;

    let result = start_sync(app_handle.clone(), params, state).await?;
    Ok(Some(result))
}

/// Execute move task
async fn execute_move_task(
    task: &ScheduledTask,
    app_handle: &AppHandle,
) -> Result<Option<u64>, String> {
    use crate::rclone::commands::sync::start_move;
    let state: State<crate::utils::types::all_types::RcloneState> = app_handle.state();

    let params: MoveParams = serde_json::from_value(task.args.clone())
        .map_err(|e| format!("Failed to parse move task args: {}", e))?;

    let result = start_move(app_handle.clone(), params, state).await?;
    Ok(Some(result))
}

/// Execute bisync task
async fn execute_bisync_task(
    task: &ScheduledTask,
    app_handle: &AppHandle,
) -> Result<Option<u64>, String> {
    use crate::rclone::commands::sync::start_bisync;
    let state: State<crate::utils::types::all_types::RcloneState> = app_handle.state();

    let params: BisyncParams = serde_json::from_value(task.args.clone())
        .map_err(|e| format!("Failed to parse bisync task args: {}", e))?;

    let result = start_bisync(app_handle.clone(), params, state).await?;
    Ok(Some(result))
}
