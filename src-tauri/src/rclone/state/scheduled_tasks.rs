use crate::{
    core::scheduler::engine::{CronScheduler, get_next_run},
    rclone::commands::sync::{BisyncParams, CopyParams, MoveParams, SyncParams},
    utils::types::scheduled_task::{ScheduledTask, ScheduledTaskStats, TaskStatus, TaskType},
};
use log::{debug, info, warn};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use tauri::State;
use tokio::sync::RwLock;

// --- Make struct public ---
pub struct ScheduledTasksCache {
    tasks: RwLock<HashMap<String, ScheduledTask>>,
}

impl ScheduledTasksCache {
    pub fn new() -> Self {
        Self {
            tasks: RwLock::new(HashMap::new()),
        }
    }

    /// Load tasks from remote configs, preserving existing task states
    pub async fn load_from_remote_configs(
        &self,
        all_settings: &Value,
        scheduler: State<'_, CronScheduler>, // Pass in scheduler state
    ) -> Result<usize, String> {
        let settings_obj = all_settings
            .as_object()
            .ok_or("Settings is not an object")?;

        let mut loaded_count = 0;
        let mut new_task_ids = HashSet::new();
        let mut tasks_to_update = Vec::new();

        // Phase 1: Collect all tasks from configs
        for (remote_name, remote_settings) in settings_obj {
            let operation_types = [
                ("copyConfig", TaskType::Copy),
                ("syncConfig", TaskType::Sync),
                ("moveConfig", TaskType::Move),
                ("bisyncConfig", TaskType::Bisync),
            ];

            for (config_key, task_type) in operation_types {
                match self
                    .parse_task_from_config(remote_name, &task_type, remote_settings)
                    .await
                {
                    Ok(Some(task_from_config)) => {
                        let task_id = task_from_config.id.clone();
                        new_task_ids.insert(task_id.clone());
                        tasks_to_update.push((task_id, task_from_config));
                    }
                    Ok(None) => {
                        // Task is disabled or invalid - no action needed
                        debug!(
                            "Skipping {} task for {}: not enabled or invalid",
                            config_key, remote_name
                        );
                    }
                    Err(e) => {
                        warn!(
                            "Failed to parse {} task for {}: {}",
                            config_key, remote_name, e
                        );
                    }
                }
            }
        }

        // Phase 2: Apply updates (minimizes lock time)
        for (task_id, task_from_config) in tasks_to_update {
            if let Some(existing_task) = self.get_task(&task_id).await {
                // Check if configuration changed
                let config_changed = existing_task.cron_expression
                    != task_from_config.cron_expression
                    || existing_task.args != task_from_config.args
                    || existing_task.name != task_from_config.name
                    || existing_task.task_type != task_from_config.task_type;

                if config_changed {
                    // Preserve runtime state
                    self.update_task(&task_id, |t| {
                        t.name = task_from_config.name.clone();
                        t.cron_expression = task_from_config.cron_expression.clone();
                        t.args = task_from_config.args.clone();
                        t.task_type = task_from_config.task_type.clone();
                        t.next_run = task_from_config.next_run;
                        // Preserve: status, scheduler_job_id, created_at, last_run,
                        // last_error, current_job_id, run_count, success_count, failure_count
                    })
                    .await?;

                    info!(
                        "✏️ Updated existing task config: {} ({})",
                        existing_task.name, task_id
                    );
                } else {
                    debug!("Task {} unchanged, skipping", task_id);
                }
            } else {
                // New task - add it
                self.add_task(task_from_config.clone()).await?;
                loaded_count += 1;
                info!("➕ Added new task: {} ({})", task_from_config.name, task_id);
            }
        }

        // Phase 3: Remove obsolete tasks
        let all_tasks = self.get_all_tasks().await;
        for task in all_tasks {
            if !new_task_ids.contains(&task.id) {
                info!(
                    "🗑️ Removing task no longer in configs: {} ({})",
                    task.name, task.id
                );
                self.remove_task(&task.id, scheduler.clone()).await?;
            }
        }

        Ok(loaded_count)
    }

