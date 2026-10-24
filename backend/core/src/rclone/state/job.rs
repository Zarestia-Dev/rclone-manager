use std::collections::{HashMap, HashSet};

use crate::context::AppHandle;
use log::info;
use serde_json::Value;
use tokio::sync::RwLock;

use super::job_resolver::{link_resolving_jobs, sanitize_finished_stats};
use crate::utils::types::{
    events::{JOB_CACHE_CHANGED, JOB_STATS_UPDATED, JobChangeEvent, JobStatsUpdatedEvent},
    jobs::{JobCache, JobInfo, JobStatus, JobType},
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

impl JobCache {
    #[must_use]
    pub fn new() -> Self {
        Self {
            jobs: RwLock::new(HashMap::new()),
            uploads: parking_lot::Mutex::new(HashMap::new()),
        }
    }

    pub(crate) async fn cancel_upload(&self, jobid: u64) -> Result<bool, String> {
        let upload = self.uploads.lock().get(&jobid).cloned();
        let Some(mut upload) = upload else {
            return Ok(false);
        };
        upload.token.cancel();
        loop {
            if let Some(result) = upload.result.borrow_and_update().clone() {
                return result.map(|()| true);
            }
            upload
                .result
                .changed()
                .await
                .map_err(|_| "Upload ended without confirming cancellation".to_string())?;
        }
    }

    /// Registers a new job with the cache.
    pub async fn create_job(
        &self,
        jobid: u64,
        metadata: crate::rclone::commands::job::JobMetadata,
        backend_name: String,
    ) -> u64 {
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
            profile: metadata.profile,
            execute_id: exec_id,
            quick_run_id: metadata.quick_run_id,
            origin: metadata.origin,
            backend_name,
            dry_run: metadata.dry_run,
            parent_job_id: metadata.parent_job_id,
            workflow_id: metadata.workflow_id,
            node_id: metadata.node_id,
        };

        self.add_job(job).await;
        jobid
    }

    pub async fn add_job(&self, job: JobInfo) {
        let jobid = job.jobid;
        let parent_id = job.parent_job_id;
        let event = JobChangeEvent::from(&job);
        {
            let mut jobs = self.jobs.write().await;
            jobs.insert(jobid, job);
            if let Some(p_id) = parent_id {
                link_resolving_jobs(&mut jobs, p_id);
            }
        }
        crate::services::bridge::emit(JOB_CACHE_CHANGED, event);
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
        let mut removed_jobs = Vec::with_capacity(ids_to_delete.len());
        for id in &ids_to_delete {
            if let Some(job) = jobs.remove(id) {
                if let Some(parent_id) = job.parent_job_id
                    && !seen.contains(&parent_id)
                {
                    link_resolving_jobs(&mut jobs, parent_id);
                }
                removed_jobs.push(job);
            }
        }

        let remaining_groups: HashSet<String> = jobs.values().map(|j| j.group.clone()).collect();

        drop(jobs);

        if removed_jobs.is_empty() {
            log::warn!("Attempted to delete job {jobid}, but it was not found in cache");
            return Err(crate::localized_error!("backendErrors.job.notFound"));
        }

        if let Some(app) = app {
            for job in &removed_jobs {
                if !job.group.is_empty() && !remaining_groups.contains(&job.group) {
                    cleanup_job_stats(app, job).await;
                }
            }
        }

        for job in removed_jobs {
            self.notify_change(&job);
        }

        Ok(())
    }

    pub async fn update_job(
        &self,
        jobid: u64,
        update_fn: impl FnOnce(&mut JobInfo),
    ) -> Result<JobInfo, String> {
        self.update_job_for_execution(jobid, None, update_fn).await
    }

    async fn update_job_for_execution(
        &self,
        jobid: u64,
        execute_id: Option<&str>,
        update_fn: impl FnOnce(&mut JobInfo),
    ) -> Result<JobInfo, String> {
        let mut jobs = self.jobs.write().await;
        let job = jobs
            .get_mut(&jobid)
            .filter(|job| execute_id.is_none_or(|id| job.execute_id.as_deref() == Some(id)))
            .ok_or_else(|| crate::localized_error!("backendErrors.job.notFound"))?;

        update_fn(job);
        job.stats_revision += 1;

        let parent_id = job.parent_job_id;
        let parent_change = if let Some(p_id) = parent_id {
            link_resolving_jobs(&mut jobs, p_id);
            jobs.get(&p_id).map(JobChangeEvent::from)
        } else {
            None
        };
        link_resolving_jobs(&mut jobs, jobid);
        let result = jobs[&jobid].clone();

        drop(jobs);

        if let Some(event) = parent_change {
            crate::services::bridge::emit(JOB_CACHE_CHANGED, event);
        }
        self.notify_change(&result);

        Ok(result)
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
        job.normalize_job_stats();
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
    ) -> Result<JobInfo, String> {
        self.complete_job_for_execution(jobid, None, success, error, None)
            .await
    }

    pub(crate) async fn complete_job_for_execution(
        &self,
        jobid: u64,
        execute_id: Option<&str>,
        success: bool,
        error: Option<String>,
        final_stats: Option<Value>,
    ) -> Result<JobInfo, String> {
        self.update_job_for_execution(jobid, execute_id, |j| {
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
            }
            if let Some(mut stats) = final_stats {
                preserve_completed_history(&mut stats, j.stats.as_ref());
                j.stats = Some(stats);
            }
            if let Some(stats) = j.stats.as_mut() {
                sanitize_finished_stats(stats);
            }
            j.normalize_job_stats();
        })
        .await
    }

    pub async fn stop_job(&self, jobid: u64) -> Result<(), String> {
        self.update_job(jobid, |j| {
            if !j.status.is_finished() {
                j.status = JobStatus::Stopped;
                j.end_time = Some(chrono::Utc::now());
                if let Some(stats) = j.stats.as_mut() {
                    sanitize_finished_stats(stats);
                }
                j.normalize_job_stats();
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

    pub async fn get_jobs(&self) -> Vec<JobInfo> {
        self.jobs.read().await.values().cloned().collect()
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

    pub async fn has_running_jobs(&self) -> bool {
        self.jobs
            .read()
            .await
            .values()
            .any(|j| j.status.is_running())
    }

    pub async fn is_job_running(
        &self,
        remote_name: &str,
        job_type: JobType,
        profile: Option<&str>,
    ) -> bool {
        self.jobs.read().await.values().any(|j| {
            j.remote_name == remote_name
                && j.job_type == job_type
                && j.status.is_running()
                && j.profile.as_deref() == profile
        })
    }

    pub async fn delete_jobs_by_remote(&self, remote_name: &str, app: Option<&AppHandle>) {
        self.delete_matching(|j| j.remote_name == remote_name, app)
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
                    && j.profile.as_deref() == Some(profile_name)
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

        let remaining_groups: HashSet<String> = jobs.values().map(|j| j.group.clone()).collect();

        drop(jobs);

        if let Some(app) = app {
            for job in &removed_jobs {
                if !job.group.is_empty() && !remaining_groups.contains(&job.group) {
                    cleanup_job_stats(app, job).await;
                }
            }
        }

        for job in removed_jobs {
            self.notify_change(&job);
        }
    }

    fn notify_change(&self, job: &JobInfo) {
        crate::services::bridge::emit(JOB_CACHE_CHANGED, JobChangeEvent::from(job));
    }
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
    use crate::rclone::backend::types::default_backend_name;

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
            stats_revision: 0,
            jobid,
            remote_name: remote.to_string(),
            job_type,
            source: vec![format!("{}path", remote)],
            destination: "/local/path".to_string(),
            start_time: chrono::Utc::now(),
            end_time: None,
            status: JobStatus::Running,
            error: None,
            stats: None,
            group: format!("job/{jobid}"),
            profile: profile.map(str::to_string),
            execute_id: None,
            quick_run_id: None,
            origin: None,
            backend_name: default_backend_name(),
            dry_run: false,
            parent_job_id: None,
            workflow_id: None,
            node_id: None,
        }
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
                .complete_job_for_execution(1, Some("old-execution"), true, None, None)
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
        let finished = cache
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
            )
            .await
            .unwrap();
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
        let finished = cache
            .complete_job_for_execution(1, None, true, None, Some(serde_json::json!({"bytes": 11})))
            .await
            .unwrap();
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
}
