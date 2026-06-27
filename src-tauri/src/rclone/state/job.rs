use log::info;
use serde_json::Value;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

use crate::utils::types::{
    events::JOB_CACHE_CHANGED,
    jobs::{JobCache, JobInfo, JobStatus, JobType},
};

impl JobCache {
    #[must_use]
    pub fn new() -> Self {
        Self {
            jobs: RwLock::new(HashMap::new()),
        }
    }

    /// Registers a new job with the cache.
    pub async fn create_job(
        &self,
        jobid: u64,
        execute_id: Option<String>,
        metadata: crate::rclone::commands::job::JobMetadata,
        backend_name: String,
        app: Option<&AppHandle>,
    ) -> u64 {
        let group = metadata.group_name();
        let job = JobInfo {
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
            execute_id,
            origin: metadata.origin,
            backend_name,
            dry_run: metadata.dry_run,
            parent_job_id: metadata.parent_job_id,
            completed_transfers: None,
        };

        self.add_job(job, app).await;
        jobid
    }

    pub async fn set_all_jobs(&self, jobs: Vec<JobInfo>) {
        *self.jobs.write().await = jobs.into_iter().map(|j| (j.jobid, j)).collect();
    }

    pub async fn add_job(&self, job: JobInfo, app: Option<&AppHandle>) {
        let jobid = job.jobid;
        self.jobs.write().await.insert(jobid, job.clone());
        self.notify_change(app, Some(&job));
    }

    pub async fn delete_job(&self, jobid: u64, app: Option<&AppHandle>) -> Result<(), String> {
        let mut ids_to_delete = vec![jobid];
        let mut index = 0;

        let mut jobs = self.jobs.write().await;

        while index < ids_to_delete.len() {
            let current_id = ids_to_delete[index];
            index += 1;

            let children: Vec<u64> = jobs
                .values()
                .filter(|j| j.parent_job_id == Some(current_id))
                .map(|j| j.jobid)
                .collect();

            for child_id in children {
                if !ids_to_delete.contains(&child_id) {
                    ids_to_delete.push(child_id);
                }
            }
        }

        let mut removed_jobs = Vec::new();
        for id in ids_to_delete {
            if let Some(job) = jobs.remove(&id) {
                removed_jobs.push(job);
            }
        }

        drop(jobs);

        if removed_jobs.is_empty() {
            log::warn!("Attempted to delete job {jobid}, but it was not found in cache");
            return Err(crate::localized_error!("backendErrors.job.notFound"));
        }

        for job in removed_jobs {
            self.notify_change(app, Some(&job));
        }

        Ok(())
    }

    pub async fn update_job(
        &self,
        jobid: u64,
        update_fn: impl FnOnce(&mut JobInfo),
        app: Option<&AppHandle>,
    ) -> Result<JobInfo, String> {
        let mut jobs = self.jobs.write().await;
        let job = jobs
            .get_mut(&jobid)
            .ok_or_else(|| crate::localized_error!("backendErrors.job.notFound"))?;

        update_fn(job);
        let result = job.clone();
        drop(jobs);

        self.notify_change(app, Some(&result));
        Ok(result)
    }

    pub async fn update_job_stats(&self, jobid: u64, stats: Value) -> Result<(), String> {
        self.update_job(
            jobid,
            |j| {
                let mut stats = stats;
                if j.status.is_finished() {
                    sanitize_finished_stats(&mut stats);
                }
                j.stats = Some(stats);
                j.recompute_completed_transfers();
            },
            None,
        )
        .await
        .map(|_| ())
    }

    pub async fn complete_job(
        &self,
        jobid: u64,
        success: bool,
        error: Option<String>,
        app: Option<&AppHandle>,
    ) -> Result<JobInfo, String> {
        self.update_job(
            jobid,
            |j| {
                if !j.status.is_finished() {
                    j.status = if success {
                        JobStatus::Completed
                    } else {
                        JobStatus::Failed
                    };
                    j.error = error;
                    j.end_time = Some(chrono::Utc::now());
                    if let Some(stats) = j.stats.as_mut() {
                        sanitize_finished_stats(stats);
                    }
                    j.recompute_completed_transfers();
                }
            },
            app,
        )
        .await
    }