    /// Remove a task and unschedule it
    pub async fn remove_task(
        &self,
        task_id: &str,
        scheduler: State<'_, CronScheduler>, // Pass in scheduler
    ) -> Result<(), String> {
        let task = self
            .get_task(task_id)
            .await
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        // Unschedule if it has a scheduler job ID
        if let Some(job_id_str) = &task.scheduler_job_id
            && let Ok(job_id) = uuid::Uuid::parse_str(job_id_str)
            && let Err(e) = scheduler.unschedule_task(job_id).await
        {
            warn!("Failed to unschedule task {}: {}", task_id, e);
        }

        // Remove from cache
        let mut tasks = self.tasks.write().await;
        tasks.remove(task_id);

        info!("🗑️ Removed task: {}", task_id);
        Ok(())
    }

    /// Remove all tasks for a specific remote
    pub async fn remove_tasks_for_remote(
        &self,
        remote_name: &str,
        scheduler: State<'_, CronScheduler>, // Pass in scheduler
    ) -> Result<Vec<String>, String> {
        let tasks = self.get_all_tasks().await;
        let mut removed_ids = Vec::new();

        for task in tasks {
            // Check if task ID starts with the remote name (format: "remotename-operation")
            if task.id.starts_with(&format!("{}-", remote_name)) {
                info!(
                    "🗑️ Removing task '{}' associated with remote '{}'",
                    task.name, remote_name
                );
                self.remove_task(&task.id, scheduler.clone()).await?;
                removed_ids.push(task.id);
            }
        }

        Ok(removed_ids)
    }

    /// Add or update tasks for a specific remote
    pub async fn add_or_update_task_for_remote(
        &self,
        remote_name: &str,
        remote_settings: &Value,
        scheduler: State<'_, CronScheduler>, // Pass in scheduler
    ) -> Result<(), String> {
        let operation_types = [
            TaskType::Copy,
            TaskType::Sync,
            TaskType::Move,
            TaskType::Bisync,
        ];

        for task_type in operation_types {
            match self
                .parse_task_from_config(remote_name, &task_type, remote_settings)
                .await
            {
                Ok(Some(task_from_config)) => {
                    let task_id = task_from_config.id.clone();

                    // Check if we already have this task
                    if let Some(existing_task) = self.get_task(&task_id).await {
                        // Task exists - check if configuration changed
                        let config_changed = existing_task.cron_expression
                            != task_from_config.cron_expression
                            || existing_task.args != task_from_config.args
                            || existing_task.name != task_from_config.name
                            || existing_task.task_type != task_from_config.task_type;

                        if config_changed {
                            // Update task but preserve status, scheduler_job_id, and stats
                            self.update_task(&task_id, |t| {
                                t.name = task_from_config.name.clone();
                                t.cron_expression = task_from_config.cron_expression.clone();
                                t.args = task_from_config.args.clone();
                                t.task_type = task_from_config.task_type.clone();
                                t.next_run = task_from_config.next_run;
                                // PRESERVE: status, scheduler_job_id, created_at, last_run,
                                // last_error, current_job_id, run_count, success_count, failure_count
                            })
                            .await?;

                            info!(
                                "✏️ Updated existing task config: {} ({})",
                                existing_task.name, task_id
                            );
                        } else {
                            debug!("Task {} unchanged, skipping", task_id);
                        }
                    } else {
                        // New task - add it
                        self.add_task(task_from_config.clone()).await?;
                        info!("➕ Added new task: {} ({})", task_from_config.name, task_id);
                    }
                }
                Ok(None) => {
                    // Task is disabled or invalid, check if we need to remove it
                    let task_id = format!("{}-{}", remote_name, task_type.as_str());
                    if self.get_task(&task_id).await.is_some() {
                        info!("🗑️ Removing disabled/invalid task: {}", task_id);
                        self.remove_task(&task_id, scheduler.clone()).await?;
                    }
                }
                Err(e) => {
                    warn!(
                        "Failed to parse {} task for {}: {}",
                        task_type.as_str(),
                        remote_name,
                        e
                    );
                }
            }
        }

        Ok(())
    }

