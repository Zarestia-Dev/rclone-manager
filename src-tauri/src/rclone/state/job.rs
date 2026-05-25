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
        let job = self.jobs.write().await.remove(&jobid);
        if let Some(job) = job {
            self.notify_change(app, Some(&job));
            Ok(())
        } else {
            log::warn!("Attempted to delete job {jobid}, but it was not found in cache");
            Err(crate::localized_error!("backendErrors.job.notFound"))
        }
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
        self.update_job(jobid, |j| j.stats = Some(stats), None)
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
            source: format!("{}path", remote),
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
}
