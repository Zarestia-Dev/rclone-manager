use crate::rclone::state::scheduled_tasks::SCHEDULED_TASKS_CACHE;
use crate::utils::types::events::{SCHEDULED_TASK_COMPLETED, SCHEDULED_TASK_ERROR};
use crate::utils::types::scheduled_task::{ScheduledTask, TaskStatus, TaskType};
use chrono::{Local, Utc};
use log::{debug, error, info, warn};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;
use tokio_cron_scheduler::{Job, JobScheduler};

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

    /// Initialize the scheduler with the app handle
    pub async fn initialize(&self, app_handle: AppHandle) -> Result<(), String> {
        info!("🕐 Initializing cron scheduler...");

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
    pub async fn schedule_task(&self, task: &ScheduledTask) -> Result<uuid::Uuid, String> {
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

        // Validate cron expression first
        if let Err(e) = validate_cron_expression(&cron_expr) {
            return Err(format!("Invalid cron expression: {}", e));
        }

        // Convert local time cron to UTC (tokio-cron-scheduler uses UTC)
        let utc_cron = convert_local_cron_to_utc(&cron_expr)?;

        // Convert 5-field cron to 6-field format (tokio-cron-scheduler requires seconds)
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

                // Execute the task
                if let Err(e) = execute_scheduled_task(&task_id, &app_handle).await {
                    error!("❌ Failed to execute scheduled task {}: {}", task_id, e);

                    // Send error event to frontend
                    let _ = app_handle.emit(
                        SCHEDULED_TASK_ERROR,
                        serde_json::json!({
                            "taskId": task_id,
                            "error": e,
                        }),
                    );
                } else {
                    info!("✅ Successfully executed scheduled task: {}", task_id);

                    // Send success event to frontend
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
            "📅 Scheduled task '{}' with cron: {} (job ID: {})",
            task.name, cron_expr, job_id
        );

        Ok(job_id)
    }

    /// Unschedule a task
    pub async fn unschedule_task(&self, job_id: uuid::Uuid) -> Result<(), String> {
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

    /// Reload all tasks from cache and reschedule them
    /// Reload all tasks from cache and reschedule them
    pub async fn reload_tasks(&self) -> Result<(), String> {
        info!("🔄 Reloading all scheduled tasks...");

        // Get all tasks to check for disabled ones
        let all_tasks = SCHEDULED_TASKS_CACHE.get_all_tasks().await;
        let disabled_tasks: Vec<_> = all_tasks
            .iter()
            .filter(|t| t.status == TaskStatus::Disabled && t.scheduler_job_id.is_some())
            .collect();

        // Unschedule disabled tasks that still have scheduler job IDs
        if !disabled_tasks.is_empty() {
            info!("🗑️  Unscheduling {} disabled task(s)", disabled_tasks.len());
            for task in disabled_tasks {
                if let Some(job_id_str) = &task.scheduler_job_id {
                    if let Ok(job_id) = uuid::Uuid::parse_str(job_id_str) {
                        if let Err(e) = self.unschedule_task(job_id).await {
                            warn!("Failed to unschedule task {}: {}", task.name, e);
                        } else {
                            info!("✅ Unscheduled disabled task: {}", task.name);
                            // Clear the scheduler job ID from the task
                            SCHEDULED_TASKS_CACHE
                                .update_task(&task.id, |t| {
                                    t.scheduler_job_id = None;
                                })
                                .await
                                .ok();
                        }
                    }
                }
            }
        }

        let mut scheduler_guard = self.scheduler.write().await;

        // 1. Stop and shut down the current scheduler, if it exists
        if let Some(mut scheduler) = scheduler_guard.take() {
            if let Err(e) = scheduler.shutdown().await {
                warn!("Failed to shut down existing scheduler: {}", e);
            }
        }

        // 2. Create a new scheduler
        let new_scheduler = JobScheduler::new()
            .await
            .map_err(|e| format!("Failed to create new scheduler: {}", e))?;

        // 3. Get all tasks from the cache
        let tasks = SCHEDULED_TASKS_CACHE.get_all_tasks().await;
        let enabled_tasks: Vec<_> = tasks
            .iter()
            .filter(|t| t.status == TaskStatus::Enabled)
            .collect();

        info!("Found {} enabled tasks to schedule", enabled_tasks.len());

        let app_guard = self.app_handle.read().await;
        let app_handle = app_guard
            .as_ref()
            .ok_or("App handle not initialized")?
            .clone();

        // 4. Add enabled tasks to the new scheduler
        for task in enabled_tasks {
            let task_id = task.id.clone();
            let task_name = task.name.clone();
            let task_type = task.task_type.clone();
            let cron_expr = task.cron_expression.clone();
            let app_handle_clone = app_handle.clone();

            info!(
                "🔧 Preparing to schedule task: {} with cron: {}",
                task_name, cron_expr
            );

            if let Err(e) = validate_cron_expression(&cron_expr) {
                error!("❌ Invalid cron for task {}: {}", task_name, e);
                continue; // Skip this task
            }

            // Convert local time cron to UTC (tokio-cron-scheduler uses UTC)
            let utc_cron = match convert_local_cron_to_utc(&cron_expr) {
                Ok(c) => c,
                Err(e) => {
                    error!(
                        "❌ Failed to convert cron to UTC for task {}: {}",
                        task_name, e
                    );
                    continue;
                }
            };

            // Convert 5-field cron to 6-field format (tokio-cron-scheduler requires seconds)
            let cron_with_seconds = format!("0 {}", utc_cron);
            info!(
                "🔨 Creating job for task: {} with cron: {} (UTC: {})",
                task_name, cron_expr, cron_with_seconds
            );
            let task_name_clone = task_name.clone();
            let job = Job::new_async(cron_with_seconds.as_str(), move |_uuid, _l| {
                let task_id = task_id.clone();
                let task_name_clone = task_name_clone.clone();
                let task_type = task_type.clone();
                let app_handle = app_handle_clone.clone();

                Box::pin(async move {
                    info!(
                        "⏰ Executing scheduled task: {} ({}) - Type: {:?}",
                        task_name_clone, task_id, task_type
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
            });

            let job = match job {
                Ok(j) => {
                    info!("✅ Job created successfully for task: {}", task_name);
                    j
                }
                Err(e) => {
                    error!("❌ Failed to create job for task {}: {}", task_name, e);
                    continue;
                }
            };

            match new_scheduler.add(job).await {
                Ok(job_id) => {
                    info!("✅ Scheduled task: {} ({})", task.name, job_id);
                    // Store the scheduler job ID in the task
                    SCHEDULED_TASKS_CACHE
                        .update_task(&task.id, |t| {
                            t.scheduler_job_id = Some(job_id.to_string());
                        })
                        .await
                        .ok();
                }
                Err(e) => {
                    error!("❌ Failed to schedule task {}: {}", task.name, e);
                }
            }
        }

        // 5. Start the new scheduler
        info!("▶️  Starting the scheduler...");
        new_scheduler
            .start()
            .await
            .map_err(|e| format!("Failed to start new scheduler: {}", e))?;

        // 6. Store the new scheduler in the RwLock
        *scheduler_guard = Some(new_scheduler);

        Ok(())
    }
}

/// Convert a local time cron expression to UTC
/// Takes a 5-field cron expression in local time and converts it to UTC
pub fn convert_local_cron_to_utc(local_cron: &str) -> Result<String, String> {
    // Parse the cron expression
    let parts: Vec<&str> = local_cron.trim().split_whitespace().collect();
    if parts.len() != 5 {
        return Err(
            "Cron expression must have 5 fields (minute hour day month weekday)".to_string(),
        );
    }

    // Get local timezone offset in hours
    let now = Local::now();
    let offset_seconds = now.offset().local_minus_utc();
    let offset_hours = offset_seconds / 3600;

    // Parse minute and hour
    let minute = parts[0];
    let hour = parts[1];
    let day = parts[2];
    let month = parts[3];
    let weekday = parts[4];

    // If hour or minute are wildcards/ranges, we can't easily convert - just return as-is with warning
    if hour.contains('*') || hour.contains('/') || hour.contains('-') || hour.contains(',') {
        warn!(
            "⚠️  Cron expression contains wildcards/ranges in hour field - conversion may not be accurate"
        );
        return Ok(local_cron.to_string());
    }

    // Parse the hour value
    let hour_val: i32 = hour
        .parse()
        .map_err(|_| format!("Invalid hour value: {}", hour))?;

    // Calculate UTC hour
    let mut utc_hour = hour_val - offset_hours;
    let mut day_adjustment = 0;

    // Handle day rollover
    if utc_hour < 0 {
        utc_hour += 24;
        day_adjustment = -1;
    } else if utc_hour >= 24 {
        utc_hour -= 24;
        day_adjustment = 1;
    }

    // Build the UTC cron expression
    let utc_cron = if day_adjustment != 0 && !day.contains('*') {
        // If specific day and we crossed day boundary, warn the user
        warn!("⚠️  Cron conversion crossed day boundary - day field may need manual adjustment");
        format!("{} {} {} {} {}", minute, utc_hour, day, month, weekday)
    } else {
        format!("{} {} {} {} {}", minute, utc_hour, day, month, weekday)
    };

    info!(
        "🌐 Converted cron from local to UTC: '{}' -> '{}' (offset: {} hours)",
        local_cron, utc_cron, offset_hours
    );

    Ok(utc_cron)
}

/// Validate a cron expression
pub fn validate_cron_expression(cron_expr: &str) -> Result<(), String> {
    croner::Cron::new(cron_expr)
        .parse()
        .map_err(|e| format!("Invalid cron expression: {}", e))?;
    Ok(())
}

/// Get next run time for a cron expression
/// Cron expressions are in local time, this returns the next run time in UTC
pub fn get_next_run(cron_expr: &str) -> Result<chrono::DateTime<Utc>, String> {
    // Convert local time cron to UTC first
    let utc_cron = convert_local_cron_to_utc(cron_expr)?;

    let cron = croner::Cron::new(&utc_cron)
        .parse()
        .map_err(|e| format!("Invalid cron expression: {}", e))?;

    // Now calculate based on UTC time since we converted the cron expression to UTC
    let next_utc = cron
        .find_next_occurrence(&Utc::now(), false)
        .map_err(|e| format!("Failed to calculate next run: {}", e))?;

    Ok(next_utc)
}

/// Get human-readable description of cron expression
pub fn get_cron_description(cron_expr: &str) -> Result<String, String> {
    // Using croner's cron parsing
    let cron = croner::Cron::new(cron_expr)
        .parse()
        .map_err(|e| format!("Invalid cron expression: {}", e))?;

    // Generate a simple description based on the pattern
    Ok(cron.pattern.to_string())
}

/// Execute a scheduled task
async fn execute_scheduled_task(task_id: &str, app_handle: &AppHandle) -> Result<(), String> {
    // Get the task from cache
    let task = SCHEDULED_TASKS_CACHE
        .get_task(task_id)
        .await
        .ok_or("Task not found")?;

    // Check if task can run
    if !task.can_run() {
        return Err(format!("Task cannot run (status: {:?})", task.status));
    }

    // Mark task as starting execution
    SCHEDULED_TASKS_CACHE
        .update_task(task_id, |t| {
            t.mark_starting();
        })
        .await?;

    // Execute based on task type
    let result = match task.task_type {
        TaskType::Copy => execute_copy_task(&task, app_handle).await,
        TaskType::Sync => execute_sync_task(&task, app_handle).await,
        TaskType::Move => execute_move_task(&task, app_handle).await,
        TaskType::Bisync => execute_bisync_task(&task, app_handle).await,
    };

    // Update task based on result
    match result {
        Ok(job_id) => {
            // First mark as running with the job ID
            if let Some(rclone_job_id) = job_id {
                SCHEDULED_TASKS_CACHE
                    .update_task(task_id, |t| {
                        t.mark_running(rclone_job_id);
                    })
                    .await
                    .ok(); // Ignore errors, will be marked success anyway
            }

            // Then mark as success (which sets status back to Enabled)
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
    use crate::rclone::commands::sync::{CopyParams, start_copy};
    use tauri::State;

    let state: State<crate::utils::types::all_types::RcloneState> = app_handle.state();

    // Extract parameters from task args
    let params = CopyParams {
        remote_name: task
            .args
            .get("remoteName")
            .and_then(|v| v.as_str())
            .unwrap_or("scheduled")
            .to_string(),
        source: task
            .args
            .get("source")
            .and_then(|v| v.as_str())
            .ok_or("source not found in task args")?
            .to_string(),
        dest: task
            .args
            .get("dest")
            .and_then(|v| v.as_str())
            .ok_or("dest not found in task args")?
            .to_string(),
        create_empty_src_dirs: task
            .args
            .get("createEmptySrcDirs")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        copy_options: task
            .args
            .get("copyOptions")
            .and_then(|v| v.as_object())
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
        filter_options: task
            .args
            .get("filterOptions")
            .and_then(|v| v.as_object())
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
        backend_options: task
            .args
            .get("backendOptions")
            .and_then(|v| v.as_object())
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
    };

    let result = start_copy(app_handle.clone(), params, state).await?;

    Ok(Some(result))
}

/// Execute sync task
async fn execute_sync_task(
    task: &ScheduledTask,
    app_handle: &AppHandle,
) -> Result<Option<u64>, String> {
    use crate::rclone::commands::sync::{SyncParams, start_sync};
    use tauri::State;

    let state: State<crate::utils::types::all_types::RcloneState> = app_handle.state();

    // Extract parameters from task args
    let params = SyncParams {
        remote_name: task
            .args
            .get("remoteName")
            .and_then(|v| v.as_str())
            .unwrap_or("scheduled")
            .to_string(),
        source: task
            .args
            .get("source")
            .and_then(|v| v.as_str())
            .ok_or("source not found in task args")?
            .to_string(),
        dest: task
            .args
            .get("dest")
            .and_then(|v| v.as_str())
            .ok_or("dest not found in task args")?
            .to_string(),
        create_empty_src_dirs: task
            .args
            .get("createEmptySrcDirs")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        sync_options: task
            .args
            .get("syncOptions")
            .and_then(|v| v.as_object())
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
        filter_options: task
            .args
            .get("filterOptions")
            .and_then(|v| v.as_object())
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
        backend_options: task
            .args
            .get("backendOptions")
            .and_then(|v| v.as_object())
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
    };

    let result = start_sync(app_handle.clone(), params, state).await?;

    Ok(Some(result))
}

/// Execute move task
async fn execute_move_task(
    task: &ScheduledTask,
    app_handle: &AppHandle,
) -> Result<Option<u64>, String> {
    use crate::rclone::commands::sync::{MoveParams, start_move};
    use tauri::State;

    let state: State<crate::utils::types::all_types::RcloneState> = app_handle.state();

    // Extract parameters from task args
    let params = MoveParams {
        remote_name: task
            .args
            .get("remoteName")
            .and_then(|v| v.as_str())
            .unwrap_or("scheduled")
            .to_string(),
        source: task
            .args
            .get("source")
            .and_then(|v| v.as_str())
            .ok_or("source not found in task args")?
            .to_string(),
        dest: task
            .args
            .get("dest")
            .and_then(|v| v.as_str())
            .ok_or("dest not found in task args")?
            .to_string(),
        create_empty_src_dirs: task
            .args
            .get("createEmptySrcDirs")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        delete_empty_src_dirs: task
            .args
            .get("deleteEmptySrcDirs")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        move_options: task
            .args
            .get("moveOptions")
            .and_then(|v| v.as_object())
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
        filter_options: task
            .args
            .get("filterOptions")
            .and_then(|v| v.as_object())
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
        backend_options: task
            .args
            .get("backendOptions")
            .and_then(|v| v.as_object())
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
    };

    let result = start_move(app_handle.clone(), params, state).await?;

    Ok(Some(result))
}

/// Execute bisync task
async fn execute_bisync_task(
    task: &ScheduledTask,
    app_handle: &AppHandle,
) -> Result<Option<u64>, String> {
    use crate::rclone::commands::sync::{BisyncParams, start_bisync};
    use tauri::State;

    let state: State<crate::utils::types::all_types::RcloneState> = app_handle.state();

    // Extract parameters from task args
    let params = BisyncParams {
        remote_name: task
            .args
            .get("remoteName")
            .and_then(|v| v.as_str())
            .unwrap_or("scheduled")
            .to_string(),
        source: task
            .args
            .get("source")
            .and_then(|v| v.as_str())
            .ok_or("source not found in task args")?
            .to_string(),
        dest: task
            .args
            .get("dest")
            .and_then(|v| v.as_str())
            .ok_or("dest not found in task args")?
            .to_string(),
        dry_run: task.args.get("dryRun").and_then(|v| v.as_bool()),
        resync: task
            .args
            .get("resync")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        check_access: task.args.get("checkAccess").and_then(|v| v.as_bool()),
        check_filename: task
            .args
            .get("checkFilename")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        max_delete: task.args.get("maxDelete").and_then(|v| v.as_i64()),
        force: task.args.get("force").and_then(|v| v.as_bool()),
        check_sync: task
            .args
            .get("checkSync")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        create_empty_src_dirs: task
            .args
            .get("createEmptySrcDirs")
            .and_then(|v| v.as_bool()),
        remove_empty_dirs: task.args.get("removeEmptyDirs").and_then(|v| v.as_bool()),
        filters_file: task
            .args
            .get("filtersFile")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        ignore_listing_checksum: task
            .args
            .get("ignoreListingChecksum")
            .and_then(|v| v.as_bool()),
        resilient: task.args.get("resilient").and_then(|v| v.as_bool()),
        workdir: task
            .args
            .get("workdir")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        backupdir1: task
            .args
            .get("backupdir1")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        backupdir2: task
            .args
            .get("backupdir2")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        no_cleanup: task.args.get("noCleanup").and_then(|v| v.as_bool()),
        bisync_options: task
            .args
            .get("bisyncOptions")
            .and_then(|v| v.as_object())
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
        filter_options: task
            .args
            .get("filterOptions")
            .and_then(|v| v.as_object())
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
        backend_options: task
            .args
            .get("backendOptions")
            .and_then(|v| v.as_object())
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
    };

    let result = start_bisync(app_handle.clone(), params, state).await?;

    Ok(Some(result))
}