    /// Parse a task from config using the unified Params from_settings method
    async fn parse_task_from_config(
        &self,
        remote_name: &str,
        task_type: &TaskType,
        remote_settings: &Value,
    ) -> Result<Option<ScheduledTask>, String> {
        let task_id = format!("{}-{}", remote_name, task_type.as_str());

        // Get the config key for this task type
        let config_key = match task_type {
            TaskType::Copy => "copyConfig",
            TaskType::Sync => "syncConfig",
            TaskType::Move => "moveConfig",
            TaskType::Bisync => "bisyncConfig",
        };

        // Check if cron is enabled
        let config = remote_settings
            .get(config_key)
            .ok_or_else(|| format!("No {} found in settings", config_key))?;

        let cron_enabled = config
            .get("cronEnabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let cron_expression = config
            .get("cronExpression")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());

        // If not enabled or no cron expression, return None
        if !cron_enabled || cron_expression.is_none() {
            return Ok(None);
        }

        let cron = cron_expression.unwrap().to_string();

        // Use the Params from_settings method to parse and validate
        let args = match task_type {
            TaskType::Sync => {
                let params = SyncParams::from_settings(remote_name.to_string(), remote_settings)
                    .ok_or_else(|| format!("Invalid sync config for {}", remote_name))?;

                // Convert params to JSON args
                serde_json::to_value(params)
                    .map_err(|e| format!("Failed to serialize sync params: {}", e))?
            }
            TaskType::Copy => {
                let params = CopyParams::from_settings(remote_name.to_string(), remote_settings)
                    .ok_or_else(|| format!("Invalid copy config for {}", remote_name))?;

                serde_json::to_value(params)
                    .map_err(|e| format!("Failed to serialize copy params: {}", e))?
            }
            TaskType::Move => {
                let params = MoveParams::from_settings(remote_name.to_string(), remote_settings)
                    .ok_or_else(|| format!("Invalid move config for {}", remote_name))?;

                serde_json::to_value(params)
                    .map_err(|e| format!("Failed to serialize move params: {}", e))?
            }
            TaskType::Bisync => {
                let params = BisyncParams::from_settings(remote_name.to_string(), remote_settings)
                    .ok_or_else(|| format!("Invalid bisync config for {}", remote_name))?;

                serde_json::to_value(params)
                    .map_err(|e| format!("Failed to serialize bisync params: {}", e))?
            }
        };

        // Calculate next run
        let next_run = get_next_run(&cron).ok();

        // Create the task struct
        let task = ScheduledTask {
            id: task_id,
            name: format!("{} - {}", remote_name, task_type.as_str()),
            task_type: task_type.clone(),
            cron_expression: cron,
            status: TaskStatus::Enabled,
            args,
            created_at: chrono::Utc::now(),
            last_run: None,
            next_run,
            last_error: None,
            current_job_id: None,
            scheduler_job_id: None,
            run_count: 0,
            success_count: 0,
            failure_count: 0,
        };

        Ok(Some(task))
    }

    /// Add a new scheduled task (runtime only, not persisted)
    pub async fn add_task(&self, task: ScheduledTask) -> Result<ScheduledTask, String> {
        let task_id = task.id.clone();
        let mut tasks = self.tasks.write().await;

        if tasks.contains_key(&task_id) {
            return Err(format!("Task with ID {} already exists", task_id));
        }

        tasks.insert(task_id.clone(), task.clone());
        info!("✅ Added scheduled task: {} ({})", task.name, task.id);
        Ok(task)
    }

    /// Get a task by ID
    pub async fn get_task(&self, task_id: &str) -> Option<ScheduledTask> {
        let tasks = self.tasks.read().await;
        tasks.get(task_id).cloned()
    }

    /// Get all scheduled tasks
    pub async fn get_all_tasks(&self) -> Vec<ScheduledTask> {
        let tasks = self.tasks.read().await;
        tasks.values().cloned().collect()
    }

