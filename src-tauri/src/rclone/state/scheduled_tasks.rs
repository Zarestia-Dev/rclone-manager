use crate::{
    core::scheduler::engine::get_next_run,
    utils::types::{
        remotes::ProfileParams,
        scheduled_task::{ScheduledTask, ScheduledTaskStats, TaskStatus, TaskType},
    },
};
use log::info;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;

use crate::utils::types::events::SCHEDULED_TASKS_CACHE_CHANGED;

// ============================================================================
// CONFIGURATION STRUCTS
// ============================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileConfig {
    cron_enabled: Option<bool>,
    cron_expression: Option<String>,
    source: Option<String>,
    dest: Option<String>,
}

// ============================================================================
// CACHE UPDATE RESULT
// ============================================================================

/// Returned by `load_from_remote_configs` so callers can act on exactly what
/// changed. The cache itself does not touch the scheduler — all scheduling and
/// unscheduling decisions belong to the caller.
pub struct CacheUpdateResult {
    /// Tasks that did not previously exist and were inserted.
    pub added: Vec<ScheduledTask>,
    /// Tasks whose cron expression, args, name, or type changed.
    pub updated: Vec<ScheduledTask>,
    /// Tasks removed because they are no longer present in the config.
    /// Callers must unschedule these using the `scheduler_job_id` field.
    pub removed: Vec<ScheduledTask>,
}

