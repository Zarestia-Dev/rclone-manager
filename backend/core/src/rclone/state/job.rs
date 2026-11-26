use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::context::AppHandle;
use log::info;
use serde_json::Value;
use tokio::sync::RwLock;

use super::job_report::report_counts;
use super::job_resolver::{link_resolving_jobs, sanitize_finished_stats};
use super::job_stats::normalize_job_stats;
use crate::utils::types::{
    events::{JOB_CACHE_CHANGED, JOB_STATS_UPDATED, JobChangeEvent, JobStatsUpdatedEvent},
    jobs::{JobCache, JobInfo, JobProgress, JobStatus, JobType},
    starter,
};

pub fn spawn_stats_cleanup_by_group(
    transport: std::sync::Arc<dyn crate::rclone::backend::RcloneTransport>,
    group: &str,
) {
    if group.is_empty() {
        return;
    }
    let group = group.to_string();

    crate::utils::spawn(async move {
        let _ = transport
            .rpc(
                crate::rclone::endpoints::core::STATS_DELETE,
                Some(&serde_json::json!({ "group": group })),
            )
            .await;
    });
}

fn preserve_completed_history(stats: &mut Value, previous: Option<&Value>) {
    if let Some(stats) = stats.as_object_mut()
        && !stats.contains_key("completed")
        && let Some(history) = previous
            .and_then(|previous| previous.get("completed"))
            .filter(|history| history.is_array())
    {
        stats.insert("completed".into(), history.clone());
    }
}

/// Finished jobs kept per backend. Jobs live in memory with their stats and reports,
/// so the oldest finished ones are dropped past this many.
pub const MAX_FINISHED_JOBS: usize = 1000;

/// What the cache knows about the jobs of one profile, see [`JobCache::job_activity`].
#[derive(Debug, Default, PartialEq, Eq)]
pub struct JobActivity {
    pub running: bool,
    pub last_finished: Option<chrono::DateTime<chrono::Utc>>,
}

impl JobCache {
    #[must_use]
    pub fn new() -> Self {
        Self {
            jobs: RwLock::new(HashMap::new()),
            own_jobs: parking_lot::Mutex::new(HashMap::new()),
            changed: tokio::sync::Notify::new(),
        }
    }

    /// Stops a job this process carries out itself and waits until it has stopped; false for
    /// any other job.
    pub(crate) async fn cancel_own_job(&self, jobid: u64) -> Result<bool, String> {
        let job = self.own_jobs.lock().get(&jobid).cloned();
        let Some(mut job) = job else {
            return Ok(false);
        };
        job.token.cancel();
        loop {
            if let Some(result) = job.result.borrow_and_update().clone() {
                return result.map(|()| true);
            }
            job.result
                .changed()
                .await
                .map_err(|_| crate::localized_error!("backendErrors.job.failed"))?;
        }
    }

    /// Registers a new job with the cache, with the request a retry would send again, if any.
    pub async fn create_job(
        &self,
        jobid: u64,
        metadata: crate::rclone::commands::job::JobMetadata,
        backend_name: String,
        request: Option<Arc<crate::rclone::commands::job::JobRequest>>,
    ) {
        let group = metadata.group_name();
        let exec_id = metadata
            .execute_id
            .clone()
            .or_else(|| Some(uuid::Uuid::new_v4().to_string()));
        let job = JobInfo {
            stats_revision: 0,
            jobid,
            job_type: metadata.job_type,
            remote_name: metadata.remote_name,
            source: metadata.source,
            destination: metadata.destination,
            start_time: chrono::Utc::now(),
            end_time: None,
            status: JobStatus::Running,
            error: None,
            stats: None,
            group,
            starter: metadata.starter,
            execute_id: exec_id,
            origin: metadata.origin,
            backend_name,
            dry_run: metadata.dry_run,
            parent_job_id: metadata.parent_job_id,
            transfer_options: metadata.transfer_options,

            report: None,
            report_counts: None,
            request,
            failed_files: None,
        };

        self.add_job(job).await;
    }

    pub async fn add_job(&self, job: JobInfo) {
        let jobid = job.jobid;
        let parent_id = job.parent_job_id;
        let event = JobChangeEvent::changed(&job, false);
        {
            let mut jobs = self.jobs.write().await;
            jobs.insert(jobid, job);
            if let Some(p_id) = parent_id {
                link_resolving_jobs(&mut jobs, p_id);
            }
        }
        crate::services::bridge::emit(JOB_CACHE_CHANGED, event);
    }

    /// The reports of a finished sync, copy or move job, if it kept any.
    pub async fn get_job_report(&self, jobid: u64) -> Option<Arc<Value>> {
        self.jobs.read().await.get(&jobid)?.report.clone()
    }

    pub async fn delete_job(&self, jobid: u64, app: Option<&AppHandle>) -> Result<(), String> {
        let mut ids_to_delete = vec![jobid];
        let mut seen = HashSet::from([jobid]);
        let mut index = 0;

        let mut jobs = self.jobs.write().await;
        let mut children_by_parent: HashMap<u64, Vec<u64>> = HashMap::new();
        for job in jobs.values() {
            if let Some(parent_id) = job.parent_job_id {
                children_by_parent
                    .entry(parent_id)
                    .or_default()
                    .push(job.jobid);
            }
        }

        while index < ids_to_delete.len() {
            let current_id = ids_to_delete[index];
            index += 1;

            if let Some(children) = children_by_parent.remove(&current_id) {
                for child_id in children {
                    if seen.insert(child_id) {
                        ids_to_delete.push(child_id);
                    }
                }
            }
        }

        drop(children_by_parent);
        let removed_jobs: Vec<JobInfo> = ids_to_delete
            .iter()
            .filter_map(|id| jobs.remove(id))
            .collect();
        let relinked = relink_parents(&mut jobs, &removed_jobs);

        let remaining_groups: HashSet<String> = jobs.values().map(|j| j.group.clone()).collect();

        drop(jobs);

        if removed_jobs.is_empty() {
            log::warn!("Attempted to delete job {jobid}, but it was not found in cache");
            return Err(crate::localized_error!("backendErrors.job.notFound"));
        }

        self.announce_removed(removed_jobs, relinked, &remaining_groups, app)
            .await;
        Ok(())
    }

