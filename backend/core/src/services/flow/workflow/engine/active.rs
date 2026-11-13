//! Which workflows are running, and stopping them.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use log::{info, warn};
use parking_lot::RwLock;
use serde_json::Value;

use crate::context::AppHandle;
use crate::rclone::backend::{BackendManager, types::Backend};
use crate::services::flow::workflow::engine::cancel::CancelToken;
use crate::services::flow::workflow::engine::record::{RunHandle, WorkflowRunSnapshot};
use crate::utils::types::starter;

/// What stops a running workflow.
#[derive(Clone)]
pub(crate) struct ActiveWorkflowState {
    pub(crate) backend: Backend,
    pub(crate) cancel: CancelToken,
    pub(crate) active_job_ids: Arc<RwLock<HashSet<u64>>>,
}

/// A run is identified by its backend and workflow id: each backend has its own
/// workflows, and copying them to another backend keeps their ids.
type RunKey = (String, String);

/// A workflow's latest run. `control` is there while the run holds the workflow's
/// slot; the record stays after it ends, so a view opened later still sees how it went.
struct RegisteredRun {
    control: Option<ActiveWorkflowState>,
    handle: Arc<RunHandle>,
}

static RUNS: std::sync::LazyLock<RwLock<HashMap<RunKey, RegisteredRun>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

/// Holds a workflow's run slot until the run ends. A run that leaves without reporting
/// its end (an early return, a panic) is reported as failed, so no view keeps waiting for it.
pub(crate) struct ActiveRunGuard {
    key: RunKey,
    handle: Arc<RunHandle>,
    released: bool,
}

impl ActiveRunGuard {
    /// Frees the slot. The run has reported or will report its end itself.
    pub(crate) fn release(mut self) {
        self.released = true;
        self.free_slot();
    }

    fn free_slot(&self) {
        if let Some(run) = RUNS.write().get_mut(&self.key)
            && Arc::ptr_eq(&run.handle, &self.handle)
        {
            run.control = None;
        }
    }
}

impl Drop for ActiveRunGuard {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        self.free_slot();
        if self.handle.is_live() {
            self.handle.abort();
        }
    }
}

/// Claims the single run slot a workflow has on its backend. Two overlapping runs
/// would share one cancellation and tracking entry, so the second is refused.
pub(crate) fn register_active_run(
    workflow_name: &str,
    workflow_id: &str,
    state: ActiveWorkflowState,
    handle: Arc<RunHandle>,
) -> Result<ActiveRunGuard, String> {
    let key = (state.backend.name.clone(), workflow_id.to_string());
    let mut runs = RUNS.write();
    if runs.get(&key).is_some_and(|run| run.control.is_some()) {
        return Err(crate::localized_error!(
            "backendErrors.automation.workflowAlreadyRunning",
            "name" => workflow_name
        ));
    }
    runs.insert(
        key.clone(),
        RegisteredRun {
            control: Some(state),
            handle: handle.clone(),
        },
    );
    Ok(ActiveRunGuard {
        key,
        handle,
        released: false,
    })
}

/// Keeps a run that never got a slot (one refused by validation) as the workflow's latest, so
/// a view told about it can read what happened. A run that holds the slot is left alone.
pub(crate) fn remember_refused_run(backend: &str, workflow_id: &str, handle: Arc<RunHandle>) {
    let mut runs = RUNS.write();
    let key = (backend.to_string(), workflow_id.to_string());
    if runs.get(&key).is_none_or(|run| run.control.is_none()) {
        runs.insert(
            key,
            RegisteredRun {
                control: None,
                handle,
            },
        );
    }
}

/// Whether `workflow_id` is running on `backend`.
#[must_use]
pub fn is_workflow_active(backend: &str, workflow_id: &str) -> bool {
    RUNS.read()
        .get(&(backend.to_string(), workflow_id.to_string()))
        .is_some_and(|run| run.control.is_some())
}

/// IDs of the workflows currently running on `backend`.
#[must_use]
pub fn get_active_workflow_ids(backend: &str) -> HashSet<String> {
    RUNS.read()
        .iter()
        .filter(|((running_on, _), run)| running_on == backend && run.control.is_some())
        .map(|((_, id), _)| id.clone())
        .collect()
}

#[must_use]
pub fn has_active_workflows() -> bool {
    RUNS.read().values().any(|run| run.control.is_some())
}

/// The latest run of every workflow on `backend`: those under way and the last one
/// that ended. A view that opens late (or after a reload) starts from these.
#[must_use]
pub fn run_snapshots(backend: &str) -> Vec<WorkflowRunSnapshot> {
    let mut snapshots: Vec<_> = RUNS
        .read()
        .iter()
        .filter(|((on, _), _)| on == backend)
        .map(|(_, run)| run.handle.snapshot())
        .collect();
    snapshots.sort_by(|a, b| a.workflow_id.cmp(&b.workflow_id));
    snapshots
}

/// Forgets the runs of a workflow that no longer exists. Runs still under way keep their slot.
pub fn forget_workflow_runs(workflow_id: &str) {
    RUNS.write()
        .retain(|(_, id), run| id != workflow_id || run.control.is_some());
}

