use crate::{
    core::scheduler::engine::{CronScheduler, get_next_run},
    utils::types::{
        remotes::ProfileParams,
        scheduled_task::{ScheduledTask, ScheduledTaskStats, TaskStatus, TaskType},
    },
};
use log::info;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::RwLock;

use crate::utils::types::events::SCHEDULED_TASKS_CACHE_CHANGED;

// ============================================================================
// CONFIGURATION STRUCTS
// ============================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteConfig {
    copy_configs: Option<HashMap<String, ProfileConfig>>,
    sync_configs: Option<HashMap<String, ProfileConfig>>,
    move_configs: Option<HashMap<String, ProfileConfig>>,
    bisync_configs: Option<HashMap<String, ProfileConfig>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileConfig {
    cron_enabled: Option<bool>,
    cron_expression: Option<String>,
    source: Option<String>,
    dest: Option<String>,
}

// ============================================================================
// SCHEDULED TASK CACHE
// ============================================================================

pub struct ScheduledTasksCache {
    tasks: RwLock<HashMap<String, ScheduledTask>>,
}

impl ScheduledTasksCache {
    pub fn new() -> Self {
        Self {
            tasks: RwLock::new(HashMap::new()),
        }
    }

    pub fn generate_task_id(
        backend_name: &str,
        remote_name: &str,
        task_type: &TaskType,
        profile_name: &str,
    ) -> String {
        format!(
            "{}:{}-{}-{}",
            backend_name,
            remote_name,
            task_type.as_job_type(),
            profile_name
        )
    }

    /// Load tasks from remote configs, preserving existing task states
    pub async fn load_from_remote_configs(
        &self,
        all_settings: &Value,
        backend_name: &str,
        scheduler: State<'_, CronScheduler>,
        app: Option<&AppHandle>,
    ) -> Result<usize, String> {
        let settings_obj = all_settings
            .as_object()
            .ok_or("Settings is not an object")?;

        let mut loaded_count = 0;
        let mut new_task_ids = HashSet::new();
        let mut tasks_to_updates = Vec::new();

        // 1. Collect Tasks
        for (remote_name, remote_settings) in settings_obj {
            // Attempt to parse the remote settings
            if let Ok(config) = serde_json::from_value::<RemoteConfig>(remote_settings.clone()) {
                let tasks = self
                    .collect_tasks_from_remote(backend_name, remote_name, config)
                    .await;
                for task in tasks {
                    new_task_ids.insert(task.id.clone());
                    tasks_to_updates.push(task);
                }
            }
        }

        // 2. Apply Updates (Minimizing Lock Duration)
        for task_from_config in tasks_to_updates {
            if let Some(existing_task) = self.get_task(&task_from_config.id).await {
                // Check if configuration changed
                if self.task_config_changed(&existing_task, &task_from_config) {
                    self.update_task_config(&task_from_config.id, &task_from_config)
                        .await?;
                    info!(
                        "✏️ Updated task config: {} ({})",
                        existing_task.name, task_from_config.id
                    );
                }
            } else {
                self.add_task(task_from_config.clone(), None).await?;
                loaded_count += 1;
                info!(
                    "➕ Added new task: {} ({})",
                    task_from_config.name, task_from_config.id
                );
            }
        }

        // 3. Cleanup Obsolete Tasks
        self.cleanup_tasks(backend_name, &new_task_ids, scheduler, None)
            .await?;

        if (loaded_count > 0 || !new_task_ids.is_empty())
            && let Some(app) = app
        {
            let _ = app.emit(SCHEDULED_TASKS_CACHE_CHANGED, "bulk_update");
        }

        Ok(loaded_count)
    }

    /// Helper to collect all tasks from a single remote config
    async fn collect_tasks_from_remote(
        &self,
        backend_name: &str,
        remote_name: &str,
        config: RemoteConfig,
    ) -> Vec<ScheduledTask> {
        let mut tasks = Vec::new();

        let operations = [
            (config.sync_configs, TaskType::Sync),
            (config.copy_configs, TaskType::Copy),
            (config.move_configs, TaskType::Move),
            (config.bisync_configs, TaskType::Bisync),
        ];

        for (profiles_opt, task_type) in operations {
            if let Some(profiles) = profiles_opt {
                for (profile_name, profile_config) in profiles {
                    match self.create_task_struct(
                        backend_name,
                        remote_name,
                        &profile_name,
                        &task_type,
                        &profile_config,
                    ) {
                        Some(task) => tasks.push(task),
                        None => {
                            // Task disabled or invalid
                        }
                    }
                }
            }
        }
        tasks
    }