    pub async fn stop_job(&self, jobid: u64, app: Option<&AppHandle>) -> Result<(), String> {
        self.update_job(
            jobid,
            |j| {
                if !j.status.is_finished() {
                    j.status = JobStatus::Stopped;
                    j.end_time = Some(chrono::Utc::now());
                    if let Some(stats) = j.stats.as_mut() {
                        sanitize_finished_stats(stats);
                    }
                    j.recompute_completed_transfers();
                }
            },
            app,
        )
        .await
        .map(|_| ())
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
        app: Option<&AppHandle>,
    ) {
        self.delete_matching(
            |j| j.remote_name == remote_name && j.profile.as_deref() == Some(profile_name),
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
                if job
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

        drop(jobs);

        for job in removed_jobs {
            self.notify_change(app, Some(&job));
        }
    }

    // ---- Private helpers ----
    fn notify_change(&self, app: Option<&AppHandle>, job: Option<&JobInfo>) {
        if let (Some(app), Some(job)) = (app, job) {
            let _ = app.emit(
                JOB_CACHE_CHANGED,
                crate::utils::types::events::JobChangeEvent::from(job),
            );
        }
    }
}

fn sanitize_finished_stats(stats: &mut Value) {
    if let Some(obj) = stats.as_object_mut() {
        obj.insert("transferring".to_string(), serde_json::json!([]));
        obj.insert("speed".to_string(), serde_json::json!(0.0));
        obj.insert("eta".to_string(), Value::Null);
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

    fn mock_job(jobid: u64, remote: &str, job_type: JobType, profile: Option<&str>) -> JobInfo {
        JobInfo {
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
            origin: None,
            backend_name: default_backend_name(),
            dry_run: false,
            parent_job_id: None,
            completed_transfers: None,
        }
    }

    #[tokio::test]
    async fn test_add_and_get_job() {
        let cache = JobCache::new();
        cache
            .add_job(mock_job(1, "gdrive:", JobType::Sync, Some("default")), None)
            .await;
        let job = cache.get_job(1).await.unwrap();
        assert_eq!(job.remote_name, "gdrive:");
    }

    #[tokio::test]
    async fn test_delete_job() {
        let cache = JobCache::new();
        cache
            .add_job(mock_job(1, "gdrive:", JobType::Sync, None), None)
            .await;
        cache
            .add_job(mock_job(2, "s3:", JobType::Copy, None), None)
            .await;
        assert_eq!(cache.get_jobs().await.len(), 2);

        assert!(cache.delete_job(1, None).await.is_ok());
        assert_eq!(cache.get_jobs().await.len(), 1);
    }

    #[tokio::test]
    async fn test_complete_job_idempotency() {
        let cache = JobCache::new();
        let jobid = 1;
        cache
            .add_job(mock_job(jobid, "gdrive:", JobType::Sync, None), None)
            .await;

        // Complete the job for the first time
        cache.complete_job(jobid, true, None, None).await.unwrap();
        let job1 = cache.get_job(jobid).await.unwrap();
        let first_end_time = job1.end_time.unwrap();

        // Wait a bit
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        // Complete the job again
        cache
            .complete_job(jobid, false, Some("error".to_string()), None)
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
            .add_job(mock_job(jobid, "gdrive:", JobType::Sync, None), None)
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
        cache.stop_job(jobid, None).await.unwrap();
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
        cache.add_job(parent, None).await;

        let mut child = mock_job(2, "gdrive:", JobType::Copy, None);
        child.parent_job_id = Some(1);
        cache.add_job(child, None).await;

        let mut grandchild = mock_job(3, "gdrive:", JobType::Copy, None);
        grandchild.parent_job_id = Some(2);
        cache.add_job(grandchild, None).await;

        let other = mock_job(4, "s3:", JobType::Copy, None);
        cache.add_job(other, None).await;

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
            .add_job(mock_job(jobid, "gdrive:", JobType::Copy, None), None)
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
        let completed = job.completed_transfers.unwrap();
        assert_eq!(completed.len(), 2);

        // They should be sorted newest completed first
        assert_eq!(completed[0].name, "file2.txt");
        assert_eq!(completed[0].status, "failed");
        assert_eq!(completed[0].error, "some error");

        assert_eq!(completed[1].name, "file1.txt");
        assert_eq!(completed[1].status, "completed");
        assert_eq!(completed[1].error, "");
    }
}