    async fn update_job_for_execution(
        &self,
        jobid: u64,
        execute_id: Option<&str>,
        update_fn: impl FnOnce(&mut JobInfo),
    ) -> Result<JobStatus, String> {
        let mut jobs = self.jobs.write().await;
        let job = jobs
            .get_mut(&jobid)
            .filter(|job| execute_id.is_none_or(|id| job.execute_id.as_deref() == Some(id)))
            .ok_or_else(|| crate::localized_error!("backendErrors.job.notFound"))?;

        let was_running = job.status.is_running();
        update_fn(job);
        job.stats_revision += 1;
        let ended = was_running && job.status.is_finished();

        let parent_id = job.parent_job_id;
        let parent_change = if let Some(p_id) = parent_id
            && link_resolving_jobs(&mut jobs, p_id)
        {
            jobs.get(&p_id)
                .map(|parent| JobChangeEvent::changed(parent, false))
        } else {
            None
        };
        link_resolving_jobs(&mut jobs, jobid);
        let event = JobChangeEvent::changed(&jobs[&jobid], ended);
        let status = jobs[&jobid].status.clone();

        drop(jobs);
        self.changed.notify_waiters();

        if let Some(parent_event) = parent_change {
            crate::services::bridge::emit(JOB_CACHE_CHANGED, parent_event);
        }
        crate::services::bridge::emit(JOB_CACHE_CHANGED, event);

        Ok(status)
    }

    pub async fn update_job_stats(&self, jobid: u64, stats: Value) -> Result<(), String> {
        self.update_job_stats_for_execution(jobid, None, stats)
            .await
    }

    pub(crate) async fn update_job_stats_for_execution(
        &self,
        jobid: u64,
        execute_id: Option<&str>,
        mut stats: Value,
    ) -> Result<(), String> {
        let mut jobs = self.jobs.write().await;
        let job = jobs
            .get_mut(&jobid)
            .filter(|job| execute_id.is_none_or(|id| job.execute_id.as_deref() == Some(id)))
            .ok_or_else(|| crate::localized_error!("backendErrors.job.notFound"))?;

        if job.status.is_finished() {
            sanitize_finished_stats(&mut stats);
        }
        preserve_completed_history(&mut stats, job.stats.as_ref());
        job.stats = Some(stats);
        normalize_job_stats(job);
        job.stats_revision += 1;

        let parent_id = job.parent_job_id;
        let parent_update = if let Some(p_id) = parent_id
            && link_resolving_jobs(&mut jobs, p_id)
        {
            jobs.get(&p_id).map(JobStatsUpdatedEvent::from)
        } else {
            None
        };
        link_resolving_jobs(&mut jobs, jobid);
        let update = JobStatsUpdatedEvent::from(&jobs[&jobid]);

        drop(jobs);

        if let Some(parent_update) = parent_update {
            crate::services::bridge::emit(JOB_STATS_UPDATED, parent_update);
        }
        crate::services::bridge::emit(JOB_STATS_UPDATED, update);

        Ok(())
    }

    pub async fn complete_job(
        &self,
        jobid: u64,
        success: bool,
        error: Option<String>,
    ) -> Result<JobStatus, String> {
        self.complete_job_for_execution(jobid, None, success, error, None, None)
            .await
    }

    pub(crate) async fn complete_job_for_execution(
        &self,
        jobid: u64,
        execute_id: Option<&str>,
        success: bool,
        error: Option<String>,
        final_stats: Option<Value>,
        report: Option<Value>,
    ) -> Result<JobStatus, String> {
        self.update_job_for_execution(jobid, execute_id, |j| {
            if let Some(report) = report {
                j.report_counts = Some(report_counts(&report));
                j.report = Some(Arc::new(report));
            }
            if j.status.is_finished() && final_stats.is_none() {
                return;
            }
            if !j.status.is_finished() {
                j.status = if success {
                    JobStatus::Completed
                } else {
                    JobStatus::Failed
                };
                j.error = error;
                j.end_time = Some(chrono::Utc::now());
                // A job that succeeded has nothing to retry; drop its request from memory.
                if success {
                    j.request = None;
                }
            }
            if let Some(mut stats) = final_stats {
                preserve_completed_history(&mut stats, j.stats.as_ref());
                j.stats = Some(stats);
            }
            if let Some(stats) = j.stats.as_mut() {
                sanitize_finished_stats(stats);
            }
            normalize_job_stats(j);
        })
        .await
    }

    /// After a job failed with `output`, keeps only the parts of its request a retry has to send.
    pub(crate) async fn narrow_retry_request(
        &self,
        jobid: u64,
        execute_id: Option<&str>,
        output: &Value,
    ) -> Result<JobStatus, String> {
        self.update_job_for_execution(jobid, execute_id, |j| {
            j.request = j
                .request
                .take()
                .map(|request| Arc::new(request.after_failure(output)));
        })
        .await
    }

    pub async fn stop_job(&self, jobid: u64) -> Result<(), String> {
        self.update_job_for_execution(jobid, None, |j| {
            if !j.status.is_finished() {
                j.status = JobStatus::Stopped;
                j.end_time = Some(chrono::Utc::now());
                if let Some(stats) = j.stats.as_mut() {
                    sanitize_finished_stats(stats);
                }
                normalize_job_stats(j);
            }
        })
        .await
        .map(|_| ())
    }

    pub(crate) async fn get_execution_status(
        &self,
        jobid: u64,
        execute_id: Option<&str>,
    ) -> Option<JobStatus> {
        self.jobs
            .read()
            .await
            .get(&jobid)
            .filter(|job| execute_id.is_none_or(|id| job.execute_id.as_deref() == Some(id)))
            .map(|job| job.status.clone())
    }

    pub async fn get_job(&self, jobid: u64) -> Option<JobInfo> {
        self.jobs.read().await.get(&jobid).cloned()
    }

    /// Waits until the job no longer runs: the job as it ended, or `None` once it was removed.
    /// Every change of a job's status wakes it, so it does not poll.
    pub async fn wait_until_finished(&self, jobid: u64) -> Option<JobInfo> {
        loop {
            // Registered before the look, so a job that finishes in between still wakes it.
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            match self.jobs.read().await.get(&jobid) {
                None => return None,
                Some(job) if job.status.is_finished() => return Some(job.clone()),
                Some(_) => {}
            }
            changed.await;
        }
    }