    fn task_config_changed(&self, existing: &ScheduledTask, new: &ScheduledTask) -> bool {
        existing.cron_expression != new.cron_expression
            || existing.args != new.args
            || existing.name != new.name
            || existing.task_type != new.task_type
    }

    async fn update_task_config(
        &self,
        task_id: &str,
        new_config: &ScheduledTask,
    ) -> Result<(), String> {
        self.update_task(
            task_id,
            |t| {
                t.name = new_config.name.clone();
                t.cron_expression = new_config.cron_expression.clone();
                t.args = new_config.args.clone();
                t.task_type = new_config.task_type.clone();
                t.next_run = new_config.next_run;
            },
            None,
        )
        .await
        .map(|_| ())
    }

    async fn cleanup_tasks(
        &self,
        backend_name: &str,
        active_ids: &HashSet<String>,
        scheduler: State<'_, CronScheduler>,
        app: Option<&AppHandle>,
    ) -> Result<(), String> {
        let all_tasks = self.get_all_tasks().await;
        for task in all_tasks {
            if task.backend_name == backend_name && !active_ids.contains(&task.id) {
                info!("🗑️ Removing obsolete task: {} ({})", task.name, task.id);
                self.remove_task(&task.id, scheduler.clone(), app).await?;
            }
        }
        Ok(())
    }

    fn create_task_struct(
        &self,
        backend_name: &str,
        remote_name: &str,
        profile_name: &str,
        task_type: &TaskType,
        config: &ProfileConfig,
    ) -> Option<ScheduledTask> {
        if !config.cron_enabled.unwrap_or(false) {
            return None;
        }
        let cron = config.cron_expression.as_ref().filter(|s| !s.is_empty())?;

        let task_id = Self::generate_task_id(backend_name, remote_name, task_type, profile_name);

        let params = ProfileParams {
            remote_name: remote_name.to_string(),
            profile_name: profile_name.to_string(),
            source: Some("scheduler".to_string()),
            no_cache: None,
        };

        let mut args = serde_json::to_value(params).ok()?;
        if let Some(args_obj) = args.as_object_mut() {
            if let Some(src) = &config.source {
                args_obj.insert("source".to_string(), Value::String(src.clone()));
            }
            if let Some(dst) = &config.dest {
                args_obj.insert("dest".to_string(), Value::String(dst.clone()));
            }
        }

        Some(ScheduledTask {
            id: task_id,
            name: format!(
                "{} - {} - {} ({})",
                backend_name,
                remote_name,
                task_type.as_job_type(),
                profile_name
            ),
            task_type: task_type.clone(),
            cron_expression: cron.clone(),
            status: TaskStatus::Enabled,
            args,
            backend_name: backend_name.to_string(),
            created_at: chrono::Utc::now(),
            last_run: None,
            next_run: get_next_run(cron).ok(),
            last_error: None,
            current_job_id: None,
            scheduler_job_id: None,
            run_count: 0,
            success_count: 0,
            failure_count: 0,
        })
    }

    // ============================================================================
    // STANDARD OPERATIONS
    // ============================================================================

    pub async fn add_task(
        &self,
        task: ScheduledTask,
        app: Option<&AppHandle>,
    ) -> Result<ScheduledTask, String> {
        let task_id = task.id.clone();
        let mut tasks = self.tasks.write().await;

        if tasks.contains_key(&task_id) {
            return Err(format!("Task with ID {} already exists", task_id));
        }

        tasks.insert(task_id.clone(), task.clone());
        if let Some(app) = app {
            let _ = app.emit(SCHEDULED_TASKS_CACHE_CHANGED, "task_added");
        }
        Ok(task)
    }

