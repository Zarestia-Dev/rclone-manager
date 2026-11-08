//! Starting workflows when a job finishes (`job_event` triggers).

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use log::{info, warn};
use serde_json::Value;

use crate::context::AppHandle;
use crate::rclone::backend::BackendManager;
use crate::services::flow::workflow::engine::{
    RunTrigger, active::is_workflow_active, run::execute_workflow,
};
use crate::services::flow::workflow::types::{NodeKind, WorkflowDefinition};
use crate::services::settings::AppSettingsManager;
use crate::utils::types::jobs::JobStatus;
use crate::utils::types::starter::{self, Starter, WorkflowRun};

/// Identifies one job run: rclone numbers jobs per process, so after a restart
/// the same id belongs to a different job with a different start time.
type JobRunKey = (String, u64, DateTime<Utc>);

/// Jobs already offered to `job_event` triggers. The oldest are forgotten first.
#[derive(Default)]
struct RecentJobs {
    order: VecDeque<JobRunKey>,
    seen: HashSet<JobRunKey>,
}

impl RecentJobs {
    const CAPACITY: usize = 2000;

    fn contains(&self, key: &JobRunKey) -> bool {
        self.seen.contains(key)
    }

    /// Returns `false` when the job was already recorded.
    fn insert(&mut self, key: JobRunKey) -> bool {
        if !self.seen.insert(key.clone()) {
            return false;
        }
        self.order.push_back(key);
        if self.order.len() > Self::CAPACITY
            && let Some(oldest) = self.order.pop_front()
        {
            self.seen.remove(&oldest);
        }
        true
    }
}

static TRIGGERED_JOB_FINISH_EVENTS: std::sync::LazyLock<parking_lot::Mutex<RecentJobs>> =
    std::sync::LazyLock::new(|| parking_lot::Mutex::new(RecentJobs::default()));

/// The workflows a job leads back to: the ones before it and the one that started it.
fn job_lineage(job: &crate::utils::types::jobs::JobInfo) -> Vec<String> {
    starter::workflow_run(job.starter.as_ref()).map_or_else(Vec::new, WorkflowRun::lineage)
}

