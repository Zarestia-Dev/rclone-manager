use crate::rclone::commands::sync::{TransferType, start_profile_batch};
use crate::rclone::state::scheduled_tasks::{CacheUpdateResult, ScheduledTasksCache};

use crate::utils::types::remotes::ProfileParams;
use crate::utils::types::scheduled_task::{ScheduledTask, TaskStatus, TaskType};
use chrono::{Local, Utc};
use log::{debug, error, info, warn};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::RwLock;
use tokio_cron_scheduler::{JobBuilder, JobScheduler};
use uuid::Uuid;

// ============================================================================
// CRON SCHEDULER
// ============================================================================

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

    /// Initialise the scheduler with the app handle (call once at startup).
    pub async fn initialize(&self, app_handle: AppHandle) -> Result<(), String> {
        info!("🕐 Initializing cron scheduler...");

        let scheduler = JobScheduler::new().await.map_err(
            |e| crate::localized_error!("backendErrors.scheduler.initFailed", "error" => e),
        )?;

        *self.scheduler.write().await = Some(scheduler);
        *self.app_handle.write().await = Some(app_handle);

        info!("✅ Cron scheduler initialized");
        Ok(())
    }

    pub async fn start(&self) -> Result<(), String> {
        let mut guard = self.scheduler.write().await;
        let scheduler = guard.as_mut().ok_or_else(|| {
            crate::localized_error!(
                "backendErrors.scheduler.initFailed",
                "error" => "Scheduler not initialized"
            )
        })?;

        scheduler.start().await.map_err(
            |e| crate::localized_error!("backendErrors.scheduler.startFailed", "error" => e),
        )?;

        info!("▶️  Cron scheduler started");
        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let mut guard = self.scheduler.write().await;
        let scheduler = guard.as_mut().ok_or_else(|| {
            crate::localized_error!(
                "backendErrors.scheduler.initFailed",
                "error" => "Scheduler not initialized"
            )
        })?;

        scheduler.shutdown().await.map_err(
            |e| crate::localized_error!("backendErrors.scheduler.stopFailed", "error" => e),
        )?;

        info!("⏸️  Cron scheduler stopped");
        Ok(())
    }

    /// Schedule a task and return the new scheduler job UUID.
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

        if let Some(old_job_id_str) = &task.scheduler_job_id
            && let Ok(old_job_id) = Uuid::parse_str(old_job_id_str)
            && let Err(e) = self.unschedule_task(old_job_id).await
        {
            warn!(
                "Failed to remove old scheduler job {} for task '{}': {}",
                old_job_id, task.name, e
            );
        }

        let scheduler_guard = self.scheduler.read().await;
        let scheduler = scheduler_guard.as_ref().ok_or_else(|| {
            crate::localized_error!(
                "backendErrors.scheduler.initFailed",
                "error" => "Scheduler not initialized"
            )
        })?;

        let app_guard = self.app_handle.read().await;
        let app_handle = app_guard
            .as_ref()
            .ok_or("App handle not initialized")?
            .clone();

        let task_id = task.id.clone();
        let task_name = task.name.clone();
        let task_type = task.task_type.clone();
        let cron_expr_5_field = task.cron_expression.clone();
        // tokio-cron-scheduler requires 6 fields; users supply 5.
        // Prepend "0 " → "at second 0 of every matching minute".
        let cron_expr_6_field = format!("0 {}", cron_expr_5_field);

        let app_handle_for_job = app_handle.clone();
        let job = JobBuilder::new()
            .with_timezone(Local)
            .with_cron_job_type()
            .with_schedule(&cron_expr_6_field)
            .map_err(
                |e| crate::localized_error!("backendErrors.scheduler.invalidCron", "error" => e),
            )?
            .with_run_async(Box::new(move |_uuid, _l| {
                let task_id = task_id.clone();
                let task_name = task_name.clone();
                let task_type = task_type.clone();
                let app_handle = app_handle_for_job.clone();

                Box::pin(async move {
                    info!(
                        "⏰ Executing scheduled task: {} ({}) — {:?}",
                        task_name, task_id, task_type
                    );

                    let cache = app_handle.state::<ScheduledTasksCache>();
                    if let Err(e) = execute_scheduled_task(&task_id, &app_handle, cache).await {
                        error!("❌ Task execution failed {}: {}", task_id, e);
                    } else {
                        info!("✅ Task execution completed: {}", task_id);
                    }
                })
            }))
            .build()
            .map_err(
                |e| crate::localized_error!("backendErrors.scheduler.executionFailed", "error" => e),
            )?;

        let job_id = scheduler.add(job).await.map_err(
            |e| crate::localized_error!("backendErrors.scheduler.executionFailed", "error" => e),
        )?;

        cache
            .update_task(
                &task.id,
                |t| {
                    t.scheduler_job_id = Some(job_id.to_string());
                },
                Some(&app_handle),
            )
            .await
            .ok();

        info!(
            "📅 Scheduled '{}' ({}) — job ID: {}",
            task.name, cron_expr_6_field, job_id
        );

        Ok(job_id)
    }

    /// Remove a job from the underlying scheduler by its UUID.
    pub async fn unschedule_task(&self, job_id: Uuid) -> Result<(), String> {
        let guard = self.scheduler.read().await;
        let scheduler = guard.as_ref().ok_or("Scheduler not initialized")?;

        scheduler.remove(&job_id).await.map_err(
            |e| crate::localized_error!("backendErrors.scheduler.executionFailed", "error" => e),
        )?;

        debug!("🗑️  Unscheduled job: {}", job_id);
        Ok(())
    }

    /// Atomically replace a task's scheduler job.
    pub async fn reschedule_task(
        &self,
        task: &ScheduledTask,
        cache: State<'_, ScheduledTasksCache>,
    ) -> Result<(), String> {
        if let Some(job_id_str) = &task.scheduler_job_id
            && let Ok(job_id) = Uuid::parse_str(job_id_str)
        {
            match self.unschedule_task(job_id).await {
                Ok(_) => info!("Removed old job {} for '{}'", job_id, task.name),
                Err(e) => warn!("Failed to remove old job {}: {}", job_id, e),
            }
        }

        if task.status == TaskStatus::Enabled {
            info!("Scheduling enabled task '{}'…", task.name);
            match self.schedule_task(task, cache.clone()).await {
                Ok(new_job_id) => {
                    info!("Rescheduled '{}' → job {}", task.name, new_job_id)
                }
                Err(e) => {
                    error!("Failed to reschedule '{}': {}", task.name, e);
                    cache
                        .update_task(&task.id, |t| t.mark_failure(e.clone()), None)
                        .await?;
                    return Err(e);
                }
            }
        } else {
            info!("Task '{}' is disabled — clearing job ID.", task.name);
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

    /// Reload all tasks from the cache, rescheduling every one.
    pub async fn reload_tasks(&self, cache: State<'_, ScheduledTasksCache>) -> Result<(), String> {
        info!("🔄 Reloading all scheduled tasks…");

        let tasks = cache.get_all_tasks().await;
        info!("Found {} task(s) to sync", tasks.len());

        let mut errors: Vec<String> = Vec::new();
        for task in tasks {
            if let Err(e) = self.reschedule_task(&task, cache.clone()).await {
                error!("Failed to reload '{}' ({}): {}", task.name, task.id, e);
                errors.push(format!("{}: {}", task.id, e));
            }
        }

        if errors.is_empty() {
            info!("✅ Scheduler reload complete");
            Ok(())
        } else {
            Err(format!(
                "{} task(s) failed to reload: {}",
                errors.len(),
                errors.join("; ")
            ))
        }
    }

    /// Apply a `CacheUpdateResult` to the live scheduler.
    pub async fn apply_cache_result(
        &self,
        result: &CacheUpdateResult,
        cache: State<'_, ScheduledTasksCache>,
    ) -> Result<(), String> {
        for task in &result.removed {
            if let Some(job_id_str) = &task.scheduler_job_id
                && let Ok(job_id) = Uuid::parse_str(job_id_str)
                && let Err(e) = self.unschedule_task(job_id).await
            {
                warn!("Failed to unschedule removed task '{}': {}", task.id, e);
            }
        }

        let mut errors: Vec<String> = Vec::new();
        for task in result.added.iter().chain(result.updated.iter()) {
            if let Err(e) = self.reschedule_task(task, cache.clone()).await {
                error!("Failed to reschedule '{}' ({}): {}", task.name, task.id, e);
                errors.push(format!("{}: {}", task.id, e));
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "{} task(s) failed to reschedule: {}",
                errors.len(),
                errors.join("; ")
            ))
        }
    }
}