    pub async fn get_task(&self, task_id: &str) -> Option<ScheduledTask> {
        self.tasks.read().await.get(task_id).cloned()
    }

    pub async fn get_all_tasks(&self) -> Vec<ScheduledTask> {
        self.tasks.read().await.values().cloned().collect()
    }

    pub async fn get_task_by_job_id(&self, job_id: u64) -> Option<ScheduledTask> {
        self.tasks
            .read()
            .await
            .values()
            .find(|t| t.current_job_id == Some(job_id))
            .cloned()
    }

    pub async fn update_task(
        &self,
        task_id: &str,
        update_fn: impl FnOnce(&mut ScheduledTask),
        app: Option<&AppHandle>,
    ) -> Result<ScheduledTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks
            .get_mut(task_id)
            .ok_or(format!("Task {} not found", task_id))?;

        update_fn(task);
        let updated_task = task.clone();

        if let Some(app) = app {
            let _ = app.emit(SCHEDULED_TASKS_CACHE_CHANGED, "task_updated");
        }
        Ok(updated_task)
    }

    pub async fn remove_task(
        &self,
        task_id: &str,
        scheduler: State<'_, CronScheduler>,
        app: Option<&AppHandle>,
    ) -> Result<(), String> {
        let task = self.get_task(task_id).await.ok_or("Task not found")?;

        if let Some(job_id_str) = &task.scheduler_job_id
            && let Ok(job_id) = uuid::Uuid::parse_str(job_id_str)
        {
            let _ = scheduler.unschedule_task(job_id).await;
        }

        self.tasks.write().await.remove(task_id);

        if let Some(app) = app {
            let _ = app.emit(SCHEDULED_TASKS_CACHE_CHANGED, "task_removed");
        }
        Ok(())
    }

    pub async fn clear_all_tasks(&self, app: Option<&AppHandle>) -> Result<(), String> {
        let mut tasks = self.tasks.write().await;
        tasks.clear();
        if let Some(app) = app {
            let _ = app.emit(SCHEDULED_TASKS_CACHE_CHANGED, "all_cleared");
        }
        Ok(())
    }

    pub async fn add_or_update_task_for_remote(
        &self,
        cache_state: State<'_, ScheduledTasksCache>,
        backend_name: &str,
        remote_name: &str,
        remote_settings: &Value,
        scheduler: State<'_, CronScheduler>,
    ) -> Result<(), String> {
        let config: RemoteConfig = serde_json::from_value(remote_settings.clone())
            .map_err(|e| format!("Invalid remote settings: {}", e))?;

        let tasks = self
            .collect_tasks_from_remote(backend_name, remote_name, config)
            .await;

        for task_from_config in tasks {
            let task_id = task_from_config.id.clone();

            if let Some(existing_task) = self.get_task(&task_id).await {
                if self.task_config_changed(&existing_task, &task_from_config) {
                    self.update_task_config(&task_id, &task_from_config).await?;
                    // Sync with scheduler
                    if let Some(current_task) = self.get_task(&task_id).await {
                        let _ = scheduler
                            .reschedule_task(&current_task, cache_state.clone())
                            .await;
                    }
                }
            } else {
                self.add_task(task_from_config.clone(), None).await?;
                // Sync with scheduler
                let _ = scheduler
                    .reschedule_task(&task_from_config, cache_state.clone())
                    .await;
            }
        }
        Ok(())
    }

    pub async fn remove_tasks_for_remote(
        &self,
        backend_name: &str,
        remote_name: &str,
        scheduler: State<'_, CronScheduler>,
        app: Option<&AppHandle>,
    ) -> Result<Vec<String>, String> {
        let prefix = format!("{}:{}-", backend_name, remote_name);
        let to_remove: Vec<String> = self
            .get_all_tasks()
            .await
            .into_iter()
            .filter(|t| t.id.starts_with(&prefix))
            .map(|t| t.id)
            .collect();

        for id in &to_remove {
            self.remove_task(id, scheduler.clone(), None).await?;
        }

        if !to_remove.is_empty()
            && let Some(app) = app
        {
            let _ = app.emit(SCHEDULED_TASKS_CACHE_CHANGED, "remote_tasks_removed");
        }
        Ok(to_remove)
    }

    // Toggle task, Get Stats, Clear All/Backend tasks...
    // (Consolidated logic for brevity where possible)

    pub async fn toggle_task_status(
        &self,
        task_id: &str,
        app: Option<&AppHandle>,
    ) -> Result<ScheduledTask, String> {
        self.update_task(
            task_id,
            |task| {
                task.status = match task.status {
                    TaskStatus::Enabled => {
                        task.next_run = None;
                        TaskStatus::Disabled
                    }
                    TaskStatus::Disabled | TaskStatus::Failed => {
                        task.next_run = get_next_run(&task.cron_expression).ok();
                        TaskStatus::Enabled
                    }
                    TaskStatus::Running => TaskStatus::Stopping,
                    TaskStatus::Stopping => TaskStatus::Running,
                };
            },
            app,
        )
        .await
    }

    pub async fn get_stats(&self) -> ScheduledTaskStats {
        let tasks = self.tasks.read().await;
        ScheduledTaskStats {
            total_tasks: tasks.len(),
            enabled_tasks: tasks
                .values()
                .filter(|t| t.status == TaskStatus::Enabled)
                .count(),
            running_tasks: tasks
                .values()
                .filter(|t| t.status == TaskStatus::Running)
                .count(),
            failed_tasks: tasks
                .values()
                .filter(|t| t.status == TaskStatus::Failed)
                .count(),
            total_runs: tasks.values().map(|t| t.run_count).sum(),
            successful_runs: tasks.values().map(|t| t.success_count).sum(),
            failed_runs: tasks.values().map(|t| t.failure_count).sum(),
        }
    }

    pub async fn replace_tasks_for_backend(
        &self,
        backend_name: &str,
        new_tasks: HashMap<String, ScheduledTask>,
    ) {
        let mut tasks = self.tasks.write().await;
        tasks.retain(|_, task| task.backend_name != backend_name);
        tasks.extend(new_tasks);
    }

    pub async fn clear_backend_tasks(&self, backend_name: &str) {
        self.tasks
            .write()
            .await
            .retain(|_, t| t.backend_name != backend_name);
    }

    pub async fn get_tasks_for_backend(&self, backend_name: &str) -> Vec<ScheduledTask> {
        self.tasks
            .read()
            .await
            .values()
            .filter(|t| t.backend_name == backend_name)
            .cloned()
            .collect()
    }
}

