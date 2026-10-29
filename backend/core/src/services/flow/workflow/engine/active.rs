//! Which workflows are running, and stopping them.

use std::collections::{HashMap, HashSet, hash_map::Entry};
use std::sync::Arc;

use log::{info, warn};
use parking_lot::RwLock;
use serde_json::Value;

use crate::context::AppHandle;
use crate::rclone::backend::{BackendManager, types::Backend};
use crate::services::flow::workflow::engine::cancel::CancelToken;

#[derive(Clone)]
pub(crate) struct ActiveWorkflowState {
    pub(crate) backend: Backend,
    pub(crate) cancel: CancelToken,
    pub(crate) active_job_ids: Arc<RwLock<HashSet<u64>>>,
}

/// A run is identified by its backend and workflow id: each backend has its own
/// workflows, and copying them to another backend keeps their ids.
type RunKey = (String, String);

static ACTIVE_WORKFLOW_EXECUTIONS: std::sync::LazyLock<
    RwLock<HashMap<RunKey, ActiveWorkflowState>>,
> = std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

/// Removes a run from the active set on every exit path.
pub(crate) struct ActiveRunGuard {
    key: RunKey,
}

impl Drop for ActiveRunGuard {
    fn drop(&mut self) {
        ACTIVE_WORKFLOW_EXECUTIONS.write().remove(&self.key);
    }
}

/// Claims the single run slot a workflow has on its backend. Two overlapping runs
/// would share one cancellation and tracking entry, so the second is refused.
pub(crate) fn register_active_run(
    workflow_name: &str,
    workflow_id: &str,
    state: ActiveWorkflowState,
) -> Result<ActiveRunGuard, String> {
    let key = (state.backend.name.clone(), workflow_id.to_string());
    match ACTIVE_WORKFLOW_EXECUTIONS.write().entry(key.clone()) {
        Entry::Occupied(_) => Err(crate::localized_error!(
            "backendErrors.automation.workflowAlreadyRunning",
            "name" => workflow_name
        )),
        Entry::Vacant(slot) => {
            slot.insert(state);
            Ok(ActiveRunGuard { key })
        }
    }
}

/// Whether `workflow_id` is running on `backend`.
#[must_use]
pub fn is_workflow_active(backend: &str, workflow_id: &str) -> bool {
    ACTIVE_WORKFLOW_EXECUTIONS
        .read()
        .contains_key(&(backend.to_string(), workflow_id.to_string()))
}

/// IDs of the workflows currently running on `backend`.
#[must_use]
pub fn get_active_workflow_ids(backend: &str) -> HashSet<String> {
    ACTIVE_WORKFLOW_EXECUTIONS
        .read()
        .keys()
        .filter(|(running_on, _)| running_on == backend)
        .map(|(_, id)| id.clone())
        .collect()
}

#[must_use]
pub fn has_active_workflows() -> bool {
    !ACTIVE_WORKFLOW_EXECUTIONS.read().is_empty()
}

/// Halts an actively executing workflow and terminates any underlying Rclone transfer jobs.
///
/// The run on the selected backend is stopped; a run of the same id on another
/// backend is only stopped when none is running on the selected one.
pub async fn stop_workflow(app: &AppHandle, workflow_id: &str) -> Result<(), String> {
    let selected = app.state::<BackendManager>().get_active_name().await;
    let state_opt = {
        let map = ACTIVE_WORKFLOW_EXECUTIONS.read();
        map.get(&(selected, workflow_id.to_string()))
            .or_else(|| {
                map.iter()
                    .find(|((_, id), _)| id == workflow_id)
                    .map(|(_, state)| state)
            })
            .cloned()
    };

    if let Some(state) = state_opt {
        state.cancel.cancel();
        info!("Workflow cancellation requested for: {workflow_id}");

        let mut active_jobs = state.active_job_ids.read().clone();
        let backend = &state.backend;
        let backend_manager = app.state::<BackendManager>();
        active_jobs.extend(
            backend_manager
                .job_cache_for(&backend.name)
                .get_active_jobs()
                .await
                .into_iter()
                .filter(|job| job.workflow_id.as_deref() == Some(workflow_id))
                .map(|job| job.jobid),
        );
        for job_id in active_jobs {
            info!("Stopping active Rclone job {job_id} associated with workflow '{workflow_id}'");
            let remote = backend_manager
                .job_cache_for(&backend.name)
                .get_job(job_id)
                .await
                .map(|j| j.remote_name)
                .unwrap_or_default();
            let _ = crate::rclone::commands::job::stop_job_on_backend(
                app.clone(),
                backend.clone(),
                job_id,
                remote,
            )
            .await;
        }

        cleanup_workflow_resources(app, &state.backend, workflow_id).await;

        Ok(())
    } else {
        warn!("No active execution found for workflow: {workflow_id}");
        Ok(())
    }
}

/// Cleans up any lingering mount or serve resources spawned by the given workflow.
pub(crate) async fn cleanup_workflow_resources(
    app: &AppHandle,
    backend: &Backend,
    workflow_id: &str,
) {
    let backend_manager = app.state::<BackendManager>();
    let mounted = backend_manager
        .remote_cache_for(&backend.name)
        .get_mounted_remotes()
        .await;
    for m in mounted {
        if m.workflow_id.as_deref() == Some(workflow_id) {
            info!(
                "Unmounting mount '{}' spawned by workflow '{workflow_id}'",
                m.mount_point
            );
            let _ = crate::rclone::commands::mount::unmount_remote_on_backend(
                app.clone(),
                backend.clone(),
                m.mount_point,
                m.fs,
            )
            .await;
        }
    }

    let serves = backend_manager
        .remote_cache_for(&backend.name)
        .get_serves()
        .await;
    for s in serves {
        if s.workflow_id.as_deref() == Some(workflow_id) {
            info!(
                "Stopping serve '{}' spawned by workflow '{workflow_id}'",
                s.id
            );
            let remote_name = s
                .params
                .get("fs")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let _ = crate::rclone::commands::serve::stop_serve_on_backend(
                app.clone(),
                backend.clone(),
                s.id,
                remote_name,
            )
            .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::Arc;

    use parking_lot::RwLock;

    use crate::rclone::backend::types::Backend;
    use crate::services::flow::workflow::engine::cancel::CancelToken;

    use super::*;

    fn active_state() -> ActiveWorkflowState {
        ActiveWorkflowState {
            backend: Backend::new_local("Local"),
            cancel: CancelToken::new(),
            active_job_ids: Arc::new(RwLock::new(HashSet::new())),
        }
    }

    #[test]
    fn a_workflow_can_only_run_once_at_a_time() {
        let id = "single-slot-test";
        let first = register_active_run("Backup", id, active_state()).unwrap();
        let refused = register_active_run("Backup", id, active_state())
            .err()
            .unwrap();
        assert!(refused.contains("backendErrors.automation.workflowAlreadyRunning"));
        assert!(refused.contains("Backup"));
        assert!(is_workflow_active("Local", id));

        drop(first);
        assert!(!is_workflow_active("Local", id));
        drop(register_active_run("Backup", id, active_state()).unwrap());
    }
}