/// Helper function that checks whether a `job_event` node configuration matches a finished job.
#[must_use]
pub fn job_event_matches_job(
    node_config: &Value,
    job: &crate::utils::types::jobs::JobInfo,
) -> bool {
    let target = node_config
        .get("targetProfileId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();

    // Empty target means no profile configured to monitor
    if target.is_empty() {
        return false;
    }

    let event_state = node_config
        .get("eventState")
        .and_then(Value::as_str)
        .unwrap_or("any");

    let state_matches = match event_state {
        "success" => job.status == JobStatus::Completed,
        "failed" => job.status == JobStatus::Failed,
        _ => true,
    };

    if !state_matches {
        return false;
    }

    // The profile or the Quick Run that started the job (a name compares case-insensitively),
    // or the remote it ran on.
    let starter_matches = match &job.starter {
        Some(Starter::Profile { name }) => name.eq_ignore_ascii_case(target),
        Some(Starter::QuickRun { id, name, .. }) => {
            id == target || name.eq_ignore_ascii_case(target)
        }
        Some(Starter::Workflow(_)) | None => false,
    };

    starter_matches || job.remote_name.eq_ignore_ascii_case(target)
}

/// Workflows that could react to a finished job.
fn live_event_inputs(
    app: &AppHandle,
    manager: &AppSettingsManager,
) -> Result<Arc<Vec<WorkflowDefinition>>, String> {
    let load = || crate::services::flow::workflow::commands::get_all_workflows(manager);
    match app.try_state::<crate::services::automation::runtime::RuntimeTasks>() {
        Some(runtime) => runtime.event_triggers(load),
        None => Ok(Arc::new(
            load()?
                .into_iter()
                .filter(WorkflowDefinition::has_job_event_trigger)
                .collect(),
        )),
    }
}

/// Evaluates all registered workflows and executes those matching a completed job event.
pub async fn trigger_workflows_for_job_finish(
    app: &AppHandle,
    job: &crate::utils::types::jobs::JobInfo,
) {
    if !job.status.is_finished() {
        return;
    }

    // A simulated job changed nothing, so it has nothing to react to.
    if job.dry_run {
        return;
    }

    // Workflows are stored per backend and only the selected backend's can be read,
    // so jobs of the others start none (their schedules are suspended the same way).
    if job.backend_name != app.state::<BackendManager>().get_active_name().await {
        return;
    }

    let job_key = (job.backend_name.clone(), job.jobid, job.start_time);
    if TRIGGERED_JOB_FINISH_EVENTS.lock().contains(&job_key) {
        return;
    }

    let manager = app.state::<AppSettingsManager>();
    let live = if manager.is_locked() {
        None
    } else {
        Some(live_event_inputs(app, &manager))
    };
    // A lock that begins while storage is read is treated like one that was already active.
    let (workflows, snapshots) = match live {
        Some(Ok(workflows)) if !manager.is_locked() => (Some(workflows), Vec::new()),
        Some(Err(error)) if !manager.is_locked() => {
            warn!("Failed to prepare workflow job event: {error}");
            return;
        }
        _ => {
            let Some(runtime) =
                app.try_state::<crate::services::automation::runtime::RuntimeTasks>()
            else {
                return;
            };
            (None, runtime.event_workflows())
        }
    };
    // Mark processed only after inputs were obtained, atomically with other listeners.
    if !TRIGGERED_JOB_FINISH_EVENTS.lock().insert(job_key) {
        return;
    }

    let lineage = job_lineage(job);
    for wf in workflows
        .as_deref()
        .into_iter()
        .flatten()
        .chain(snapshots.iter().map(|snapshot| &snapshot.definition))
    {
        // A workflow does not react to jobs it led to, directly or through others.
        if lineage.contains(&wf.id) {
            continue;
        }

        // Skip if workflow is already actively executing
        if is_workflow_active(&job.backend_name, &wf.id) {
            continue;
        }

        let node_ids: HashSet<String> = wf
            .nodes
            .iter()
            .filter(|node| {
                node.kind() == NodeKind::JobEvent && job_event_matches_job(&node.config, job)
            })
            .map(|node| node.id.clone())
            .collect();

        if !node_ids.is_empty() {
            info!(
                "🎯 Job {} finished (status: {:?}), auto-triggering workflow '{}' ({}) via job_event",
                job.jobid, job.status, wf.name, wf.id
            );
            let app_clone = app.clone();
            let wf_id = wf.id.clone();
            let Some(backend) = app.state::<BackendManager>().get(&job.backend_name).await else {
                continue;
            };
            let trigger = RunTrigger::JobEvent {
                node_ids,
                ancestors: lineage.clone(),
            };
            crate::utils::spawn(async move {
                if let Err(e) =
                    execute_workflow(app_clone, backend, wf_id.clone(), false, trigger).await
                {
                    log::error!("Failed to execute workflow '{wf_id}' triggered by job event: {e}");
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {

    use chrono::{DateTime, Utc};

    use serde_json::json;

    use super::*;

    use crate::utils::types::jobs::{JobInfo, JobStatus};

    fn finished_job(workflow_id: Option<&str>, dry_run: bool) -> JobInfo {
        JobInfo {
            jobid: 7,
            end_time: Some(Utc::now()),
            status: JobStatus::Completed,
            backend_name: "lineage-test".into(),
            dry_run,
            starter: workflow_id
                .map(|id| Starter::Workflow(WorkflowRun::new(id, "Workflow", "node", vec![]))),
            ..JobInfo::for_test()
        }
    }

    #[test]
    fn a_job_leads_back_to_the_workflows_before_it() {
        let mut job = finished_job(Some("b"), false);
        job.starter = Some(Starter::Workflow(WorkflowRun::new(
            "b",
            "Workflow",
            "n",
            vec!["a".into()],
        )));
        assert_eq!(job_lineage(&job), ["a", "b"]);

        // A job no ancestors led to still leads back to the workflow that started it.
        assert_eq!(job_lineage(&finished_job(Some("b"), false)), ["b"]);
        assert!(job_lineage(&finished_job(None, false)).is_empty());
    }

    #[test]
    fn test_job_event_matches_job_cases() {
        use crate::utils::types::jobs::JobInfo;

        let mock_job = |status: JobStatus, starter: Option<Starter>, remote: &str| JobInfo {
            jobid: 101,
            remote_name: remote.to_string(),
            source: vec!["src".to_string()],
            destination: "dst".to_string(),
            end_time: Some(Utc::now()),
            status,
            group: "test-group".to_string(),
            starter,
            backend_name: "local".to_string(),
            ..JobInfo::for_test()
        };

        // 1. Matches profile with eventState 'any'
        let job1 = mock_job(
            JobStatus::Completed,
            Some(Starter::profile("daily-backup")),
            "remote1:",
        );
        let cfg1 = json!({ "targetProfileId": "daily-backup", "eventState": "any" });
        assert!(job_event_matches_job(&cfg1, &job1));

        // 2. Case-insensitive profile match
        let cfg1_case = json!({ "targetProfileId": "Daily-Backup", "eventState": "any" });
        assert!(job_event_matches_job(&cfg1_case, &job1));

        // 3. Status filter: 'success' matches Completed, rejects Failed
        let cfg_success = json!({ "targetProfileId": "daily-backup", "eventState": "success" });
        assert!(job_event_matches_job(&cfg_success, &job1));

        let job_failed = mock_job(
            JobStatus::Failed,
            Some(Starter::profile("daily-backup")),
            "remote1:",
        );
        assert!(!job_event_matches_job(&cfg_success, &job_failed));

        // 4. Status filter: 'failed' matches Failed, rejects Completed
        let cfg_failed = json!({ "targetProfileId": "daily-backup", "eventState": "failed" });
        assert!(job_event_matches_job(&cfg_failed, &job_failed));
        assert!(!job_event_matches_job(&cfg_failed, &job1));

        // 5. Matches Quick Run by ID
        let job_qr = mock_job(
            JobStatus::Completed,
            Some(Starter::quick_run("qr-1", "Nightly Sync", None)),
            "remote1:",
        );
        let cfg_qr_id = json!({ "targetProfileId": "qr-1", "eventState": "any" });
        assert!(job_event_matches_job(&cfg_qr_id, &job_qr));

        // 6. Matches Quick Run by Name
        let cfg_qr_name = json!({ "targetProfileId": "Nightly Sync", "eventState": "any" });
        assert!(job_event_matches_job(&cfg_qr_name, &job_qr));

        // A profile job is not a Quick Run: the id of a preset never matches it.
        let cfg_other_id = json!({ "targetProfileId": "qr-1", "eventState": "any" });
        assert!(!job_event_matches_job(&cfg_other_id, &job1));

        // 7. Matches Remote name
        let cfg_remote = json!({ "targetProfileId": "remote1:", "eventState": "any" });
        assert!(job_event_matches_job(&cfg_remote, &job1));

        // 8. Empty targetProfileId should never match
        let cfg_empty = json!({ "targetProfileId": "", "eventState": "any" });
        assert!(!job_event_matches_job(&cfg_empty, &job1));

        // 9. Mismatched profile
        let cfg_mismatch = json!({ "targetProfileId": "other-profile", "eventState": "any" });
        assert!(!job_event_matches_job(&cfg_mismatch, &job1));
    }

    #[test]
    fn job_event_dedup_distinguishes_restarted_jobs_and_forgets_oldest_first() {
        let at = |seconds: i64| DateTime::<Utc>::from_timestamp(seconds, 0).unwrap();
        let mut recent = RecentJobs::default();
        assert!(recent.insert(("Local".into(), 1, at(100))));
        assert!(!recent.insert(("Local".into(), 1, at(100))));
        // rclone restarted: job 1 is a different job now.
        assert!(recent.insert(("Local".into(), 1, at(900))));
        assert!(recent.insert(("NAS".into(), 1, at(100))));

        // Three entries exist; one more than the capacity forces a single eviction.
        let last = RecentJobs::CAPACITY as u64 - 1;
        for id in 2..=last {
            recent.insert(("Local".into(), id, at(1000)));
        }
        assert!(!recent.contains(&("Local".into(), 1, at(100))));
        assert!(recent.contains(&("Local".into(), 1, at(900))));
        assert!(recent.contains(&("NAS".into(), 1, at(100))));
        assert!(recent.contains(&("Local".into(), last, at(1000))));
        assert_eq!(recent.seen.len(), RecentJobs::CAPACITY);
        assert_eq!(recent.order.len(), RecentJobs::CAPACITY);
    }

    #[tokio::test]
    async fn only_jobs_of_the_selected_backend_can_start_workflows() {
        use crate::utils::types::jobs::JobInfo;
        let directory = tempfile::tempdir().unwrap();
        let settings: AppSettingsManager = rcman::SettingsManager::builder("trigger-test", "1")
            .with_config_dir(directory.path())
            .with_schema::<crate::services::settings::schema::AppSettings>()
            .with_sub_settings(rcman::SubSettingsConfig::singlefile(
                crate::utils::constants::SUB_WORKFLOWS,
            ))
            .with_sub_settings(rcman::SubSettingsConfig::singlefile(
                crate::utils::constants::SUB_QUICK_RUNS,
            ))
            .build()
            .unwrap();
        let app = AppHandle::default();
        app.manage(settings);
        app.manage(BackendManager::new());
        let selected = app.state::<BackendManager>().get_active_name().await;
        let finished = |backend: &str| JobInfo {
            jobid: 4242,
            source: vec!["src".into()],
            destination: "dst".into(),
            start_time: DateTime::<Utc>::from_timestamp(1_700_000_000, 0).unwrap(),
            status: JobStatus::Completed,
            backend_name: backend.into(),
            ..JobInfo::for_test()
        };
        let seen = |job: &JobInfo| {
            TRIGGERED_JOB_FINISH_EVENTS.lock().contains(&(
                job.backend_name.clone(),
                job.jobid,
                job.start_time,
            ))
        };

        let elsewhere = finished("Elsewhere-backend");
        trigger_workflows_for_job_finish(&app, &elsewhere).await;
        assert!(
            !seen(&elsewhere),
            "a job of another backend must be ignored"
        );

        let here = finished(&selected);
        trigger_workflows_for_job_finish(&app, &here).await;
        assert!(
            seen(&here),
            "a job of the selected backend is processed once"
        );
    }
}
