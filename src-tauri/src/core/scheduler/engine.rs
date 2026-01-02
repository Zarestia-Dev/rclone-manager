use crate::rclone::commands::sync::{
    start_bisync_profile, start_copy_profile, start_move_profile, start_sync_profile,
};
use crate::rclone::state::scheduled_tasks::ScheduledTasksCache;
use crate::utils::types::all_types::{JobCache, ProfileParams, RcloneState};

use crate::utils::types::scheduled_task::{ScheduledTask, TaskStatus, TaskType};
use chrono::{Local, Utc};
use log::{debug, error, info, warn};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::RwLock;
use tokio_cron_scheduler::{JobBuilder, JobScheduler};
use uuid::Uuid;

/// Global scheduler instance
pub struct CronScheduler {
    pub scheduler: Arc<RwLock<Option<JobScheduler>>>,
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

        let scheduler = JobScheduler::new().await.map_err(
            |e| crate::localized_error!("backendErrors.scheduler.initFailed", "error" => e),
        )?;

        *self.scheduler.write().await = Some(scheduler);
        *self.app_handle.write().await = Some(app_handle);

        info!("✅ Cron scheduler initialized");
        Ok(())
    }

    /// Start the scheduler
    pub async fn start(&self) -> Result<(), String> {
        let mut scheduler_guard = self.scheduler.write().await;
        let scheduler = scheduler_guard
            .as_mut()
            .ok_or(crate::localized_error!("backendErrors.scheduler.initFailed", "error" => "Scheduler not initialized"))?;

        scheduler.start().await.map_err(
            |e| crate::localized_error!("backendErrors.scheduler.startFailed", "error" => e),
        )?;

        info!("▶️  Cron scheduler started");
        Ok(())
    }

    /// Stop the scheduler
    pub async fn stop(&self) -> Result<(), String> {
        let mut scheduler_guard = self.scheduler.write().await;
        let scheduler = scheduler_guard
            .as_mut()
            .ok_or(crate::localized_error!("backendErrors.scheduler.initFailed", "error" => "Scheduler not initialized"))?;

        // Attempt to shutdown the scheduler. If shutdown fails, return an error.
        scheduler.shutdown().await.map_err(
            |e| crate::localized_error!("backendErrors.scheduler.stopFailed", "error" => e),
        )?;

        info!("⏸️  Cron scheduler stopped");
        Ok(())
    }

    /// Schedule a task
    pub async fn schedule_task(
        &self,
        task: &ScheduledTask,
        cache: State<'_, ScheduledTasksCache>,
    ) -> Result<Uuid, String> {
        if task.status != TaskStatus::Enabled {
            return Err(crate::localized_error!(
                "backendErrors.scheduler.taskNotEnabled"
            ));
        }

        let scheduler_guard = self.scheduler.read().await;
        let scheduler = scheduler_guard
            .as_ref()
            .ok_or(crate::localized_error!("backendErrors.scheduler.initFailed", "error" => "Scheduler not initialized"))?;

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
        let app_handle_for_job = app_handle.clone();
        let job = JobBuilder::new()
            .with_timezone(Local)
            .with_cron_job_type()
            .with_schedule(&cron_expr_6_field)
            .map_err(|e| crate::localized_error!("backendErrors.scheduler.invalidCron", "error" => e))?
            .with_run_async(Box::new(move |_uuid, _l| {
                // This is the async closure that runs on schedule
                let task_id = task_id.clone();
                let task_name = task_name.clone();
                let task_type = task_type.clone();
                let app_handle = app_handle_for_job.clone();

                Box::pin(async move {
                    info!(
                        "⏰ Executing task with local timezone: {} ({}) - Type: {:?}",
                        task_name, task_id, task_type
                    );

                    // --- Get cache from app_handle for the spawned task ---
                    let cache = app_handle.state::<ScheduledTasksCache>();

                    if let Err(e) = execute_scheduled_task(&task_id, &app_handle, cache).await {
                        error!("❌ Task execution failed {}: {}", task_id, e);
                    } else {
                        info!("✅ Task execution completed: {}", task_id);
                    }
                })
            }))
            .build()
            .map_err(|e| crate::localized_error!("backendErrors.scheduler.executionFailed", "error" => e))?;

        // 3. Add the newly built job to the scheduler
        let job_id = scheduler.add(job).await.map_err(
            |e| crate::localized_error!("backendErrors.scheduler.executionFailed", "error" => e),
        )?;

        // 4. Store the scheduler's job ID in our task cache
        cache
            .update_task(
                &task.id,
                |t| {
                    t.scheduler_job_id = Some(job_id.to_string());
                },
                Some(&app_handle),
            )
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

        scheduler.remove(&job_id).await.map_err(
            |e| crate::localized_error!("backendErrors.scheduler.executionFailed", "error" => e),
        )?;

        debug!("🗑️  Unscheduled task with ID: {}", job_id);
        Ok(())
    }

    /// Atomically replace a job in the scheduler.
    pub async fn reschedule_task(
        &self,
        task: &ScheduledTask,
        cache: State<'_, ScheduledTasksCache>,
    ) -> Result<(), String> {
        // 1. Remove the old job, if it exists
        if let Some(job_id_str) = &task.scheduler_job_id
            && let Ok(job_id) = Uuid::parse_str(job_id_str)
        {
            match self.unschedule_task(job_id).await {
                Ok(_) => info!("Removed old job {} for task {}", job_id, task.name),
                Err(e) => warn!("Failed to remove old job {}: {}", job_id, e),
            }
        }

        // 2. Schedule the new job, if the task is enabled
        if task.status == TaskStatus::Enabled {
            info!("Task {} is enabled, scheduling it...", task.name);
            match self.schedule_task(task, cache.clone()).await {
                Ok(new_job_id) => info!(
                    "Successfully rescheduled task {} with new job {}",
                    task.name, new_job_id
                ),
                Err(e) => {
                    error!("Failed to reschedule task {}: {}", task.name, e);
                    // Mark task as failed if scheduling fails
                    cache
                        .update_task(&task.id, |t| t.mark_failure(e.clone()), None)
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
            cache
                .update_task(
                    &task.id,
                    |t| {
                        t.scheduler_job_id = None;
                    },
                    None,
                )
                .await
                .ok();
        }

        Ok(())
    }

    /// Reloads all tasks from the cache and syncs the scheduler state.
    pub async fn reload_tasks(&self, cache: State<'_, ScheduledTasksCache>) -> Result<(), String> {
        info!("🔄 Reloading all scheduled tasks...");

        let tasks = cache.get_all_tasks().await;
        info!("Found {} tasks in cache to sync", tasks.len());

        for task in tasks {
            if let Err(e) = self.reschedule_task(&task, cache.clone()).await {
                // <-- Pass cache
                error!("Failed to reload task {} ({}): {}", task.name, task.id, e);
            }
        }

        info!("✅ Scheduler reload complete");
        Ok(())
    }
}

pub fn validate_cron_expression(cron_expr: &str) -> Result<(), String> {
    croner::parser::CronParser::new().parse(cron_expr).map_err(
        |e| crate::localized_error!("backendErrors.scheduler.invalidCron", "error" => e),
    )?;
    Ok(())
}

/// Get next run time for a cron expression
pub fn get_next_run(cron_expr: &str) -> Result<chrono::DateTime<Utc>, String> {
    let cron = croner::parser::CronParser::new()
        .parse(cron_expr)
        .map_err(|e| format!("Invalid cron expression: {}", e))?;

    // Calculate next occurrence in local time
    let next_local = cron.find_next_occurrence(&Local::now(), false).map_err(
        |e| crate::localized_error!("backendErrors.scheduler.executionFailed", "error" => e),
    )?;

    // Return as UTC for consistent storage/display
    Ok(next_local.with_timezone(&Utc))
}

/// Execute a scheduled task
async fn execute_scheduled_task(
    task_id: &str,
    app_handle: &AppHandle,
    cache: State<'_, ScheduledTasksCache>,
) -> Result<(), String> {
    let task = cache
        .get_task(task_id)
        .await
        .ok_or(crate::localized_error!(
            "backendErrors.scheduler.taskNotFound"
        ))?;

    if !task.can_run() {
        return Err(
            crate::localized_error!("backendErrors.scheduler.taskCannotRun", "status" => format!("{:?}", task.status)),
        );
    }

    // --- Get Managed State ---
    let job_cache = app_handle.state::<JobCache>();
    let rclone_state = app_handle.state::<RcloneState>();

    // --- Add Job Cache Check ---
    let remote_name = match task.args.get("remote_name").and_then(|v| v.as_str()) {
        Some(name) => name.to_string(),
        None => {
            return Err(
                crate::localized_error!("backendErrors.scheduler.invalidTaskArgs", "error" => "missing 'remote_name' in args"),
            );
        }
    };
    let job_type = task.task_type.as_str();
    let profile = task.args.get("profile").and_then(|v| v.as_str());

    if job_cache
        .is_job_running(&remote_name, job_type, profile)
        .await
    {
        warn!(
            "Scheduler skipping task '{}': A '{}' job for remote '{}' (profile: {:?}) is already running.",
            task.name, job_type, remote_name, profile
        );
        return Ok(());
    }

    cache
        .update_task(
            task_id,
            |t| {
                let _ = t.mark_starting();
            },
            Some(app_handle),
        )
        .await?;

    let params: ProfileParams = serde_json::from_value(task.args.clone()).map_err(
        |e| crate::localized_error!("backendErrors.scheduler.invalidTaskArgs", "error" => e),
    )?;

    let result = match task.task_type {
        TaskType::Copy => start_copy_profile(app_handle.clone(), rclone_state, params).await,
        TaskType::Sync => start_sync_profile(app_handle.clone(), rclone_state, params).await,
        TaskType::Move => start_move_profile(app_handle.clone(), rclone_state, params).await,
        TaskType::Bisync => start_bisync_profile(app_handle.clone(), rclone_state, params).await,
    };

    match result {
        Ok(job_id) => {
            cache
                .update_task(
                    task_id,
                    |t| {
                        t.mark_running(job_id);
                    },
                    Some(app_handle),
                )
                .await
                .ok();
            Ok(())
        }
        Err(e) => {
            let next_run = get_next_run(&task.cron_expression).ok();

            cache
                .update_task(
                    task_id,
                    |t| {
                        t.mark_failure(e.clone());
                        t.next_run = next_run;
                    },
                    Some(app_handle),
                )
                .await?;
            Err(e)
        }
    }
}

impl Default for CronScheduler {
    fn default() -> Self {
        Self::new()
    }
}