    /// Get a task by its current job ID
    pub async fn get_task_by_job_id(&self, job_id: u64) -> Option<ScheduledTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .find(|t| t.current_job_id == Some(job_id))
            .cloned()
    }

    /// Update an existing task (runtime only, not persisted)
    pub async fn update_task(
        &self,
        task_id: &str,
        update_fn: impl FnOnce(&mut ScheduledTask),
    ) -> Result<ScheduledTask, String> {
        let mut tasks = self.tasks.write().await;

        let task = tasks
            .get_mut(task_id)
            .ok_or(format!("Task with ID {} not found", task_id))?;

        update_fn(task);
        let updated_task = task.clone();

        debug!("🔄 Updated scheduled task: {}", task_id);
        Ok(updated_task)
    }

    /// Toggle task enabled/disabled status
    pub async fn toggle_task_status(&self, task_id: &str) -> Result<ScheduledTask, String> {
        self.update_task(task_id, |task| {
            let old_status = task.status.clone();
            task.status = match task.status {
                TaskStatus::Enabled => TaskStatus::Disabled,
                TaskStatus::Disabled | TaskStatus::Failed => TaskStatus::Enabled,
                TaskStatus::Running => TaskStatus::Stopping,
                TaskStatus::Stopping => TaskStatus::Running,
            };

            // If the task is being enabled, recalculate the next run time.
            if (old_status == TaskStatus::Disabled || old_status == TaskStatus::Failed)
                && task.status == TaskStatus::Enabled
            {
                task.next_run = get_next_run(&task.cron_expression).ok();
            }

            // If the task is being disabled, clear the next run time.
            if task.status == TaskStatus::Disabled {
                task.next_run = None;
            }
        })
        .await
    }

    /// Get statistics about scheduled tasks
    pub async fn get_stats(&self) -> ScheduledTaskStats {
        let tasks = self.tasks.read().await;

        let total_tasks = tasks.len();
        let enabled_tasks = tasks
            .values()
            .filter(|t| t.status == TaskStatus::Enabled)
            .count();
        let running_tasks = tasks
            .values()
            .filter(|t| t.status == TaskStatus::Running)
            .count();
        let failed_tasks = tasks
            .values()
            .filter(|t| t.status == TaskStatus::Failed)
            .count();

        let total_runs = tasks.values().map(|t| t.run_count).sum();
        let successful_runs = tasks.values().map(|t| t.success_count).sum();
        let failed_runs = tasks.values().map(|t| t.failure_count).sum();

        ScheduledTaskStats {
            total_tasks,
            enabled_tasks,
            running_tasks,
            failed_tasks,
            total_runs,
            successful_runs,
            failed_runs,
        }
    }

    /// Clear all tasks (use with caution!)
    pub async fn clear_all_tasks(&self) -> Result<(), String> {
        warn!("⚠️  Clearing all scheduled tasks!");
        let mut tasks = self.tasks.write().await;
        tasks.clear();
        Ok(())
    }
}

// Tauri commands
#[tauri::command]
pub async fn get_scheduled_tasks(
    cache: State<'_, ScheduledTasksCache>,
) -> Result<Vec<ScheduledTask>, String> {
    Ok(cache.get_all_tasks().await)
}

#[tauri::command]
pub async fn get_scheduled_task(
    cache: State<'_, ScheduledTasksCache>,
    task_id: String,
) -> Result<Option<ScheduledTask>, String> {
    Ok(cache.get_task(&task_id).await)
}

#[tauri::command]
pub async fn get_scheduled_tasks_stats(
    cache: State<'_, ScheduledTasksCache>,
) -> Result<ScheduledTaskStats, String> {
    Ok(cache.get_stats().await)
}

// Reload scheduled tasks from configs (Tauri command)
#[tauri::command]
pub async fn reload_scheduled_tasks_from_configs(
    cache: State<'_, ScheduledTasksCache>,
    scheduler: State<'_, CronScheduler>,
    all_settings: serde_json::Value,
) -> Result<usize, String> {
    info!("🔄 Reloading scheduled tasks from configs...");

    // Load tasks from configs (this preserves existing task states)
    let task_count = cache
        .load_from_remote_configs(&all_settings, scheduler.clone())
        .await?;

    info!("📅 Loaded/updated {} scheduled task(s)", task_count);

    // Reschedule all tasks in the scheduler
    scheduler.reload_tasks(cache).await?;

    Ok(task_count)
}

impl Default for ScheduledTasksCache {
    fn default() -> Self {
        Self::new()
    }
}
