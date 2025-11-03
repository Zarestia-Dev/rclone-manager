use crate::{
    core::scheduler::engine::get_next_run,
    utils::types::scheduled_task::{ScheduledTask, ScheduledTaskStats, TaskStatus},
};
use log::{debug, info, warn};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use tokio::sync::RwLock;

/// Global cache for scheduled tasks (in-memory only, loaded from remote configs)
pub static SCHEDULED_TASKS_CACHE: Lazy<ScheduledTasksCache> = Lazy::new(|| ScheduledTasksCache {
    tasks: RwLock::new(HashMap::new()),
});

pub struct ScheduledTasksCache {
    tasks: RwLock<HashMap<String, ScheduledTask>>,
}

impl ScheduledTasksCache {
    /// Load scheduled tasks from remote configs
    /// This should be called after rclone engine starts to extract tasks from configs
    pub async fn load_from_remote_configs(
        &self,
        remote_configs: &serde_json::Value,
    ) -> Result<usize, String> {
        info!("🔄 Loading scheduled tasks from remote configs...");

        let mut loaded_count = 0;
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
                .unwrap_or(serde_json::Value::Null);
            let backend_config = config_obj
                .get("backendConfig")
                .cloned()
                .unwrap_or(serde_json::Value::Null);

            // Check each operation type for cronExpression
            let operation_types = vec!["copyConfig", "syncConfig", "bisyncConfig", "moveConfig"];

            for op_type in operation_types {
                if let Some(op_config) = config_obj.get(op_type).and_then(|v| v.as_object()) {
                    // Check if autoStart is enabled and cronExpression exists
                    let auto_start = op_config
                        .get("autoStart")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);

                    let cron_expression = op_config
                        .get("cronExpression")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());

                    if auto_start && cron_expression.is_some() {
                        let cron = cron_expression.unwrap();

                        // Determine task type from operation type
                        use crate::utils::types::scheduled_task::TaskType;

                        let task_type = match op_type {
                            "copyConfig" => TaskType::Copy,
                            "syncConfig" => TaskType::Sync,
                            "bisyncConfig" => TaskType::Bisync,
                            "moveConfig" => TaskType::Move,
                            _ => continue,
                        };

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
                            continue;
                        }

                        // ==================================================================
                        // ⬇️ FIX: Build the args map with correct camelCase keys ⬇️
                        // ==================================================================
                        let mut args = serde_json::Map::new();
                        args.insert("remoteName".to_string(), serde_json::json!(remote_name));
                        args.insert("source".to_string(), serde_json::json!(source));
                        args.insert("dest".to_string(), serde_json::json!(dest));

                        // Add common configs (camelCase)
                        args.insert("filterOptions".to_string(), filter_config.clone());
                        args.insert("backendOptions".to_string(), backend_config.clone());

                        // Add operation-specific options and static fields
                        let operation_options = op_config
                            .get("options")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null);

                        match task_type {
                            TaskType::Copy => {
                                args.insert("copyOptions".to_string(), operation_options);
                                args.insert(
                                    "createEmptySrcDirs".to_string(), // Use camelCase
                                    op_config
                                        .get("createEmptySrcDirs")
                                        .cloned()
                                        .unwrap_or(serde_json::Value::Bool(false)),
                                );
                            }
                            TaskType::Sync => {
                                args.insert("syncOptions".to_string(), operation_options);
                                args.insert(
                                    "createEmptySrcDirs".to_string(), // Use camelCase
                                    op_config
                                        .get("createEmptySrcDirs")
                                        .cloned()
                                        .unwrap_or(serde_json::Value::Bool(false)),
                                );
                            }
                            TaskType::Move => {
                                args.insert("moveOptions".to_string(), operation_options);
                                args.insert(
                                    "createEmptySrcDirs".to_string(), // Use camelCase
                                    op_config
                                        .get("createEmptySrcDirs")
                                        .cloned()
                                        .unwrap_or(serde_json::Value::Bool(false)),
                                );
                                args.insert(
                                    "deleteEmptySrcDirs".to_string(), // Use camelCase
                                    op_config
                                        .get("deleteEmptySrcDirs")
                                        .cloned()
                                        .unwrap_or(serde_json::Value::Bool(false)),
                                );
                            }
                            TaskType::Bisync => {
                                args.insert("bisyncOptions".to_string(), operation_options);
                                // Map all bisync static fields from camelCase (config) to camelCase (args)
                                // (engine.rs expects camelCase for these too)
                                let bisync_fields_map = [
                                    ("dryRun", "dryRun"),
                                    ("resync", "resync"),
                                    ("checkAccess", "checkAccess"),
                                    ("checkFilename", "checkFilename"),
                                    ("maxDelete", "maxDelete"),
                                    ("force", "force"),
                                    ("checkSync", "checkSync"),
                                    ("createEmptySrcDirs", "createEmptySrcDirs"),
                                    ("removeEmptyDirs", "removeEmptyDirs"),
                                    ("filtersFile", "filtersFile"),
                                    ("ignoreListingChecksum", "ignoreListingChecksum"),
                                    ("resilient", "resilient"),
                                    ("workdir", "workdir"),
                                    ("backupdir1", "backupdir1"),
                                    ("backupdir2", "backupdir2"),
                                    ("noCleanup", "noCleanup"),
                                ];
                                for (config_key, arg_key) in bisync_fields_map.iter() {
                                    if let Some(value) = op_config.get(*config_key) {
                                        args.insert(arg_key.to_string(), value.clone());
                                    }
                                }
                            }
                        }

                        // Create task ID (hash of remote name + task type + paths)
                        let task_id = format!("{}-{}", remote_name, task_type.as_str());

                        // Calculate next run
                        let next_run = get_next_run(&cron).ok();

                        // Check if task already exists
                        let mut tasks = self.tasks.write().await;

                        if let Some(task) = tasks.get_mut(&task_id) {
                            // Update existing task
                            debug!(
                                "ℹ️  Updating existing task: {} ({})",
                                remote_name,
                                task_type.as_str()
                            );

                            if task.cron_expression != cron {
                                info!(
                                    "🔄 Updating cron for {}: {} -> {}",
                                    task.name, task.cron_expression, cron
                                );
                            }
                            task.cron_expression = cron;
                            task.next_run = next_run;
                            task.args = serde_json::Value::Object(args); // <-- This now has the correct args

                            if task.status == TaskStatus::Failed {
                                task.status = TaskStatus::Enabled;
                            }
                        } else {
                            // Create new task
                            let task = ScheduledTask {
                                id: task_id.clone(),
                                name: format!("{} - {}", remote_name, task_type.as_str()),
                                task_type: task_type.clone(),
                                cron_expression: cron.clone(),
                                status: TaskStatus::Enabled,
                                args: serde_json::Value::Object(args), // <-- This has the correct args
                                created_at: chrono::Utc::now(),
                                last_run: None,
                                next_run,
                                last_error: None,
                                current_job_id: None,
                                run_count: 0,
                                success_count: 0,
                                failure_count: 0,
                            };

                            tasks.insert(task_id.clone(), task);
                            loaded_count += 1;

                            info!(
                                "✅ Loaded scheduled task: {} ({}) - {}",
                                remote_name,
                                task_type.as_str(),
                                cron
                            );
                        }
                    }
                }
            }
        }

        info!(
            "✅ Loaded {} scheduled tasks from remote configs",
            loaded_count
        );

        Ok(loaded_count)
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

    /// Get tasks by status
    pub async fn get_tasks_by_status(&self, status: TaskStatus) -> Vec<ScheduledTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .filter(|task| task.status == status)
            .cloned()
            .collect()
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
