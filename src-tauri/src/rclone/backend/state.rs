// Backend state management (save/restore)

use crate::rclone::backend::BackendManager;
use crate::rclone::state::cache::RemoteCacheContext;
use log::info;
use std::collections::HashMap;

use crate::utils::types::{jobs::JobInfo, scheduled_task::ScheduledTask};

/// Per-backend cached state (jobs, remote context, scheduled tasks)
#[derive(Debug, Clone, Default)]
pub struct BackendState {
    pub jobs: Vec<JobInfo>,
    pub context: RemoteCacheContext,
    /// Scheduled tasks for this backend (task_id → task)
    pub tasks: HashMap<String, ScheduledTask>,
}

/// Helper to save current state (Jobs + Context + Tasks)
pub async fn save_backend_state(
    manager: &BackendManager,
    name: &str,
    task_cache: Option<&crate::rclone::state::scheduled_tasks::ScheduledTasksCache>,
) {
    let jobs = manager.job_cache.get_all_jobs().await;
    let context = manager.remote_cache.get_context().await;

    // Get tasks for this backend
    let tasks = if let Some(cache) = task_cache {
        cache
            .get_tasks_for_backend(name)
            .await
            .into_iter()
            .map(|task| (task.id.clone(), task))
            .collect()
    } else {
        HashMap::new()
    };

    let task_count = tasks.len(); // Capture length before move
    let current_state = BackendState {
        jobs,
        context,
        tasks,
    };

    manager.save_state(name, current_state).await;

    info!(
        "💾 Saved state for backend: {} ({} tasks)",
        name, task_count
    );
}

/// Helper to restore stored state for a backend
pub async fn restore_backend_state(
    manager: &BackendManager,
    name: &str,
    task_cache: Option<&crate::rclone::state::scheduled_tasks::ScheduledTasksCache>,
) {
    let new_state = manager.get_state(name).await;

    manager.job_cache.set_all_jobs(new_state.jobs).await;
    manager.remote_cache.set_context(new_state.context).await;

    // Restore tasks for this backend
    if let Some(cache) = task_cache {
        cache
            .replace_tasks_for_backend(name, new_state.tasks.clone())
            .await;
    }

    info!(
        "📂 Restored state for backend: {} ({} tasks)",
        name,
        new_state.tasks.len()
    );
}

#[cfg(test)]
mod tests {
    // TODO: Add state management tests
    // - Test state save and restore
    // - Test empty state handling
    // - Test task preservation
    // - Test job cache preservation
}
