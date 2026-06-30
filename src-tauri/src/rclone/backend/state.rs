// Backend state management (save/restore)

use crate::rclone::backend::BackendManager;
use crate::rclone::state::cache::RemoteCacheContext;
use log::info;

use crate::rclone::state::options::OptionsCacheEntry;
use crate::utils::types::jobs::JobInfo;

/// Per-backend cached state (jobs and remote context)
///
/// Saved when leaving a backend and restored when returning to it,
/// so the UI doesn't lose in-flight job state during a switch.
#[derive(Debug, Clone, Default)]
pub struct BackendState {
    pub jobs: Vec<JobInfo>,
    pub context: RemoteCacheContext,
    pub options: Option<OptionsCacheEntry>,
}

/// Save active jobs and remote context for the given backend name.
///
/// Called by `BackendManager::switch_to` before switching away.
/// Task lifecycle (scheduling / unscheduling) is the Tauri command's
/// responsibility and is intentionally kept out of this module.
pub async fn save_backend_state(manager: &BackendManager, name: &str) {
    let (jobs, context, options) = tokio::join!(
        manager.job_cache.get_jobs(),
        manager.remote_cache.get_context(),
        manager.options_cache.get_entry()
    );

    manager
        .save_state(
            name,
            BackendState {
                jobs,
                context,
                options,
            },
        )
        .await;

    info!("Saved state for backend: {name}");
}

/// Restore jobs and remote context for the given backend name.
///
/// Called by `BackendManager::switch_to` after switching to a new backend.
pub async fn restore_backend_state(manager: &BackendManager, name: &str) {
    let saved = manager.get_state(name).await;

    tokio::join!(
        manager.job_cache.set_all_jobs(saved.jobs),
        manager.remote_cache.set_context(saved.context),
        manager.options_cache.set_entry(saved.options)
    );

    info!("Restored state for backend: {name}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rclone::backend::BackendManager;

    #[tokio::test]
    async fn test_save_and_restore_empty_state() {
        let manager = BackendManager::new();
        // Saving then restoring with no data should not panic
        save_backend_state(&manager, "Local").await;
        restore_backend_state(&manager, "Local").await;
    }
}