impl CacheUpdateResult {
    pub fn has_changes(&self) -> bool {
        !self.added.is_empty() || !self.updated.is_empty() || !self.removed.is_empty()
    }
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
        format!("{backend_name}:{remote_name}-{task_type:?}-{profile_name}")
    }

    /// Load tasks from remote configs, preserving existing task states.
    ///
    /// Returns a `CacheUpdateResult` describing what changed. The caller is
    /// responsible for all scheduler interaction — unscheduling `removed`
    /// tasks and rescheduling `added`/`updated` tasks.
    pub async fn load_from_remote_configs(
        &self,
        all_settings: &Value,
        backend_name: &str,
        app: Option<&AppHandle>,
    ) -> Result<CacheUpdateResult, String> {
        let settings_obj = all_settings
            .as_object()
            .ok_or("Settings is not an object")?;

        let mut new_task_ids = HashSet::new();
        let mut tasks_to_update = Vec::new();

        for (remote_name, remote_settings) in settings_obj {
            let tasks = self.collect_tasks_from_remote(backend_name, remote_name, remote_settings);
            for task in tasks {
                new_task_ids.insert(task.id.clone());
                tasks_to_update.push(task);
            }
        }

        let mut added = Vec::new();
        let mut updated = Vec::new();

        for task_from_config in tasks_to_update {
            if let Some(existing_task) = self.get_task(&task_from_config.id).await {
                if self.task_config_changed(&existing_task, &task_from_config) {
                    self.update_task_config(&task_from_config.id, &task_from_config)
                        .await?;
                    info!(
                        "✏️ Updated task config: {} ({})",
                        existing_task.name, task_from_config.id
                    );
                    if let Some(t) = self.get_task(&task_from_config.id).await {
                        updated.push(t);
                    }
                }
            } else {
                self.add_task(task_from_config.clone(), None).await?;
                added.push(task_from_config.clone());
                info!(
                    "➕ Added new task: {} ({})",
                    task_from_config.name, task_from_config.id
                );
            }
        }

        let removed = self
            .cleanup_tasks(backend_name, &new_task_ids, None)
            .await?;

        let result = CacheUpdateResult {
            added,
            updated,
            removed,
        };

        if result.has_changes()
            && let Some(app) = app
        {
            let _ = app.emit(SCHEDULED_TASKS_CACHE_CHANGED, "bulk_update");
        }

        Ok(result)
    }

    fn collect_tasks_from_remote(
        &self,
        backend_name: &str,
        remote_name: &str,
        remote_settings: &Value,
    ) -> Vec<ScheduledTask> {
        let mut tasks = Vec::new();

        let Some(obj) = remote_settings.as_object() else {
            return tasks;
        };

        let operations = [
            ("syncConfigs", TaskType::Sync),
            ("copyConfigs", TaskType::Copy),
            ("moveConfigs", TaskType::Move),
            ("bisyncConfigs", TaskType::Bisync),
        ];

        for (key, task_type) in operations {
            if let Some(profiles) = obj.get(key).and_then(|v| v.as_object()) {
                for (profile_name, profile_val) in profiles {
                    if let Some(task) = serde_json::from_value::<ProfileConfig>(profile_val.clone())
                        .ok()
                        .and_then(|config| {
                            self.create_task_struct(
                                backend_name,
                                remote_name,
                                profile_name,
                                &task_type,
                                &config,
                            )
                        })
                    {
                        tasks.push(task);
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
                // Intentionally NOT overwriting `status` — the user's
                // enabled/disabled choice is the source of truth in the cache.
            },
            None,
        )
        .await
        .map(|_| ())
    }

    /// Removes tasks that belong to `backend_name` but are NOT in `active_ids`.
    /// Returns the removed tasks so the caller can unschedule their jobs.
    async fn cleanup_tasks(
        &self,
        backend_name: &str,
        active_ids: &HashSet<String>,
        app: Option<&AppHandle>,
    ) -> Result<Vec<ScheduledTask>, String> {
        let stale: Vec<String> = self
            .get_all_tasks()
            .await
            .into_iter()
            .filter(|t| t.backend_name == backend_name && !active_ids.contains(&t.id))
            .map(|t| t.id)
            .collect();

        let mut removed = Vec::with_capacity(stale.len());
        for id in &stale {
            info!("🗑️ Removing obsolete task: {id}");
            removed.push(self.remove_task(id, app).await?);
        }
        Ok(removed)
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
        let source = config.source.as_ref().filter(|s| !s.is_empty())?;
        let dest = config.dest.as_ref().filter(|s| !s.is_empty())?;

        let task_id = Self::generate_task_id(backend_name, remote_name, task_type, profile_name);

        let params = ProfileParams {
            remote_name: remote_name.to_string(),
            profile_name: profile_name.to_string(),
            origin: Some(crate::utils::types::origin::Origin::Scheduler),
            no_cache: None,
        };

        let mut args = serde_json::to_value(params).ok()?;
        if let Some(args_obj) = args.as_object_mut() {
            args_obj.insert("source".to_string(), Value::String(source.clone()));
            args_obj.insert("dest".to_string(), Value::String(dest.clone()));
        }

        Some(ScheduledTask {
            id: task_id,
            name: format!("{backend_name} - {remote_name} - {task_type:?} ({profile_name})"),
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
            return Err(format!("Task with ID {task_id} already exists"));
        }

        tasks.insert(task_id.clone(), task.clone());
        drop(tasks);
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

    pub async fn get_task_by_job_id(&self, job_id: String) -> Option<ScheduledTask> {
        self.tasks
            .read()
            .await
            .values()
            .find(|t| t.current_job_id == Some(job_id.clone()))
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
            .ok_or_else(|| format!("Task {task_id} not found"))?;

        update_fn(task);
        let updated_task = task.clone();
        drop(tasks);

        if let Some(app) = app {
            let _ = app.emit(SCHEDULED_TASKS_CACHE_CHANGED, "task_updated");
        }
        Ok(updated_task)
    }

    /// Remove a task from the cache and return it. The caller is responsible
    /// for unscheduling the associated scheduler job via `scheduler_job_id`.
    pub async fn remove_task(
        &self,
        task_id: &str,
        app: Option<&AppHandle>,
    ) -> Result<ScheduledTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks
            .remove(task_id)
            .ok_or_else(|| format!("Task {task_id} not found"))?;
        drop(tasks);
        if let Some(app) = app {
            let _ = app.emit(SCHEDULED_TASKS_CACHE_CHANGED, "task_removed");
        }
        Ok(task)
    }

    pub async fn clear_all_tasks(&self, app: Option<&AppHandle>) -> Result<(), String> {
        self.tasks.write().await.clear();
        if let Some(app) = app {
            let _ = app.emit(SCHEDULED_TASKS_CACHE_CHANGED, "all_cleared");
        }
        Ok(())
    }

    /// Add or update tasks derived from a single remote's settings, removing
    /// tasks for profiles that no longer have cron enabled.
    ///
    /// Returns a `CacheUpdateResult`. The caller handles all scheduler
    /// interaction for the returned tasks.
    pub async fn add_or_update_task_for_remote(
        &self,
        backend_name: &str,
        remote_name: &str,
        remote_settings: &Value,
    ) -> Result<CacheUpdateResult, String> {
        let tasks = self.collect_tasks_from_remote(backend_name, remote_name, remote_settings);

        let active_ids: HashSet<String> = tasks.iter().map(|t| t.id.clone()).collect();

        let mut added = Vec::new();
        let mut updated = Vec::new();

        for task_from_config in tasks {
            let task_id = task_from_config.id.clone();

            if let Some(existing_task) = self.get_task(&task_id).await {
                if self.task_config_changed(&existing_task, &task_from_config) {
                    self.update_task_config(&task_id, &task_from_config).await?;
                    if let Some(current_task) = self.get_task(&task_id).await {
                        updated.push(current_task);
                    }
                }
            } else {
                self.add_task(task_from_config.clone(), None).await?;
                added.push(task_from_config);
            }
        }

        let prefix = format!("{backend_name}:{remote_name}-");
        let to_remove: Vec<String> = self
            .get_all_tasks()
            .await
            .into_iter()
            .filter(|t| t.id.starts_with(&prefix) && !active_ids.contains(&t.id))
            .map(|t| t.id)
            .collect();

        let mut removed = Vec::with_capacity(to_remove.len());
        for id in &to_remove {
            info!("🗑️ Removing task no longer in config: {id}");
            removed.push(self.remove_task(id, None).await?);
        }

        Ok(CacheUpdateResult {
            added,
            updated,
            removed,
        })
    }

    /// Remove all tasks belonging to a remote and return them. The caller is
    /// responsible for unscheduling their jobs.
    pub async fn remove_tasks_for_remote(
        &self,
        backend_name: &str,
        remote_name: &str,
        app: Option<&AppHandle>,
    ) -> Result<Vec<ScheduledTask>, String> {
        let prefix = format!("{backend_name}:{remote_name}-");
        let to_remove: Vec<String> = self
            .get_all_tasks()
            .await
            .into_iter()
            .filter(|t| t.id.starts_with(&prefix))
            .map(|t| t.id)
            .collect();

        let mut removed = Vec::with_capacity(to_remove.len());
        for id in &to_remove {
            removed.push(self.remove_task(id, None).await?);
        }

        if !removed.is_empty()
            && let Some(app) = app
        {
            let _ = app.emit(SCHEDULED_TASKS_CACHE_CHANGED, "remote_tasks_removed");
        }
        Ok(removed)
    }

    /// Toggle a task status.
    ///
    /// - `Enabled` -> `Disabled`
    /// - `Disabled`/`Failed` -> `Enabled`
    /// - `Running` -> `Stopping` (let the current run finish, then disable)
    /// - `Stopping` -> no-op
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
                    TaskStatus::Stopping => TaskStatus::Stopping,
                };
            },
            app,
        )
        .await
    }

    pub async fn get_stats(&self) -> ScheduledTaskStats {
        let tasks = self.tasks.read().await;
        let mut stats = ScheduledTaskStats {
            total_tasks: tasks.len(),
            enabled_tasks: 0,
            running_tasks: 0,
            failed_tasks: 0,
            total_runs: 0,
            successful_runs: 0,
            failed_runs: 0,
        };
        for t in tasks.values() {
            match t.status {
                TaskStatus::Enabled => stats.enabled_tasks += 1,
                TaskStatus::Running => stats.running_tasks += 1,
                TaskStatus::Failed => stats.failed_tasks += 1,
                _ => {}
            }
            stats.total_runs += t.run_count;
            stats.successful_runs += t.success_count;
            stats.failed_runs += t.failure_count;
        }
        stats
    }

    /// Remove all tasks for a backend. Returns the evicted tasks so the
    /// caller can unschedule their jobs.
    pub async fn clear_backend_tasks(&self, backend_name: &str) -> Vec<ScheduledTask> {
        let mut tasks = self.tasks.write().await;
        let mut removed = Vec::new();
        tasks.retain(|_, t| {
            if t.backend_name == backend_name {
                removed.push(t.clone());
                false
            } else {
                true
            }
        });
        removed
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

/// Read-only query commands that only touch the cache live here.
/// Commands that coordinate both cache and scheduler live in `commands.rs`.

#[tauri::command]
pub async fn get_scheduled_tasks(app: AppHandle) -> Result<Vec<ScheduledTask>, String> {
    let cache = app.state::<ScheduledTasksCache>();
    Ok(cache.get_all_tasks().await)
}

#[tauri::command]
pub async fn get_scheduled_task(
    app: AppHandle,
    task_id: String,
) -> Result<Option<ScheduledTask>, String> {
    let cache = app.state::<ScheduledTasksCache>();
    Ok(cache.get_task(&task_id).await)
}

#[tauri::command]
pub async fn get_scheduled_tasks_stats(app: AppHandle) -> Result<ScheduledTaskStats, String> {
    let cache = app.state::<ScheduledTasksCache>();
    Ok(cache.get_stats().await)
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // -----------------------------------------------------------------------
    // RemoteConfig deserialization
    // -----------------------------------------------------------------------

    #[test]
    fn test_profile_config_deserialization() {
        let json_data = json!({
            "cronEnabled": true,
            "cronExpression": "0 0 * * *",
            "source": "/src",
            "dest": "/dst"
        });

        let p: ProfileConfig = serde_json::from_value(json_data).unwrap();
        assert_eq!(p.cron_enabled, Some(true));
        assert_eq!(p.cron_expression.as_deref(), Some("0 0 * * *"));
        assert_eq!(p.source.as_deref(), Some("/src"));
    }

    // -----------------------------------------------------------------------
    // Task ID generation
    // -----------------------------------------------------------------------

    #[test]
    fn test_generate_task_id() {
        let id =
            ScheduledTasksCache::generate_task_id("mybackend", "gdrive", &TaskType::Sync, "daily");
        assert_eq!(id, "mybackend:gdrive-sync-daily");
    }

    #[test]
    fn test_generate_task_id_uniqueness_across_types() {
        let sync_id = ScheduledTasksCache::generate_task_id("b", "r", &TaskType::Sync, "p");
        let copy_id = ScheduledTasksCache::generate_task_id("b", "r", &TaskType::Copy, "p");
        assert_ne!(sync_id, copy_id);
    }

    // -----------------------------------------------------------------------
    // create_task_struct
    // -----------------------------------------------------------------------

    fn make_cache() -> ScheduledTasksCache {
        ScheduledTasksCache::new()
    }

    fn make_full_profile_config(enabled: bool, cron: &str) -> ProfileConfig {
        ProfileConfig {
            cron_enabled: Some(enabled),
            cron_expression: Some(cron.to_string()),
            source: Some("/src".to_string()),
            dest: Some("/dst".to_string()),
        }
    }

    #[test]
    fn test_create_task_struct_disabled_returns_none() {
        let cache = make_cache();
        let cfg = make_full_profile_config(false, "* * * * *");
        let result = cache.create_task_struct("b", "r", "p", &TaskType::Sync, &cfg);
        assert!(result.is_none(), "disabled task should return None");
    }

    #[test]
    fn test_create_task_struct_empty_cron_returns_none() {
        let cache = make_cache();
        let cfg = ProfileConfig {
            cron_enabled: Some(true),
            cron_expression: Some(String::new()),
            source: Some("/src".to_string()),
            dest: Some("/dst".to_string()),
        };
        let result = cache.create_task_struct("b", "r", "p", &TaskType::Sync, &cfg);
        assert!(result.is_none(), "empty cron should return None");
    }

    #[test]
    fn test_create_task_struct_missing_source_returns_none() {
        let cache = make_cache();
        let cfg = ProfileConfig {
            cron_enabled: Some(true),
            cron_expression: Some("* * * * *".to_string()),
            source: None,
            dest: Some("/dst".to_string()),
        };
        assert!(
            cache
                .create_task_struct("b", "r", "p", &TaskType::Sync, &cfg)
                .is_none(),
            "missing source should return None"
        );
    }

    #[test]
    fn test_create_task_struct_empty_source_returns_none() {
        let cache = make_cache();
        let cfg = ProfileConfig {
            cron_enabled: Some(true),
            cron_expression: Some("* * * * *".to_string()),
            source: Some(String::new()),
            dest: Some("/dst".to_string()),
        };
        assert!(
            cache
                .create_task_struct("b", "r", "p", &TaskType::Sync, &cfg)
                .is_none(),
            "empty source should return None"
        );
    }

    #[test]
    fn test_create_task_struct_missing_dest_returns_none() {
        let cache = make_cache();
        let cfg = ProfileConfig {
            cron_enabled: Some(true),
            cron_expression: Some("* * * * *".to_string()),
            source: Some("/src".to_string()),
            dest: None,
        };
        assert!(
            cache
                .create_task_struct("b", "r", "p", &TaskType::Sync, &cfg)
                .is_none(),
            "missing dest should return None"
        );
    }

    #[test]
    fn test_create_task_struct_empty_dest_returns_none() {
        let cache = make_cache();
        let cfg = ProfileConfig {
            cron_enabled: Some(true),
            cron_expression: Some("* * * * *".to_string()),
            source: Some("/src".to_string()),
            dest: Some(String::new()),
        };
        assert!(
            cache
                .create_task_struct("b", "r", "p", &TaskType::Sync, &cfg)
                .is_none(),
            "empty dest should return None"
        );
    }

    #[test]
    fn test_create_task_struct_valid() {
        let cache = make_cache();
        let cfg = ProfileConfig {
            cron_enabled: Some(true),
            cron_expression: Some("*/5 * * * *".to_string()),
            source: Some("/src".to_string()),
            dest: Some("/dst".to_string()),
        };
        let task = cache
            .create_task_struct("backend", "remote", "daily", &TaskType::Copy, &cfg)
            .expect("should produce a task");

        assert_eq!(task.status, TaskStatus::Enabled);
        assert_eq!(task.cron_expression, "*/5 * * * *");
        assert_eq!(task.task_type, TaskType::Copy);
        assert!(task.scheduler_job_id.is_none());
        assert!(task.current_job_id.is_none());

        assert_eq!(
            task.args.get("source").and_then(|v| v.as_str()),
            Some("/src")
        );
        assert_eq!(task.args.get("dest").and_then(|v| v.as_str()), Some("/dst"));
    }

    // -----------------------------------------------------------------------
    // task_config_changed
    // -----------------------------------------------------------------------

    fn base_task() -> ScheduledTask {
        ScheduledTask {
            id: "b:r-sync-p".to_string(),
            name: "name".to_string(),
            task_type: TaskType::Sync,
            cron_expression: "* * * * *".to_string(),
            status: TaskStatus::Enabled,
            args: json!({"remote_name": "r"}),
            backend_name: "b".to_string(),
            created_at: chrono::Utc::now(),
            last_run: None,
            next_run: None,
            last_error: None,
            current_job_id: None,
            scheduler_job_id: None,
            run_count: 0,
            success_count: 0,
            failure_count: 0,
        }
    }

    #[test]
    fn test_task_config_changed_same() {
        let cache = make_cache();
        let a = base_task();
        let b = base_task();
        assert!(!cache.task_config_changed(&a, &b));
    }

    #[test]
    fn test_task_config_changed_cron() {
        let cache = make_cache();
        let a = base_task();
        let mut b = base_task();
        b.cron_expression = "0 9 * * 1-5".to_string();
        assert!(cache.task_config_changed(&a, &b));
    }

    #[test]
    fn test_task_config_changed_status_ignored() {
        let cache = make_cache();
        let a = base_task();
        let mut b = base_task();
        b.status = TaskStatus::Disabled;
        assert!(!cache.task_config_changed(&a, &b));
    }

    // -----------------------------------------------------------------------
    // Cache CRUD
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn test_add_and_get_task() {
        let cache = make_cache();
        let task = base_task();
        let id = task.id.clone();

        cache.add_task(task.clone(), None).await.unwrap();
        let fetched = cache.get_task(&id).await.unwrap();
        assert_eq!(fetched.id, id);
    }

    #[tokio::test]
    async fn test_add_duplicate_task_returns_error() {
        let cache = make_cache();
        let task = base_task();
        cache.add_task(task.clone(), None).await.unwrap();
        let result = cache.add_task(task, None).await;
        assert!(result.is_err(), "duplicate insert should fail");
    }

    #[tokio::test]
    async fn test_get_nonexistent_task_returns_none() {
        let cache = make_cache();
        assert!(cache.get_task("does-not-exist").await.is_none());
    }

    #[tokio::test]
    async fn test_update_task() {
        let cache = make_cache();
        let task = base_task();
        let id = task.id.clone();
        cache.add_task(task, None).await.unwrap();

        let updated = cache
            .update_task(&id, |t| t.run_count += 1, None)
            .await
            .unwrap();
        assert_eq!(updated.run_count, 1);

        let fetched = cache.get_task(&id).await.unwrap();
        assert_eq!(fetched.run_count, 1);
    }

    #[tokio::test]
    async fn test_update_nonexistent_task_returns_error() {
        let cache = make_cache();
        let result = cache.update_task("ghost", |_| {}, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_remove_task_returns_task() {
        let cache = make_cache();
        let task = base_task();
        let id = task.id.clone();
        cache.add_task(task.clone(), None).await.unwrap();

        let removed = cache.remove_task(&id, None).await.unwrap();
        assert_eq!(removed.id, id);
        assert!(
            cache.get_task(&id).await.is_none(),
            "task must be gone from cache"
        );
    }

    #[tokio::test]
    async fn test_remove_nonexistent_task_returns_error() {
        let cache = make_cache();
        let result = cache.remove_task("ghost", None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_remove_task_preserves_scheduler_job_id() {
        let cache = make_cache();
        let mut task = base_task();
        task.scheduler_job_id = Some("550e8400-e29b-41d4-a716-446655440000".to_string());
        let id = task.id.clone();
        cache.add_task(task, None).await.unwrap();

        let removed = cache.remove_task(&id, None).await.unwrap();
        assert_eq!(
            removed.scheduler_job_id.as_deref(),
            Some("550e8400-e29b-41d4-a716-446655440000"),
            "caller needs scheduler_job_id to unschedule the job"
        );
    }

    #[tokio::test]
    async fn test_get_all_tasks() {
        let cache = make_cache();
        let mut t1 = base_task();
        t1.id = "id1".to_string();
        let mut t2 = base_task();
        t2.id = "id2".to_string();

        cache.add_task(t1, None).await.unwrap();
        cache.add_task(t2, None).await.unwrap();

        let all = cache.get_all_tasks().await;
        assert_eq!(all.len(), 2);
    }

    #[tokio::test]
    async fn test_clear_all_tasks() {
        let cache = make_cache();
        cache.add_task(base_task(), None).await.unwrap();
        cache.clear_all_tasks(None).await.unwrap();
        assert!(cache.get_all_tasks().await.is_empty());
    }

    // -----------------------------------------------------------------------
    // clear_backend_tasks
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn test_clear_backend_tasks_returns_evicted() {
        let cache = make_cache();

        let mut t1 = base_task();
        t1.id = "b1:r-sync-p".to_string();
        t1.backend_name = "b1".to_string();
        t1.scheduler_job_id = Some("550e8400-e29b-41d4-a716-446655440000".to_string());

        let mut t2 = base_task();
        t2.id = "b2:r-sync-p".to_string();
        t2.backend_name = "b2".to_string();

        cache.add_task(t1, None).await.unwrap();
        cache.add_task(t2, None).await.unwrap();

        let evicted = cache.clear_backend_tasks("b1").await;
        assert_eq!(evicted.len(), 1);
        assert_eq!(evicted[0].backend_name, "b1");
        assert!(
            evicted[0].scheduler_job_id.is_some(),
            "job id must survive eviction"
        );
        assert_eq!(cache.get_all_tasks().await.len(), 1, "b2 task must remain");
    }

    // -----------------------------------------------------------------------
    // toggle_task_status
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn test_toggle_enabled_to_disabled() {
        let cache = make_cache();
        let mut task = base_task();
        task.status = TaskStatus::Enabled;
        let id = task.id.clone();
        cache.add_task(task, None).await.unwrap();

        let toggled = cache.toggle_task_status(&id, None).await.unwrap();
        assert_eq!(toggled.status, TaskStatus::Disabled);
        assert!(toggled.next_run.is_none());
    }

    #[tokio::test]
    async fn test_toggle_disabled_to_enabled() {
        let cache = make_cache();
        let mut task = base_task();
        task.status = TaskStatus::Disabled;
        let id = task.id.clone();
        cache.add_task(task, None).await.unwrap();

        let toggled = cache.toggle_task_status(&id, None).await.unwrap();
        assert_eq!(toggled.status, TaskStatus::Enabled);
    }

    #[tokio::test]
    async fn test_toggle_running_to_stopping() {
        let cache = make_cache();
        let mut task = base_task();
        task.status = TaskStatus::Running;
        let id = task.id.clone();
        cache.add_task(task, None).await.unwrap();

        let result = cache.toggle_task_status(&id, None).await.unwrap();
        assert_eq!(
            result.status,
            TaskStatus::Stopping,
            "toggling a Running task must transition to Stopping"
        );
    }

    // -----------------------------------------------------------------------
    // Stats
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn test_get_stats_empty() {
        let cache = make_cache();
        let stats = cache.get_stats().await;
        assert_eq!(stats.total_tasks, 0);
        assert_eq!(stats.enabled_tasks, 0);
        assert_eq!(stats.total_runs, 0);
    }

    #[tokio::test]
    async fn test_get_stats_counts() {
        let cache = make_cache();

        let mut enabled = base_task();
        enabled.id = "e1".to_string();
        enabled.status = TaskStatus::Enabled;
        enabled.run_count = 3;
        enabled.success_count = 2;
        enabled.failure_count = 1;

        let mut disabled = base_task();
        disabled.id = "d1".to_string();
        disabled.status = TaskStatus::Disabled;

        cache.add_task(enabled, None).await.unwrap();
        cache.add_task(disabled, None).await.unwrap();

        let stats = cache.get_stats().await;
        assert_eq!(stats.total_tasks, 2);
        assert_eq!(stats.enabled_tasks, 1);
        assert_eq!(stats.total_runs, 3);
        assert_eq!(stats.successful_runs, 2);
        assert_eq!(stats.failed_runs, 1);
    }

    // -----------------------------------------------------------------------
    // CacheUpdateResult
    // -----------------------------------------------------------------------

    #[test]
    fn test_cache_update_result_has_changes() {
        let empty = CacheUpdateResult {
            added: vec![],
            updated: vec![],
            removed: vec![],
        };
        assert!(!empty.has_changes());

        let with_removal = CacheUpdateResult {
            added: vec![],
            updated: vec![],
            removed: vec![base_task()],
        };
        assert!(with_removal.has_changes());
    }

    // -----------------------------------------------------------------------
    // get_tasks_for_backend / prefix filtering
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn test_get_tasks_for_backend_filters_correctly() {
        let cache = make_cache();

        let mut t1 = base_task();
        t1.id = "backend_a:remote-sync-p".to_string();
        t1.backend_name = "backend_a".to_string();

        let mut t2 = base_task();
        t2.id = "backend_b:remote-sync-p".to_string();
        t2.backend_name = "backend_b".to_string();

        cache.add_task(t1, None).await.unwrap();
        cache.add_task(t2, None).await.unwrap();

        let a_tasks = cache.get_tasks_for_backend("backend_a").await;
        assert_eq!(a_tasks.len(), 1);
        assert_eq!(a_tasks[0].backend_name, "backend_a");
    }
}