    /// Every job as the job lists carry it ([`JobInfo::summary`]).
    pub async fn get_jobs(&self) -> Vec<JobInfo> {
        self.jobs
            .read()
            .await
            .values()
            .map(JobInfo::summary)
            .collect()
    }

    /// A job's stats with its file rows, if `execute_id` (when given) names its run: rclone
    /// numbers its jobs from 1 again after a restart.
    pub async fn job_stats(&self, jobid: u64, execute_id: Option<&str>) -> Option<Value> {
        self.jobs
            .read()
            .await
            .get(&jobid)
            .filter(|job| execute_id.is_none_or(|id| job.execute_id.as_deref() == Some(id)))?
            .stats
            .clone()
    }

    pub async fn get_active_jobs(&self) -> Vec<JobInfo> {
        self.jobs
            .read()
            .await
            .values()
            .filter(|j| j.status.is_running())
            .cloned()
            .collect()
    }

    pub async fn active_job_count(&self) -> usize {
        self.jobs
            .read()
            .await
            .values()
            .filter(|j| j.status.is_running())
            .count()
    }

    /// The progress of the running jobs, summed.
    pub async fn running_progress(&self) -> JobProgress {
        self.progress_where(|_| true).await
    }

    /// The progress of the running jobs this process carries out itself (an upload streamed to
    /// an rclone on another computer, a file downloaded or opened), summed: they run on this
    /// device, whichever engine they read from or write to.
    pub async fn own_job_progress(&self) -> JobProgress {
        let streamed: HashSet<u64> = self.own_jobs.lock().keys().copied().collect();
        if streamed.is_empty() {
            return JobProgress::default();
        }
        self.progress_where(|job| streamed.contains(&job.jobid))
            .await
    }

    /// Sums the running jobs `include` picks, reading their stats in place.
    async fn progress_where(&self, include: impl Fn(&JobInfo) -> bool) -> JobProgress {
        let mut progress = JobProgress::default();
        for job in self
            .jobs
            .read()
            .await
            .values()
            .filter(|job| job.status.is_running() && include(job))
        {
            let stat = |key: &str| job.stats.as_ref().and_then(|stats| stats.get(key));
            let count = |key: &str| stat(key).and_then(Value::as_u64).unwrap_or(0);
            progress.add(JobProgress {
                jobs: 1,
                bytes: count("bytes"),
                total_bytes: count("totalBytes"),
                speed: stat("speed").and_then(Value::as_f64).unwrap_or(0.0),
                checks: count("checks"),
            });
        }
        progress
    }

    /// Whether a job of this profile runs, and when the last one ended, without copying jobs.
    /// Remote names compare without their trailing colon.
    pub async fn job_activity(
        &self,
        remote_name: &str,
        job_type: &JobType,
        profile: Option<&str>,
    ) -> JobActivity {
        let remote_name = remote_name.trim_end_matches(':');
        let jobs = self.jobs.read().await;
        let mut activity = JobActivity::default();
        for job in jobs.values().filter(|j| {
            j.remote_name.trim_end_matches(':') == remote_name
                && &j.job_type == job_type
                && starter::profile_name(j.starter.as_ref()) == profile
        }) {
            activity.running |= job.status.is_running();
            activity.last_finished = activity.last_finished.max(job.end_time);
        }
        activity
    }

    pub async fn delete_jobs_by_remote(&self, remote_name: &str, app: Option<&AppHandle>) {
        // The file browser names a remote as rclone writes it (`drive:`), a profile without the colon.
        self.delete_matching(|j| j.remote_name.trim_end_matches(':') == remote_name, app)
            .await;
        info!("📡 All jobs for remote {remote_name} deleted");
    }

    pub async fn delete_jobs_by_profile(
        &self,
        remote_name: &str,
        profile_name: &str,
        job_type: &JobType,
        app: Option<&AppHandle>,
    ) {
        self.delete_matching(
            |j| {
                j.remote_name == remote_name
                    && starter::profile_name(j.starter.as_ref()) == Some(profile_name)
                    && &j.job_type == job_type
                    && !j.status.is_running()
            },
            app,
        )
        .await;
        info!("📡 All jobs for profile {profile_name} on remote {remote_name} deleted");
    }

    pub async fn delete_matching(
        &self,
        predicate: impl Fn(&JobInfo) -> bool,
        app: Option<&AppHandle>,
    ) {
        let mut jobs = self.jobs.write().await;
        let to_remove: Vec<u64> = jobs
            .values()
            .filter(|j| predicate(j))
            .map(|j| j.jobid)
            .collect();

        let mut removed_jobs = Vec::with_capacity(to_remove.len());
        for id in to_remove {
            if let Some(job) = jobs.remove(&id) {
                removed_jobs.push(job);
            }
        }

        // Clean up orphaned sub-jobs whose parents were removed
        loop {
            let mut orphaned = Vec::new();
            for job in jobs.values() {
                if job.status.is_finished()
                    && job
                        .parent_job_id
                        .is_some_and(|parent_id| !jobs.contains_key(&parent_id))
                {
                    orphaned.push(job.jobid);
                }
            }
            if orphaned.is_empty() {
                break;
            }
            for id in orphaned {
                if let Some(job) = jobs.remove(&id) {
                    removed_jobs.push(job);
                }
            }
        }

        let relinked = relink_parents(&mut jobs, &removed_jobs);
        let remaining_groups: HashSet<String> = jobs.values().map(|j| j.group.clone()).collect();

        drop(jobs);

        self.announce_removed(removed_jobs, relinked, &remaining_groups, app)
            .await;
    }

    /// Drops the oldest finished jobs beyond [`MAX_FINISHED_JOBS`]. A job with children in
    /// the cache stays until its children are gone, and running jobs never go.
    pub async fn prune_finished(&self, app: Option<&AppHandle>) {
        let mut jobs = self.jobs.write().await;
        let finished = jobs.values().filter(|j| j.status.is_finished()).count();
        if finished <= MAX_FINISHED_JOBS {
            return;
        }
        let parents: HashSet<u64> = jobs.values().filter_map(|j| j.parent_job_id).collect();
        let mut candidates: Vec<_> = jobs
            .values()
            .filter(|j| j.status.is_finished() && !parents.contains(&j.jobid))
            .map(|j| (j.end_time.unwrap_or(j.start_time), j.jobid))
            .collect();
        candidates.sort();
        let removed: Vec<JobInfo> = candidates
            .into_iter()
            .take(finished - MAX_FINISHED_JOBS)
            .filter_map(|(_, id)| jobs.remove(&id))
            .collect();
        let remaining_groups: HashSet<String> = jobs.values().map(|j| j.group.clone()).collect();
        drop(jobs);
        // Only jobs without children go, so no remaining job links to one of them.
        self.announce_removed(removed, Vec::new(), &remaining_groups, app)
            .await;
    }