impl Default for CronScheduler {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// CRON EXPRESSION UTILITIES
// ============================================================================

pub fn validate_cron_expression(cron_expr: &str) -> Result<(), String> {
    // Reject six-field expressions from the user — we expect five fields
    // (minute hour day month weekday). The scheduler adds a seconds field.
    if cron_expr.split_whitespace().count() == 6 {
        return Err(
            crate::localized_error!("backendErrors.scheduler.invalidCron", "error" => "unexpected number of fields"),
        );
    }
    croner::parser::CronParser::new().parse(cron_expr).map_err(
        |e| crate::localized_error!("backendErrors.scheduler.invalidCron", "error" => e),
    )?;

    // Check with tokio-cron-scheduler (used for actual scheduling).
    // Users provide 5 fields; the scheduler expects 6 — prepend "0 ".
    let cron_6_field = format!("0 {}", cron_expr);
    JobBuilder::new()
        .with_cron_job_type()
        .with_schedule(&cron_6_field)
        .map_err(
            |e| crate::localized_error!("backendErrors.scheduler.invalidCron", "error" => e),
        )?;

    Ok(())
}

/// Calculate the next UTC fire time for a 5-field cron expression.
pub fn get_next_run(cron_expr: &str) -> Result<chrono::DateTime<Utc>, String> {
    let cron = croner::parser::CronParser::new()
        .parse(cron_expr)
        .map_err(|e| format!("Invalid cron expression: {}", e))?;

    let next_local = cron.find_next_occurrence(&Local::now(), false).map_err(
        |e| crate::localized_error!("backendErrors.scheduler.executionFailed", "error" => e),
    )?;

    Ok(next_local.with_timezone(&Utc))
}

// ============================================================================
// TASK EXECUTION
// ============================================================================

async fn execute_scheduled_task(
    task_id: &str,
    app_handle: &AppHandle,
    cache: State<'_, ScheduledTasksCache>,
) -> Result<(), String> {
    let task = cache
        .get_task(task_id)
        .await
        .ok_or_else(|| crate::localized_error!("backendErrors.scheduler.taskNotFound"))?;

    if !task.can_run() {
        return Err(crate::localized_error!(
            "backendErrors.scheduler.taskCannotRun",
            "status" => format!("{:?}", task.status)
        ));
    }

    use crate::rclone::backend::BackendManager;
    let backend_manager = app_handle.state::<BackendManager>();
    let job_cache = &backend_manager.job_cache;

    let remote_name = match task.args.get("remote_name").and_then(|v| v.as_str()) {
        Some(name) => name.to_string(),
        None => {
            return Err(crate::localized_error!(
                "backendErrors.scheduler.invalidTaskArgs",
                "error" => "missing 'remote_name' in args"
            ));
        }
    };

    let job_type = task.task_type.as_job_type();
    let profile = task.args.get("profile_name").and_then(|v| v.as_str());

    if job_cache
        .is_job_running(&remote_name, job_type.clone(), profile)
        .await
    {
        warn!(
            "Skipping '{}': a '{}' job for '{}' (profile: {:?}) is already running.",
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

    let transfer_type = match task.task_type {
        TaskType::Copy => TransferType::Copy,
        TaskType::Sync => TransferType::Sync,
        TaskType::Move => TransferType::Move,
        TaskType::Bisync => TransferType::Bisync,
    };

    let result = start_profile_batch(app_handle.clone(), vec![params], transfer_type).await;

    match result {
        Ok(job_id) => {
            let next_run = get_next_run(&task.cron_expression).ok();
            cache
                .update_task(
                    task_id,
                    |t| {
                        t.mark_running(job_id);
                        t.next_run = next_run;
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

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, Timelike};

    // -----------------------------------------------------------------------
    // validate_cron_expression
    // -----------------------------------------------------------------------

    #[test]
    fn test_validate_cron_valid_expressions() {
        assert!(validate_cron_expression("* * * * *").is_ok());
        assert!(validate_cron_expression("0 9 * * 1-5").is_ok());
        assert!(validate_cron_expression("*/15 * * * *").is_ok());
        assert!(validate_cron_expression("0 0 1 * *").is_ok());
        assert!(validate_cron_expression("30 6 * * 1,3,5").is_ok());
    }

    #[test]
    fn test_validate_cron_invalid_expressions() {
        assert!(validate_cron_expression("invalid").is_err());
        // 6 fields from the user is rejected (we add the seconds field ourselves)
        assert!(validate_cron_expression("* * * * * *").is_err());
        // Minute 60 is out of range
        assert!(validate_cron_expression("60 * * * *").is_err());
        // Empty string
        assert!(validate_cron_expression("").is_err());
    }

    // -----------------------------------------------------------------------
    // get_next_run
    // -----------------------------------------------------------------------

    #[test]
    fn test_get_next_run_is_in_the_future() {
        let now = Utc::now();
        let next = get_next_run("* * * * *").unwrap();
        assert!(next > now, "next run must be after now");
    }

    #[test]
    fn test_get_next_run_specific_date() {
        // Jan 1st midnight — local time
        let next = get_next_run("0 0 1 1 *").unwrap();
        let local = next.with_timezone(&Local);
        assert_eq!(local.minute(), 0);
        assert_eq!(local.hour(), 0);
        assert_eq!(local.day(), 1);
        assert_eq!(local.month(), 1);
    }

    #[test]
    fn test_get_next_run_invalid_expression_returns_err() {
        assert!(get_next_run("not-valid").is_err());
        assert!(get_next_run("").is_err());
    }

    // -----------------------------------------------------------------------
    // validate_cron_expression — boundary values
    // -----------------------------------------------------------------------

    #[test]
    fn test_validate_cron_boundary_minutes() {
        // Minute 0 and 59 are valid
        assert!(validate_cron_expression("0 * * * *").is_ok());
        assert!(validate_cron_expression("59 * * * *").is_ok());
        // Minute 60 is invalid
        assert!(validate_cron_expression("60 * * * *").is_err());
    }

    #[test]
    fn test_validate_cron_step_values() {
        assert!(validate_cron_expression("*/5 * * * *").is_ok());
        assert!(validate_cron_expression("*/30 * * * *").is_ok());
    }

    #[test]
    fn test_validate_cron_ranges() {
        assert!(validate_cron_expression("0 9-17 * * *").is_ok());
        assert!(validate_cron_expression("0 0 * * 1-5").is_ok());
    }

    // -----------------------------------------------------------------------
    // CronScheduler construction (no async runtime needed)
    // -----------------------------------------------------------------------

    #[test]
    fn test_cron_scheduler_default() {
        let s = CronScheduler::default();
        // These must not panic
        let _ = Arc::clone(&s.scheduler);
        let _ = Arc::clone(&s.app_handle);
    }
}