/// Halts an actively executing workflow and terminates any underlying Rclone transfer jobs.
///
/// The run on the selected backend is stopped; a run of the same id on another
/// backend is only stopped when none is running on the selected one.
pub async fn stop_workflow(app: &AppHandle, workflow_id: &str) -> Result<(), String> {
    let selected = app.state::<BackendManager>().get_active_name().await;
    let state_opt = {
        let map = RUNS.read();
        // The run id tells cleanup which mounts and serves this run started, not an earlier one.
        let live = |run: &RegisteredRun| {
            run.control
                .clone()
                .map(|control| (control, run.handle.run_id().to_string()))
        };
        map.get(&(selected, workflow_id.to_string()))
            .and_then(live)
            .or_else(|| {
                map.iter()
                    .filter(|((_, id), _)| id == workflow_id)
                    .find_map(|(_, run)| live(run))
            })
    };

    if let Some((state, run_id)) = state_opt {
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
                .filter(|job| starter::workflow_id(job.starter.as_ref()) == Some(workflow_id))
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

        cleanup_workflow_resources(app, &state.backend, workflow_id, &run_id).await;

        Ok(())
    } else {
        warn!("No active execution found for workflow: {workflow_id}");
        Ok(())
    }
}

/// Cleans up the mount and serve resources the given run of a workflow started.
/// Those of earlier runs are left as they are.
pub(crate) async fn cleanup_workflow_resources(
    app: &AppHandle,
    backend: &Backend,
    workflow_id: &str,
    run_id: &str,
) {
    let backend_manager = app.state::<BackendManager>();
    let mounted = backend_manager
        .remote_cache_for(&backend.name)
        .get_mounted_remotes()
        .await;
    for m in mounted {
        if starter::workflow_id(m.starter.as_ref()) == Some(workflow_id)
            && m.execute_id.as_deref() == Some(run_id)
        {
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
        if starter::workflow_id(s.starter.as_ref()) == Some(workflow_id)
            && s.execute_id.as_deref() == Some(run_id)
        {
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
    use crate::services::flow::workflow::types::{
        WorkflowExecutionState, WorkflowNodeExecutionState,
    };

    use super::*;

    fn active_state() -> ActiveWorkflowState {
        ActiveWorkflowState {
            backend: Backend::new_local("Local"),
            cancel: CancelToken::new(),
            active_job_ids: Arc::new(RwLock::new(HashSet::new())),
        }
    }

    fn handle(workflow_id: &str) -> Arc<RunHandle> {
        Arc::new(RunHandle::new(workflow_id, "test-run", false))
    }

    #[test]
    fn a_workflow_can_only_run_once_at_a_time() {
        let id = "single-slot-test";
        let first = register_active_run("Backup", id, active_state(), handle(id)).unwrap();
        let refused = register_active_run("Backup", id, active_state(), handle(id))
            .err()
            .unwrap();
        assert!(refused.contains("backendErrors.automation.workflowAlreadyRunning"));
        assert!(refused.contains("Backup"));
        assert!(is_workflow_active("Local", id));

        first.release();
        assert!(!is_workflow_active("Local", id));
        register_active_run("Backup", id, active_state(), handle(id))
            .unwrap()
            .release();
    }

    #[test]
    fn a_run_that_leaves_without_an_end_is_reported_as_failed() {
        let id = "dropped-run-test";
        let run = handle(id);
        let guard = register_active_run("Backup", id, active_state(), run.clone()).unwrap();
        run.node_state(
            "busy",
            WorkflowNodeExecutionState::Running,
            None,
            None,
            None,
        );
        drop(guard);
        assert!(!is_workflow_active("Local", id));
        assert!(!run.is_live());
        let snapshot = run.snapshot();
        assert_eq!(snapshot.state, WorkflowExecutionState::Failed);
        assert_eq!(
            snapshot.nodes["busy"].state,
            WorkflowNodeExecutionState::Failed
        );
    }

    #[test]
    fn a_released_run_keeps_the_state_it_reported() {
        let id = "released-run-test";
        let run = handle(id);
        let guard = register_active_run("Backup", id, active_state(), run.clone()).unwrap();
        run.execution(WorkflowExecutionState::Completed, None, None);
        guard.release();
        let snapshot = run_snapshots("Local")
            .into_iter()
            .find(|s| s.workflow_id == id)
            .expect("the last run is kept");
        assert_eq!(snapshot.state, WorkflowExecutionState::Completed);
        assert!(!is_workflow_active("Local", id));
    }

    #[test]
    fn a_refused_run_is_remembered_unless_the_workflow_is_running() {
        let id = "refused-run-test";
        let refused = Arc::new(RunHandle::new(id, "refused", false));
        remember_refused_run("Local", id, refused);
        let latest = |id: &str| {
            run_snapshots("Local")
                .into_iter()
                .find(|s| s.workflow_id == id)
                .map(|s| s.run_id)
        };
        assert_eq!(latest(id).as_deref(), Some("refused"));
        assert!(!is_workflow_active("Local", id));

        let guard = register_active_run("Backup", id, active_state(), handle(id)).unwrap();
        remember_refused_run("Local", id, Arc::new(RunHandle::new(id, "again", false)));
        assert_eq!(latest(id).as_deref(), Some("test-run"));
        assert!(is_workflow_active("Local", id));
        guard.release();
    }

    #[test]
    fn a_new_run_replaces_the_last_one_and_forgetting_drops_only_finished_runs() {
        let id = "replace-run-test";
        let first = Arc::new(RunHandle::new(id, "run-1", false));
        register_active_run("Backup", id, active_state(), first.clone())
            .unwrap()
            .release();
        let second = Arc::new(RunHandle::new(id, "run-2", false));
        let guard = register_active_run("Backup", id, active_state(), second).unwrap();
        let current = |id: &str| {
            run_snapshots("Local")
                .into_iter()
                .find(|s| s.workflow_id == id)
                .map(|s| s.run_id)
        };
        assert_eq!(current(id).as_deref(), Some("run-2"));

        forget_workflow_runs(id);
        assert_eq!(current(id).as_deref(), Some("run-2"), "a live run stays");

        guard.release();
        forget_workflow_runs(id);
        assert_eq!(current(id), None);
    }
}