    /// Drops rclone's stats of the groups no remaining job uses, then announces the removals and
    /// the parents that no longer link to a removed job.
    async fn announce_removed(
        &self,
        removed_jobs: Vec<JobInfo>,
        relinked: Vec<JobChangeEvent>,
        remaining_groups: &HashSet<String>,
        app: Option<&AppHandle>,
    ) {
        if let Some(app) = app {
            for job in &removed_jobs {
                if !job.group.is_empty() && !remaining_groups.contains(&job.group) {
                    cleanup_job_stats(app, job).await;
                }
            }
        }
        if !removed_jobs.is_empty() {
            // A wait for a removed job ends: it can no longer finish.
            self.changed.notify_waiters();
        }
        for job in &removed_jobs {
            crate::services::bridge::emit(JOB_CACHE_CHANGED, JobChangeEvent::removed(job));
        }
        for parent in relinked {
            crate::services::bridge::emit(JOB_CACHE_CHANGED, parent);
        }
    }
}

/// Updates the remaining parents of `removed` jobs, whose rows linked to them, and returns the
/// change of each parent that changed.
fn relink_parents(jobs: &mut HashMap<u64, JobInfo>, removed: &[JobInfo]) -> Vec<JobChangeEvent> {
    let parents: HashSet<u64> = removed.iter().filter_map(|job| job.parent_job_id).collect();
    let mut changed = Vec::new();
    for parent in parents {
        if link_resolving_jobs(jobs, parent) {
            changed.extend(
                jobs.get(&parent)
                    .map(|job| JobChangeEvent::changed(job, false)),
            );
        }
    }
    changed
}

async fn cleanup_job_stats(app: &AppHandle, job: &JobInfo) {
    let manager = app.state::<crate::rclone::backend::BackendManager>();
    if let Some(backend) = manager.get(&job.backend_name).await {
        spawn_stats_cleanup_by_group(
            crate::rclone::backend::routing_transport::RoutingTransport::for_backend(
                app.clone(),
                backend,
            ),
            &job.group,
        );
    }
}

