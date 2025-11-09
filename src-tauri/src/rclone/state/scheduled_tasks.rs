use crate::{
    core::scheduler::engine::get_next_run,
    utils::types::scheduled_task::{ScheduledTask, ScheduledTaskStats, TaskStatus, TaskType},
};
use log::{debug, info, warn};
use once_cell::sync::Lazy;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use tokio::sync::RwLock;

/// Global cache for scheduled tasks (in-memory only, loaded from remote configs)
pub static SCHEDULED_TASKS_CACHE: Lazy<ScheduledTasksCache> = Lazy::new(|| ScheduledTasksCache {
    tasks: RwLock::new(HashMap::new()),
});

pub struct ScheduledTasksCache {
    tasks: RwLock<HashMap<String, ScheduledTask>>,
}

impl ScheduledTasksCache {
    /// Load scheduled tasks from remote configs.
    /// This is the main entry point, now refactored to be a coordinator.
    pub async fn load_from_remote_configs(
        &self,
        remote_configs: &serde_json::Value,
    ) -> Result<usize, String> {
        info!("🔄 Loading scheduled tasks from remote configs...");

        let mut loaded_count = 0;
        let mut active_task_ids = HashSet::new(); // To track which tasks are still in config

        let configs = remote_configs
            .as_object()
            .ok_or("Remote configs must be an object")?;

        for (remote_name, config) in configs.iter() {
            let config_obj = match config.as_object() {
                Some(obj) => obj,
                None => continue,
            };

            // Get common configs for this remote
            let filter_config = config_obj
                .get("filterConfig")
                .cloned()
                .unwrap_or(Value::Null);
            let backend_config = config_obj
                .get("backendConfig")
                .cloned()
                .unwrap_or(Value::Null);

            let operation_types = vec!["copyConfig", "syncConfig", "bisyncConfig", "moveConfig"];

            for op_type in operation_types {
                if let Some(op_config) = config_obj.get(op_type).and_then(|v| v.as_object()) {
                    // Call the helper to parse this specific operation
                    match self
                        .parse_task_from_config(
                            remote_name,
                            op_type,
                            op_config,
                            &filter_config,
                            &backend_config,
                        )
                        .await
                    {
                        Ok(Some(task)) => {
                            // Task is valid and enabled, add its ID to the active set
                            active_task_ids.insert(task.id.clone());
                            let mut tasks = self.tasks.write().await;

                            // Update existing task or insert new one
                            if let Some(existing_task) = tasks.get_mut(&task.id) {
                                debug!(
                                    "ℹ️  Updating existing task: {} ({})",
                                    task.name,
                                    task.task_type.as_str()
                                );
                                if existing_task.cron_expression != task.cron_expression {
                                    info!(
                                        "🔄 Updating cron for {}: {} -> {}",
                                        task.name,
                                        existing_task.cron_expression,
                                        task.cron_expression
                                    );
                                }
                                existing_task.cron_expression = task.cron_expression;
                                existing_task.next_run = task.next_run;
                                existing_task.args = task.args;
                                if existing_task.status == TaskStatus::Failed {
                                    existing_task.status = TaskStatus::Enabled;
                                }
                            } else {
                                info!(
                                    "✅ Loaded scheduled task: {} ({}) - {}",
                                    task.name,
                                    task.task_type.as_str(),
                                    task.cron_expression
                                );
                                tasks.insert(task.id.clone(), task);
                                loaded_count += 1;
                            }
                        }
                        Ok(None) => {
                            // Task is disabled, invalid, or has no cron.
                            // We do nothing, and it won't be in `active_task_ids`.
                        }
                        Err(e) => {
                            warn!("⚠️  Failed to parse task for remote {}: {}", remote_name, e);
                        }
                    }
                }
            }
        }

        // --- Pruning Phase ---
        // Remove any tasks from the cache that are no longer in the config
        let mut tasks = self.tasks.write().await;
        let cached_task_ids: Vec<String> = tasks.keys().cloned().collect();
        for task_id in cached_task_ids {
            if !active_task_ids.contains(&task_id) {
                if let Some(removed_task) = tasks.remove(&task_id) {
                    info!(
                        "🗑️  Removed stale/disabled task from cache: {} ({})",
                        removed_task.name, task_id
                    );
                }
            }
        }

        info!(
            "✅ Loaded {} new scheduled tasks from remote configs",
            loaded_count
        );
        Ok(loaded_count)
    }