impl Default for ScheduledTasksCache {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

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

#[tauri::command]
pub async fn reload_scheduled_tasks_from_configs(
    cache: State<'_, ScheduledTasksCache>,
    scheduler: State<'_, CronScheduler>,
    all_settings: serde_json::Value,
    app: AppHandle,
) -> Result<usize, String> {
    info!("🔄 Reloading scheduled tasks from configs...");
    let backend_manager = app.state::<crate::rclone::backend::BackendManager>();
    let backend_name = backend_manager.get_active_name().await;

    let task_count = cache
        .load_from_remote_configs(&all_settings, &backend_name, scheduler.clone(), Some(&app))
        .await?;

    info!("📅 Loaded/updated {} scheduled task(s)", task_count);
    scheduler.reload_tasks(cache).await?;
    Ok(task_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_remote_config_deserialization() {
        let json_data = json!({
            "copyConfigs": {
                "profile1": {
                    "cronEnabled": true,
                    "cronExpression": "0 0 * * *",
                    "source": "/src",
                    "dest": "/dst"
                }
            },
            "syncConfigs": {},
            "moveConfigs": null
        });

        let config: RemoteConfig = serde_json::from_value(json_data).unwrap();

        assert!(config.copy_configs.is_some());
        let copy_profiles = config.copy_configs.unwrap();
        assert!(copy_profiles.contains_key("profile1"));

        let profile = copy_profiles.get("profile1").unwrap();
        assert_eq!(profile.cron_enabled, Some(true));
        assert_eq!(profile.cron_expression, Some("0 0 * * *".to_string()));
        assert_eq!(profile.source, Some("/src".to_string()));
    }
}