impl Default for JobCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::types::starter::Starter;
    use serde_json::json;

    #[tokio::test]
    async fn the_list_leaves_out_the_rows_a_view_of_one_run_fetches() {
        let cache = JobCache::new();
        let stats = json!({ "bytes": 1, "completed": [{ "name": "a", "status": "failed" }] });
        cache.jobs.write().await.insert(
            1,
            JobInfo {
                status: JobStatus::Failed,
                execute_id: Some("run-1".into()),
                stats: Some(stats.clone()),
                ..JobInfo::for_test()
            },
        );
        let listed = cache.get_jobs().await;
        assert_eq!(listed[0].stats, Some(json!({ "bytes": 1 })));
        assert_eq!(listed[0].failed_files, Some(1));
        assert_eq!(cache.job_stats(1, Some("run-1")).await, Some(stats.clone()));
        assert_eq!(cache.job_stats(1, None).await, Some(stats));
        // Another run under the same id, after rclone restarted.
        assert_eq!(cache.job_stats(1, Some("run-2")).await, None);
        assert_eq!(cache.job_stats(2, None).await, None);
    }

    #[tokio::test]
    async fn progress_sums_running_jobs_and_streamed_uploads_only() {
        let cache = JobCache::new();
        let stats = |bytes: u64, total: u64| serde_json::json!({"bytes": bytes, "totalBytes": total, "speed": 10.5, "checks": 1});
        cache.jobs.write().await.extend([
            (
                1,
                JobInfo {
                    jobid: 1,
                    stats: Some(stats(10, 100)),
                    ..JobInfo::for_test()
                },
            ),
            (
                2,
                JobInfo {
                    jobid: 2,
                    stats: Some(stats(5, 50)),
                    ..JobInfo::for_test()
                },
            ),
            (
                3,
                JobInfo {
                    jobid: 3,
                    status: JobStatus::Completed,
                    stats: Some(stats(70, 70)),
                    ..JobInfo::for_test()
                },
            ),
            // Not polled yet: counted, with nothing transferred.
            (
                4,
                JobInfo {
                    jobid: 4,
                    ..JobInfo::for_test()
                },
            ),
        ]);
        assert_eq!(
            cache.running_progress().await,
            JobProgress {
                jobs: 3,
                bytes: 15,
                total_bytes: 150,
                speed: 21.0,
                checks: 2,
            }
        );

        assert_eq!(cache.own_job_progress().await, JobProgress::default());
        let (_, result) = tokio::sync::watch::channel(None);
        cache.own_jobs.lock().insert(
            2,
            crate::utils::types::jobs::OwnJobCancellation {
                token: tokio_util::sync::CancellationToken::new(),
                result,
            },
        );
        assert_eq!(cache.own_job_progress().await.bytes, 5);
        assert_eq!(cache.own_job_progress().await.jobs, 1);
    }

    #[tokio::test]
    async fn a_finished_job_keeps_its_request_only_while_it_has_something_to_retry() {
        let cache = JobCache::new();
        let metadata = crate::rclone::commands::job::JobMetadata::new(
            "drive",
            JobType::Copy,
            vec![],
            "drive:",
        );
        let request = crate::rclone::commands::job::JobRequest::for_test(&metadata);
        for jobid in [1, 2] {
            cache
                .create_job(
                    jobid,
                    metadata.clone(),
                    "Local".into(),
                    Some(request.clone()),
                )
                .await;
        }
        let retryable = |job: &JobInfo| serde_json::to_value(job).unwrap()["retryable"].clone();
        assert_eq!(
            retryable(&cache.get_job(1).await.unwrap()),
            serde_json::json!(true)
        );

        cache.complete_job(1, true, None).await.unwrap();
        cache
            .complete_job(2, false, Some("failed".into()))
            .await
            .unwrap();
        let succeeded = cache.get_job(1).await.unwrap();
        assert!(succeeded.request.is_none());
        assert_eq!(retryable(&succeeded), serde_json::json!(false));
        assert!(cache.get_job(2).await.unwrap().request.is_some());
    }

    #[tokio::test]
    async fn profile_cleanup_only_removes_finished_jobs_of_the_same_operation() {
        let cache = JobCache::new();
        for (id, operation, profile, finished) in [
            (1, JobType::Mount, "Default", true),
            (2, JobType::Sync, "Default", true),
            (3, JobType::Mount, "Default", false),
            (4, JobType::Mount, "Other", true),
        ] {
            let mut job = mock_job(id, "drive", operation, Some(profile));
            if finished {
                job.status = JobStatus::Completed;
            }
            cache.add_job(job).await;
        }
        cache
            .delete_jobs_by_profile("drive", "Default", &JobType::Mount, None)
            .await;
        assert!(cache.get_job(1).await.is_none());
        for id in [2, 3, 4] {
            assert!(cache.get_job(id).await.is_some());
        }
    }

    fn mock_job(jobid: u64, remote: &str, job_type: JobType, profile: Option<&str>) -> JobInfo {
        JobInfo {
            jobid,
            remote_name: remote.to_string(),
            job_type,
            source: vec![format!("{}path", remote)],
            destination: "/local/path".to_string(),
            group: format!("job/{jobid}"),
            starter: profile.map(Starter::profile),
            ..JobInfo::for_test()
        }
    }

    /// Listens to the job changes the cache announces, keeping those of `backend`: each test
    /// names its own, as the event bridge is shared by every test.
    fn job_changes(
        backend: &'static str,
    ) -> impl FnMut() -> Vec<crate::utils::types::events::JobChangeEvent> {
        use crate::services::bridge::{EventBridge, init_event_bridge, subscribe};
        static BRIDGE: std::sync::Once = std::sync::Once::new();
        BRIDGE.call_once(|| init_event_bridge(Arc::new(EventBridge::new(1 << 16, None))));
        let mut events = subscribe().expect("bridge initialized");
        move || {
            let mut changes = Vec::new();
            while let Ok(event) = events.try_recv() {
                if event.event == JOB_CACHE_CHANGED
                    && let Ok(change) = serde_json::from_value::<
                        crate::utils::types::events::JobChangeEvent,
                    >(event.payload.clone())
                    && change.backend_name == backend
                {
                    changes.push(change);
                }
            }
            changes
        }
    }

    #[tokio::test]
    async fn a_change_carries_the_job_and_only_the_one_that_ends_it_says_so() {
        let mut changes = job_changes("ended-test");
        let cache = JobCache::new();
        let job = |jobid| JobInfo {
            jobid,
            backend_name: "ended-test".into(),
            ..JobInfo::for_test()
        };
        cache.add_job(job(1)).await;
        cache.add_job(job(2)).await;
        cache.complete_job(1, true, None).await.unwrap();
        // The monitor stores the final stats of a job that already ended.
        cache
            .complete_job_for_execution(1, None, true, None, Some(json!({"bytes": 3})), None)
            .await
            .unwrap();
        cache.stop_job(2).await.unwrap();
        cache.stop_job(2).await.unwrap();
        cache.delete_job(1, None).await.unwrap();

        let seen: Vec<_> = changes()
            .into_iter()
            .map(|change| {
                (
                    change.job_id,
                    change.job.map(|job| job.status),
                    change.ended,
                )
            })
            .collect();
        assert_eq!(
            seen,
            [
                (1, Some(JobStatus::Running), false),
                (2, Some(JobStatus::Running), false),
                (1, Some(JobStatus::Completed), true),
                (1, Some(JobStatus::Completed), false),
                (2, Some(JobStatus::Stopped), true),
                (2, Some(JobStatus::Stopped), false),
                (1, None, false),
            ]
        );
    }

    #[tokio::test]
    async fn removing_a_repair_announces_the_parent_whose_row_it_cleared() {
        let mut changes = job_changes("relink-test");
        let cache = JobCache::new();
        let mut parent = mock_job(1, "drive:", JobType::Copy, None);
        parent.backend_name = "relink-test".into();
        parent.stats = Some(json!({"completed": [{
            "name": "file.txt", "srcFs": "drive:root", "dstFs": "backup:root", "error": "denied"
        }]}));
        cache.add_job(parent).await;
        let mut child = mock_job(2, "drive:", JobType::Copy, None);
        child.backend_name = "relink-test".into();
        child.parent_job_id = Some(1);
        child.source = vec!["drive:root/file.txt".into()];
        child.destination = "backup:root".into();
        cache.add_job(child).await;
        changes();

        cache.delete_job(2, None).await.unwrap();
        let after = changes();
        assert_eq!(after.len(), 2);
        assert!(after[0].job_id == 2 && after[0].job.is_none());
        let parent = after[1].job.as_ref().unwrap();
        assert_eq!(parent.jobid, 1);
        assert!(
            parent.stats.as_ref().unwrap()["completed"][0]
                .get("resolveJobId")
                .is_none()
        );
    }

    #[tokio::test]
    async fn a_wait_ends_with_the_job_and_at_once_when_it_is_removed() {
        let cache = Arc::new(JobCache::new());
        cache.add_job(JobInfo::for_test()).await;
        cache
            .add_job(JobInfo {
                jobid: 2,
                ..JobInfo::for_test()
            })
            .await;
        let wait = |jobid| {
            let cache = cache.clone();
            tokio::spawn(async move { cache.wait_until_finished(jobid).await })
        };
        let (failed, removed) = (wait(1), wait(2));
        tokio::task::yield_now().await;
        assert!(!failed.is_finished() && !removed.is_finished());

        cache
            .complete_job(1, false, Some("boom".into()))
            .await
            .unwrap();
        cache.delete_job(2, None).await.unwrap();
        let within = |task| tokio::time::timeout(std::time::Duration::from_millis(200), task);
        let failed = within(failed).await.unwrap().unwrap().unwrap();
        assert_eq!(failed.status, JobStatus::Failed);
        assert_eq!(failed.error.as_deref(), Some("boom"));
        assert!(within(removed).await.unwrap().unwrap().is_none());
    }

    #[tokio::test]
    async fn an_old_monitor_cannot_modify_a_reused_job_id() {
        let cache = JobCache::new();
        let mut job = mock_job(1, "drive:", JobType::Copy, None);
        job.execute_id = Some("new-execution".into());
        cache.add_job(job).await;
        assert!(
            cache
                .get_execution_status(1, Some("old-execution"))
                .await
                .is_none()
        );
        assert!(
            cache
                .update_job_stats_for_execution(
                    1,
                    Some("old-execution"),
                    serde_json::json!({"bytes": 900})
                )
                .await
                .is_err()
        );
        assert!(
            cache
                .complete_job_for_execution(1, Some("old-execution"), true, None, None, None)
                .await
                .is_err()
        );
        let unchanged = cache.get_job(1).await.unwrap();
        assert_eq!(unchanged.status, JobStatus::Running);
        assert_eq!(unchanged.stats_revision, 0);
        assert!(unchanged.stats.is_none());
        assert_eq!(
            cache.get_execution_status(1, Some("new-execution")).await,
            Some(JobStatus::Running)
        );
    }

    #[tokio::test]
    async fn telemetry_revision_advances_and_events_keep_execution_identity() {
        let cache = JobCache::new();
        let mut job = mock_job(1, "drive:", JobType::Copy, None);
        job.execute_id = Some("execution-1".into());
        cache.add_job(job).await;
        cache
            .update_job_stats(1, serde_json::json!({"bytes": 10}))
            .await
            .unwrap();
        let first = cache.get_job(1).await.unwrap();
        let event = JobStatsUpdatedEvent::from(&first);
        assert_eq!(event.execute_id.as_deref(), Some("execution-1"));
        assert_eq!(event.stats_revision, first.stats_revision);
        assert_eq!(event.stats["bytes"], 10);

        cache.complete_job(1, true, None).await.unwrap();
        let finished = cache.get_job(1).await.unwrap();
        assert!(finished.stats_revision > first.stats_revision);
        cache
            .update_job_stats(1, serde_json::json!({"speed": 500}))
            .await
            .unwrap();
        let last = cache.get_job(1).await.unwrap();
        assert!(last.stats_revision > finished.stats_revision);
        assert_eq!(last.stats.unwrap()["speed"], 0.0);
    }

    #[tokio::test]
    async fn final_stats_are_normalized_after_the_completion_time_is_set() {
        let cache = JobCache::new();
        let mut job = mock_job(1, "drive:", JobType::Check, None);
        job.execute_id = Some("execution".into());
        cache.add_job(job).await;
        cache
            .complete_job_for_execution(
                1,
                Some("execution"),
                true,
                None,
                Some(serde_json::json!({
                    "bytes": 42, "speed": 99, "eta": 10, "checking": ["a.txt"],
                    "transferring": [{"name": "a.txt"}],
                    "checkOutput": {"missingOnDst": ["a.txt"]}
                })),
                None,
            )
            .await
            .unwrap();
        let finished = cache.get_job(1).await.unwrap();
        assert_eq!(finished.status, JobStatus::Completed);
        assert_eq!(finished.stats_revision, 1);
        let stats = finished.stats.unwrap();
        assert_eq!(stats["bytes"], 42);
        assert_eq!(stats["speed"], 0.0);
        assert_eq!(stats["checking"], serde_json::json!([]));
        assert_eq!(stats["transferring"], serde_json::json!([]));
        assert!(stats["eta"].is_null());
        assert_eq!(
            stats["completed"][0]["completedAt"],
            serde_json::to_value(finished.end_time.unwrap()).unwrap()
        );
    }

    #[tokio::test]
    async fn retry_links_survive_parent_refreshes_and_only_changed_progress_updates_the_parent() {
        let cache = JobCache::new();
        cache
            .add_job(mock_job(1, "drive:", JobType::Copy, None))
            .await;
        let snapshot = serde_json::json!({"completed": [{
            "name": "file.txt", "srcFs": "drive:root", "dstFs": "backup:root",
            "what": "transferring", "error": "denied"
        }]});
        cache.update_job_stats(1, snapshot.clone()).await.unwrap();
        let mut child = mock_job(2, "drive:", JobType::Copy, None);
        child.parent_job_id = Some(1);
        child.source = vec!["drive:root/file.txt".into()];
        child.destination = "backup:root".into();
        cache.add_job(child).await;
        cache.update_job_stats(1, snapshot).await.unwrap();
        let parent = cache.get_job(1).await.unwrap();
        assert_eq!(parent.stats.unwrap()["completed"][0]["resolveJobId"], 2);

        let progress = serde_json::json!({"bytes": 1, "totalBytes": 10});
        cache.update_job_stats(2, progress.clone()).await.unwrap();
        let first = cache.get_job(1).await.unwrap();
        cache.update_job_stats(2, progress).await.unwrap();
        let second = cache.get_job(1).await.unwrap();
        assert_eq!(first.stats_revision, second.stats_revision);
        assert_eq!(
            second.stats.unwrap()["completed"][0]["resolveState"]["percentage"],
            10
        );

        cache.delete_job(2, None).await.unwrap();
        let cleared = cache.get_job(1).await.unwrap();
        assert!(cleared.stats_revision > second.stats_revision);
        let row = &cleared.stats.as_ref().unwrap()["completed"][0];
        assert!(row.get("resolveJobId").is_none());
        assert!(row.get("resolveState").is_none());
    }

    #[tokio::test]
    async fn missing_history_preserves_the_last_snapshot_but_an_empty_history_clears_it() {
        let cache = JobCache::new();
        cache
            .add_job(mock_job(1, "drive:", JobType::Copy, None))
            .await;
        cache
            .update_job_stats(1, serde_json::json!({"completed": [{"name": "a.txt"}]}))
            .await
            .unwrap();
        cache
            .update_job_stats(1, serde_json::json!({"bytes": 10}))
            .await
            .unwrap();
        assert_eq!(
            cache.get_job(1).await.unwrap().stats.unwrap()["completed"][0]["name"],
            "a.txt"
        );
        cache
            .complete_job_for_execution(
                1,
                None,
                true,
                None,
                Some(serde_json::json!({"bytes": 11})),
                None,
            )
            .await
            .unwrap();
        let finished = cache.get_job(1).await.unwrap();
        assert_eq!(finished.stats.unwrap()["completed"][0]["name"], "a.txt");
        cache
            .update_job_stats(1, serde_json::json!({"completed": []}))
            .await
            .unwrap();
        assert_eq!(
            cache.get_job(1).await.unwrap().stats.unwrap()["completed"],
            serde_json::json!([])
        );
    }

    #[tokio::test]
    async fn deleting_a_cyclic_subtree_terminates_and_preserves_unrelated_jobs() {
        let cache = JobCache::new();
        let mut first = mock_job(1, "drive:", JobType::Copy, None);
        first.parent_job_id = Some(2);
        let mut second = mock_job(2, "drive:", JobType::Copy, None);
        second.parent_job_id = Some(1);
        cache.add_job(first).await;
        cache.add_job(second).await;
        cache
            .add_job(mock_job(3, "other:", JobType::Copy, None))
            .await;
        cache.delete_job(1, None).await.unwrap();
        let remaining = cache.get_jobs().await;
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].jobid, 3);
    }

    #[tokio::test]
    async fn a_finished_job_keeps_its_report_apart_from_what_the_ui_receives() {
        let cache = JobCache::new();
        let mut job = mock_job(1, "drive:", JobType::Sync, None);
        job.execute_id = Some("execution".into());
        cache.add_job(job).await;
        let report = serde_json::json!({
            "combined": ["+ new.txt", "- old.txt", "= same.txt"],
            "missingOnDst": ["new.txt"],
            "error": [],
        });
        cache
            .complete_job_for_execution(
                1,
                Some("execution"),
                true,
                None,
                None,
                Some(report.clone()),
            )
            .await
            .unwrap();
        let finished = cache.get_job(1).await.unwrap();

        assert_eq!(finished.report_counts.as_ref().unwrap()["combined"], 3);
        assert_eq!(finished.report_counts.as_ref().unwrap()["error"], 0);
        assert_eq!(*cache.get_job_report(1).await.unwrap(), report);
        let sent = serde_json::to_value(&finished).unwrap();
        assert!(sent.get("report").is_none());
        assert_eq!(sent["report_counts"]["missingOnDst"], 1);
    }

    #[tokio::test]
    async fn a_job_without_a_report_has_none_and_a_stale_run_cannot_set_one() {
        let cache = JobCache::new();
        let mut job = mock_job(1, "drive:", JobType::Sync, None);
        job.execute_id = Some("execution".into());
        cache.add_job(job).await;

        assert!(cache.get_job_report(1).await.is_none());
        assert!(cache.get_job_report(99).await.is_none());
        let stale = cache
            .complete_job_for_execution(
                1,
                Some("old-execution"),
                true,
                None,
                None,
                Some(serde_json::json!({"combined": ["+ a.txt"]})),
            )
            .await;
        assert!(stale.is_err());
        assert!(cache.get_job_report(1).await.is_none());
        cache.complete_job(1, true, None).await.unwrap();
        assert!(cache.get_job(1).await.unwrap().report_counts.is_none());
    }

    #[tokio::test]
    async fn a_failed_job_still_keeps_its_report_and_deleting_the_job_drops_it() {
        let cache = JobCache::new();
        cache
            .add_job(mock_job(1, "drive:", JobType::Copy, None))
            .await;
        cache
            .complete_job_for_execution(
                1,
                None,
                false,
                Some("permission denied".into()),
                None,
                Some(serde_json::json!({"error": ["locked.txt"]})),
            )
            .await
            .unwrap();
        assert_eq!(
            cache.get_job_report(1).await.unwrap()["error"][0],
            "locked.txt"
        );

        cache.delete_job(1, None).await.unwrap();
        assert!(cache.get_job_report(1).await.is_none());
    }

    #[tokio::test]
    async fn test_add_and_get_job() {
        let cache = JobCache::new();
        cache
            .add_job(mock_job(1, "gdrive:", JobType::Sync, Some("default")))
            .await;
        let job = cache.get_job(1).await.unwrap();
        assert_eq!(job.remote_name, "gdrive:");
    }

    #[tokio::test]
    async fn test_delete_job() {
        let cache = JobCache::new();
        cache
            .add_job(mock_job(1, "gdrive:", JobType::Sync, None))
            .await;
        cache.add_job(mock_job(2, "s3:", JobType::Copy, None)).await;
        assert_eq!(cache.get_jobs().await.len(), 2);

        assert!(cache.delete_job(1, None).await.is_ok());
        assert_eq!(cache.get_jobs().await.len(), 1);
    }

    #[tokio::test]
    async fn test_complete_job_idempotency() {
        let cache = JobCache::new();
        let jobid = 1;
        cache
            .add_job(mock_job(jobid, "gdrive:", JobType::Sync, None))
            .await;

        // Complete the job for the first time
        cache.complete_job(jobid, true, None).await.unwrap();
        let job1 = cache.get_job(jobid).await.unwrap();
        let first_end_time = job1.end_time.unwrap();

        // Wait a bit
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        // Complete the job again
        cache
            .complete_job(jobid, false, Some("error".to_string()))
            .await
            .unwrap();
        let job2 = cache.get_job(jobid).await.unwrap();

        // Verify that end_time and status/error were not changed
        assert_eq!(job2.end_time.unwrap(), first_end_time);
        assert_eq!(job2.status, JobStatus::Completed);
        assert!(job2.error.is_none());
    }

    #[tokio::test]
    async fn test_job_stats_sanitization_on_finish() {
        let cache = JobCache::new();
        let jobid = 1;
        cache
            .add_job(mock_job(jobid, "gdrive:", JobType::Sync, None))
            .await;

        // Populate running stats
        let active_stats = serde_json::json!({
            "bytes": 100,
            "totalBytes": 1000,
            "speed": 50.0,
            "eta": 18,
            "transferring": [
                {
                    "name": "file1.txt",
                    "size": 500,
                    "bytes": 50,
                    "speed": 10.0,
                    "eta": 45
                }
            ]
        });

        cache
            .update_job_stats(jobid, active_stats.clone())
            .await
            .unwrap();
        let job = cache.get_job(jobid).await.unwrap();
        let stats_val = job.stats.unwrap();
        assert_eq!(stats_val["transferring"].as_array().unwrap().len(), 1);
        assert_eq!(stats_val["speed"].as_f64().unwrap(), 50.0);
        assert_eq!(stats_val["eta"].as_u64().unwrap(), 18);

        // Stop the job and check if stats are sanitized
        cache.stop_job(jobid).await.unwrap();
        let job = cache.get_job(jobid).await.unwrap();
        let stats_val = job.stats.unwrap();
        assert_eq!(stats_val["transferring"].as_array().unwrap().len(), 0);
        assert_eq!(stats_val["speed"].as_f64().unwrap(), 0.0);
        assert!(stats_val["eta"].is_null());

        // Attempt to update stats on stopped job, it should remain sanitized
        cache.update_job_stats(jobid, active_stats).await.unwrap();
        let job = cache.get_job(jobid).await.unwrap();
        let stats_val = job.stats.unwrap();
        assert_eq!(stats_val["transferring"].as_array().unwrap().len(), 0);
        assert_eq!(stats_val["speed"].as_f64().unwrap(), 0.0);
        assert!(stats_val["eta"].is_null());
    }

    #[tokio::test]
    async fn test_delete_job_recursive() {
        let cache = JobCache::new();
        let parent = mock_job(1, "gdrive:", JobType::Check, None);
        cache.add_job(parent).await;

        let mut child = mock_job(2, "gdrive:", JobType::Copy, None);
        child.parent_job_id = Some(1);
        cache.add_job(child).await;

        let mut grandchild = mock_job(3, "gdrive:", JobType::Copy, None);
        grandchild.parent_job_id = Some(2);
        cache.add_job(grandchild).await;

        let other = mock_job(4, "s3:", JobType::Copy, None);
        cache.add_job(other).await;

        assert_eq!(cache.get_jobs().await.len(), 4);

        // Delete parent job, should delete child and grandchild
        assert!(cache.delete_job(1, None).await.is_ok());
        let remaining = cache.get_jobs().await;
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].jobid, 4);
    }

    #[tokio::test]
    async fn test_recompute_completed_transfers() {
        let cache = JobCache::new();
        let jobid = 1;
        cache
            .add_job(mock_job(jobid, "gdrive:", JobType::Copy, None))
            .await;

        let active_stats = serde_json::json!({
            "bytes": 100,
            "totalBytes": 1000,
            "completed": [
                {
                    "name": "file1.txt",
                    "size": 500,
                    "bytes": 500,
                    "completed_at": "2026-06-26T12:00:00Z",
                    "checked": false,
                    "error": ""
                },
                {
                    "name": "file2.txt",
                    "size": 300,
                    "bytes": 150,
                    "completed_at": "2026-06-26T12:05:00Z",
                    "checked": false,
                    "error": "some error"
                }
            ]
        });

        cache.update_job_stats(jobid, active_stats).await.unwrap();

        let job = cache.get_job(jobid).await.unwrap();
        let stats = job.stats.unwrap();
        let completed = stats.get("completed").unwrap().as_array().unwrap();
        assert_eq!(completed.len(), 2);

        // They should be sorted newest completed first
        assert_eq!(completed[0]["name"].as_str().unwrap(), "file2.txt");
        assert_eq!(completed[0]["status"].as_str().unwrap(), "failed");
        assert_eq!(completed[0]["error"].as_str().unwrap(), "some error");

        assert_eq!(completed[1]["name"].as_str().unwrap(), "file1.txt");
        assert_eq!(completed[1]["status"].as_str().unwrap(), "completed");
        assert_eq!(completed[1]["error"].as_str().unwrap(), "");
    }

    #[tokio::test]
    async fn job_activity_reports_running_and_last_end_without_copying_jobs() {
        let cache = JobCache::new();
        assert_eq!(
            cache
                .job_activity("drive", &JobType::Sync, Some("daily"))
                .await,
            JobActivity::default()
        );
        cache
            .add_job(mock_job(1, "drive:", JobType::Sync, Some("daily")))
            .await;
        cache
            .add_job(mock_job(2, "drive", JobType::Sync, Some("daily")))
            .await;
        cache
            .add_job(mock_job(3, "drive", JobType::Copy, Some("daily")))
            .await;
        cache
            .add_job(mock_job(4, "drive", JobType::Sync, Some("other")))
            .await;
        cache.complete_job(1, true, None).await.unwrap();
        // The colon of a remote name does not matter; type and profile do.
        let activity = cache
            .job_activity("drive", &JobType::Sync, Some("daily"))
            .await;
        assert!(activity.running);
        assert_eq!(
            activity.last_finished,
            cache.get_job(1).await.unwrap().end_time
        );
        assert_eq!(cache.active_job_count().await, 3);

        cache.complete_job(2, true, None).await.unwrap();
        let activity = cache
            .job_activity("drive:", &JobType::Sync, Some("daily"))
            .await;
        assert!(!activity.running);
        assert!(activity.last_finished >= cache.get_job(1).await.unwrap().end_time);
        assert_eq!(cache.active_job_count().await, 2);
        // A job without a profile never matches a profile.
        assert!(
            !cache
                .job_activity("drive", &JobType::Sync, None)
                .await
                .running
        );
    }

    #[tokio::test]
    async fn the_oldest_finished_jobs_are_dropped_past_the_limit() {
        let cache = JobCache::new();
        let total = MAX_FINISHED_JOBS as u64 + 3;
        for id in 1..=total {
            cache
                .add_job(mock_job(id, "drive:", JobType::Copy, None))
                .await;
            cache.complete_job(id, true, None).await.unwrap();
        }
        // A running job and the parent of a kept job are never dropped, however old.
        let mut parent = mock_job(total + 1, "drive:", JobType::Check, None);
        parent.start_time -= chrono::Duration::days(1);
        cache.add_job(parent).await;
        cache.complete_job(total + 1, true, None).await.unwrap();
        let mut child = mock_job(total + 2, "drive:", JobType::Copy, None);
        child.parent_job_id = Some(total + 1);
        cache.add_job(child).await;
        cache.complete_job(total + 2, true, None).await.unwrap();
        cache
            .add_job(mock_job(total + 3, "drive:", JobType::Sync, None))
            .await;

        cache.prune_finished(None).await;

        let kept = cache.get_jobs().await;
        let finished = kept.iter().filter(|j| j.status.is_finished()).count();
        assert_eq!(finished, MAX_FINISHED_JOBS);
        assert!(cache.get_job(total + 1).await.is_some(), "parent kept");
        assert!(cache.get_job(total + 3).await.is_some(), "running kept");
        // The oldest childless finished jobs are the ones that went.
        assert!(cache.get_job(1).await.is_none());
        assert!(cache.get_job(total).await.is_some());
        // Nothing to do below the limit.
        cache.prune_finished(None).await;
        assert_eq!(cache.get_jobs().await.len(), kept.len());
    }
}