    /// **NEW HELPER:** Parses a single operation config into a ScheduledTask.
    async fn parse_task_from_config(
        &self,
        remote_name: &str,
        op_type_str: &str,
        op_config: &serde_json::Map<String, Value>,
        filter_config: &Value,
        backend_config: &Value,
    ) -> Result<Option<ScheduledTask>, String> {
        let task_type = match op_type_str {
            "copyConfig" => TaskType::Copy,
            "syncConfig" => TaskType::Sync,
            "bisyncConfig" => TaskType::Bisync,
            "moveConfig" => TaskType::Move,
            _ => return Err(format!("Unknown operation type: {}", op_type_str)),
        };

        let task_id = format!("{}-{}", remote_name, task_type.as_str());

        // Check if cron is enabled and exists
        let cron_enabled = op_config
            .get("cronEnabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let cron_expression = op_config.get("cronExpression").and_then(|v| v.as_str());

        if !cron_enabled || cron_expression.is_none() || cron_expression.unwrap().is_empty() {
            return Ok(None); // Task is disabled or has no cron, so we return None
        }
        let cron = cron_expression.unwrap().to_string();

        // Extract paths
        let source = op_config
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let dest = op_config
            .get("dest")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if source.is_empty() || dest.is_empty() {
            debug!(
                "⚠️ Skipping {} task for {}: missing source or dest",
                task_type.as_str(),
                remote_name
            );
            return Ok(None); // Invalid task
        }

        // Build the arguments payload
        let args = self.build_task_args(
            remote_name,
            &source,
            &dest,
            &task_type,
            op_config,
            filter_config,
            backend_config,
        );

        // Calculate next run
        let next_run = get_next_run(&cron).ok();

        // Create the task struct
        let task = ScheduledTask {
            id: task_id,
            name: format!("{} - {}", remote_name, task_type.as_str()),
            task_type: task_type.clone(),
            cron_expression: cron,
            status: TaskStatus::Enabled, // Will be updated if it already exists
            args: Value::Object(args),
            created_at: chrono::Utc::now(), // Will be updated if it already exists
            last_run: None,                 // Will be updated if it already exists
            next_run,
            last_error: None,
            current_job_id: None,
            scheduler_job_id: None,
            run_count: 0,     // Will be updated if it already exists
            success_count: 0, // Will be updated if it already exists
            failure_count: 0, // Will be updated if it already exists
        };

        Ok(Some(task))
    }

    /// **NEW HELPER:** Builds the `args` JSON map for a specific task.
    fn build_task_args(
        &self,
        remote_name: &str,
        source: &str,
        dest: &str,
        task_type: &TaskType,
        op_config: &serde_json::Map<String, Value>,
        filter_config: &Value,
        backend_config: &Value,
    ) -> serde_json::Map<String, Value> {
        let mut args = serde_json::Map::new();

        // Insert common fields (NOW IN SNAKE_CASE)
        args.insert("remote_name".to_string(), json!(remote_name));
        args.insert("source".to_string(), json!(source));
        args.insert("dest".to_string(), json!(dest));
        args.insert("filter_options".to_string(), filter_config.clone());
        args.insert("backend_options".to_string(), backend_config.clone());

        let operation_options = op_config.get("options").cloned().unwrap_or(Value::Null);

        // Insert task-specific fields (NOW IN SNAKE_CASE)
        match task_type {
            TaskType::Copy => {
                args.insert("copy_options".to_string(), operation_options);
            }
            TaskType::Sync => {
                args.insert("sync_options".to_string(), operation_options);
            }
            TaskType::Move => {
                args.insert("move_options".to_string(), operation_options);
            }
            TaskType::Bisync => {
                args.insert("bisync_options".to_string(), operation_options);
                // Map all bisync static fields
                let bisync_fields = [
                    "dryRun",
                    "resync",
                    "checkAccess",
                    "checkFilename",
                    "maxDelete",
                    "force",
                    "checkSync",
                    "createEmptySrcDirs",
                    "removeEmptyDirs",
                    "filtersFile",
                    "ignoreListingChecksum",
                    "resilient",
                    "workdir",
                    "backupdir1",
                    "backupdir2",
                    "noCleanup",
                ];
                for field in bisync_fields.iter() {
                    if let Some(value) = op_config.get(*field) {
                        // Bisync is special, rclone POST args are camelCase
                        // but our struct expects snake_case for consistency
                        // We will map them manually.
                        let snake_case_field = match *field {
                            "dryRun" => "dry_run",
                            "checkAccess" => "check_access",
                            "checkFilename" => "check_filename",
                            "maxDelete" => "max_delete",
                            "checkSync" => "check_sync",
                            "createEmptySrcDirs" => "create_empty_src_dirs",
                            "removeEmptyDirs" => "remove_empty_dirs",
                            "filtersFile" => "filters_file",
                            "ignoreListingChecksum" => "ignore_listing_checksum",
                            "backupdir1" => "backupdir1",
                            "backupdir2" => "backupdir2",
                            "noCleanup" => "no_cleanup",
                            _ => *field, // for resync, force, resilient, workdir
                        };
                        args.insert(snake_case_field.to_string(), value.clone());
                    }
                }
            }
        }

        // Add fields common to copy/sync/move (NOW IN SNAKE_CASE)
        if matches!(task_type, TaskType::Copy | TaskType::Sync | TaskType::Move) {
            args.insert(
                "create_empty_src_dirs".to_string(),
                op_config
                    .get("createEmptySrcDirs")
                    .cloned()
                    .unwrap_or(Value::Bool(false)),
            );
        }

        // Add fields specific to move (NOW IN SNAKE_CASE)
        if matches!(task_type, TaskType::Move) {
            args.insert(
                "delete_empty_src_dirs".to_string(),
                op_config
                    .get("deleteEmptySrcDirs")
                    .cloned()
                    .unwrap_or(Value::Bool(false)),
            );
        }

        args
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

    /// Remove a scheduled task (runtime only, not persisted)
    pub async fn remove_task(&self, task_id: &str) -> Result<ScheduledTask, String> {
        let mut tasks = self.tasks.write().await;

        let task = tasks
            .remove(task_id)
            .ok_or(format!("Task with ID {} not found", task_id))?;

        info!("🗑️  Removed scheduled task: {} ({})", task.name, task.id);
        Ok(task)
    }

    /// Toggle task enabled/disabled status
    pub async fn toggle_task_status(&self, task_id: &str) -> Result<ScheduledTask, String> {
        self.update_task(task_id, |task| {
            task.status = match task.status {
                TaskStatus::Enabled => TaskStatus::Disabled,
                TaskStatus::Disabled | TaskStatus::Failed => TaskStatus::Enabled,
                TaskStatus::Running => task.status.clone(), // Don't change if running
            };
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
pub async fn get_scheduled_tasks() -> Result<Vec<ScheduledTask>, String> {
    Ok(SCHEDULED_TASKS_CACHE.get_all_tasks().await)
}

#[tauri::command]
pub async fn get_scheduled_task(task_id: String) -> Result<Option<ScheduledTask>, String> {
    Ok(SCHEDULED_TASKS_CACHE.get_task(&task_id).await)
}

#[tauri::command]
pub async fn get_scheduled_tasks_stats() -> Result<ScheduledTaskStats, String> {
    Ok(SCHEDULED_TASKS_CACHE.get_stats().await)
}

#[tauri::command]
pub async fn reload_scheduled_tasks_from_configs(
    remote_configs: serde_json::Value,
) -> Result<usize, String> {
    SCHEDULED_TASKS_CACHE
        .load_from_remote_configs(&remote_configs)
        .await
}
