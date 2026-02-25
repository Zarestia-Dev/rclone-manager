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
    pub fn new() -> Self {
        Self {
            jobs: RwLock::new(HashMap::new()),
        }
    }

    /// Get all jobs (for state snapshot)
    pub async fn get_all_jobs(&self) -> Vec<JobInfo> {
        self.jobs.read().await.values().cloned().collect()
    }

    /// Set all jobs (for state restore)
    pub async fn set_all_jobs(&self, jobs: Vec<JobInfo>) {
        let mut current = self.jobs.write().await;
        *current = jobs.into_iter().map(|j| (j.jobid, j)).collect();
    }

    /// Add a job and emit event
    pub async fn add_job(&self, job: JobInfo, app: Option<&AppHandle>) {
        let jobid = job.jobid;
        let mut jobs = self.jobs.write().await;
        jobs.insert(jobid, job);
        drop(jobs);

        if let Some(app) = app {
            info!("📡 Job {jobid} added");
            let _ = app.emit(JOB_CACHE_CHANGED, jobid);
        }
    }

    /// Delete a job and emit event if successful
    pub async fn delete_job(&self, jobid: u64, app: Option<&AppHandle>) -> Result<(), String> {
        let mut jobs = self.jobs.write().await;

        if jobs.remove(&jobid).is_some() {
            drop(jobs);
            if let Some(app) = app {
                info!("📡 Job {jobid} deleted");
                let _ = app.emit(JOB_CACHE_CHANGED, jobid);
            }
            Ok(())
        } else {
            Err(crate::localized_error!("backendErrors.job.notFound"))
        }
    }

    /// A generic function to update a job using a closure
    pub async fn update_job(
        &self,
        jobid: u64,
        update_fn: impl FnOnce(&mut JobInfo),
        app: Option<&AppHandle>,
    ) -> Result<JobInfo, String> {
        let mut jobs = self.jobs.write().await;
        if let Some(job) = jobs.get_mut(&jobid) {
            update_fn(job);
            let result = job.clone();
            drop(jobs);

            if let Some(app) = app {
                info!("📡 Job {jobid} updated");
                let _ = app.emit(JOB_CACHE_CHANGED, jobid);
            }
            Ok(result)
        } else {
            Err(crate::localized_error!("backendErrors.job.notFound"))
        }
    }

    pub async fn update_job_stats(&self, jobid: u64, stats: Value) -> Result<(), String> {
        // Stats updates are frequent, don't emit individually
        let mut jobs = self.jobs.write().await;
        if let Some(job) = jobs.get_mut(&jobid) {
            job.stats = Some(stats);
            Ok(())
        } else {
            Err(crate::localized_error!("backendErrors.job.notFound"))
        }
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
            |job| {
                if success {
                    job.status = JobStatus::Completed;
                    job.error = None;
                } else {
                    job.status = JobStatus::Failed;
                    job.error = error;
                }
            },
            app,
        )
        .await
    }

    pub async fn stop_job(&self, jobid: u64, app: Option<&AppHandle>) -> Result<(), String> {
        self.update_job(
            jobid,
            |job| {
                job.status = JobStatus::Stopped;
            },
            app,
        )
        .await?;
        Ok(())
    }

    pub async fn get_jobs(&self) -> Vec<JobInfo> {
        self.jobs.read().await.values().cloned().collect()
    }

    pub async fn get_active_jobs(&self) -> Vec<JobInfo> {
        let jobs = self.jobs.read().await;
        jobs.values()
            .filter(|job| job.status == JobStatus::Running)
            .cloned()
            .collect()
    }

    pub async fn get_job(&self, jobid: u64) -> Option<JobInfo> {
        self.jobs.read().await.get(&jobid).cloned()
    }

    /// Checks if a job of a specific type is already running for a specific remote.
    pub async fn is_job_running(
        &self,
        remote_name: &str,
        job_type: JobType,
        profile: Option<&str>,
    ) -> bool {
        let jobs = self.jobs.read().await;
        jobs.values().any(|job| {
            job.remote_name == remote_name
                && job.job_type == job_type
                && job.status == JobStatus::Running
                && job.profile.as_deref() == profile
        })
    }
    /// Get jobs filtered by source
    pub async fn get_jobs_by_source(&self, source: &str) -> Vec<JobInfo> {
        self.jobs
            .read()
            .await
            .values()
            .filter(|job| job.origin.as_ref().map(|o| o.as_str()) == Some(source))
            .cloned()
            .collect()
    }

    /// Rename a profile in all matching running jobs
    /// Returns the number of jobs updated
    /// Rename a profile in all matching jobs and emit `JOB_CACHE_CHANGED` for each update.
    /// Returns the number of jobs updated.
    pub async fn rename_profile(
        &self,
        remote_name: &str,
        old_name: &str,
        new_name: &str,
        app: Option<&AppHandle>,
    ) -> usize {
        let mut jobs = self.jobs.write().await;
        let mut updated_count = 0;

        for job in jobs.values_mut() {
            if job.remote_name == remote_name && job.profile.as_deref() == Some(old_name) {
                job.profile = Some(new_name.to_string());
                updated_count += 1;

                // Emit change per-job so UI/clients can react to the rename immediately.
                if let Some(app) = app {
                    let _ = app.emit(JOB_CACHE_CHANGED, job.jobid);
                }
            }
        }

        updated_count
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

    fn mock_job(jobid: u64, remote: &str, job_type: JobType, profile: Option<&str>) -> JobInfo {
        JobInfo {
            jobid,
            remote_name: remote.to_string(),
            job_type,
            source: format!("{}path", remote),
            destination: "/local/path".to_string(),
            start_time: chrono::Utc::now(),
            profile: profile.map(|s| s.to_string()),
            status: JobStatus::Running,
            error: None,
            stats: None,
            group: format!("job/{}", jobid),
            origin: None,
            backend_name: Some("Local".to_string()),
            execute_id: None,
        }
    }

    #[tokio::test]
    async fn test_add_and_get_job() {
        let cache = JobCache::new();
        let job = mock_job(1, "gdrive:", JobType::Sync, Some("default"));

        cache.add_job(job.clone(), None).await;

        let retrieved = cache.get_job(1).await;
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().remote_name, "gdrive:");
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

        let result = cache.delete_job(1, None).await;
        assert!(result.is_ok());
        assert_eq!(cache.get_jobs().await.len(), 1);

        // Deleting non-existent job should fail
        let result = cache.delete_job(999, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_complete_job() {
        let cache = JobCache::new();
        cache
            .add_job(mock_job(1, "gdrive:", JobType::Sync, None), None)
            .await;

        // Complete successfully
        cache.complete_job(1, true, None, None).await.unwrap();
        let job = cache.get_job(1).await.unwrap();
        assert_eq!(job.status, JobStatus::Completed);

        // Add another and fail it
        cache
            .add_job(mock_job(2, "s3:", JobType::Copy, None), None)
            .await;
        cache
            .complete_job(2, false, Some("failed".to_string()), None)
            .await
            .unwrap();
        let job = cache.get_job(2).await.unwrap();
        assert_eq!(job.status, JobStatus::Failed);
        assert_eq!(job.error, Some("failed".to_string()));
    }

    #[tokio::test]
    async fn test_stop_job() {
        let cache = JobCache::new();
        cache
            .add_job(mock_job(1, "gdrive:", JobType::Sync, None), None)
            .await;

        cache.stop_job(1, None).await.unwrap();

        let job = cache.get_job(1).await.unwrap();
        assert_eq!(job.status, JobStatus::Stopped);
    }

    #[tokio::test]
    async fn test_get_active_jobs() {
        let cache = JobCache::new();
        cache
            .add_job(mock_job(1, "gdrive:", JobType::Sync, None), None)
            .await;
        cache
            .add_job(mock_job(2, "s3:", JobType::Copy, None), None)
            .await;
        cache
            .add_job(mock_job(3, "b2:", JobType::Move, None), None)
            .await;

        // Stop one, complete one
        cache.stop_job(1, None).await.unwrap();
        cache.complete_job(2, true, None, None).await.unwrap();

        let active = cache.get_active_jobs().await;
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].jobid, 3);
    }

    #[tokio::test]
    async fn test_is_job_running() {
        let cache = JobCache::new();
        cache
            .add_job(mock_job(1, "gdrive:", JobType::Sync, Some("default")), None)
            .await;

        // Should find running job
        assert!(
            cache
                .is_job_running("gdrive:", JobType::Sync, Some("default"))
                .await
        );

        // Wrong remote
        assert!(
            !cache
                .is_job_running("s3:", JobType::Sync, Some("default"))
                .await
        );

        // Wrong job type
        assert!(
            !cache
                .is_job_running("gdrive:", JobType::Copy, Some("default"))
                .await
        );

        // Wrong profile
        assert!(
            !cache
                .is_job_running("gdrive:", JobType::Sync, Some("other"))
                .await
        );

        // Stop the job
        cache.stop_job(1, None).await.unwrap();
        assert!(
            !cache
                .is_job_running("gdrive:", JobType::Sync, Some("default"))
                .await
        );
    }

    #[tokio::test]
    async fn test_rename_profile() {
        let cache = JobCache::new();
        cache
            .add_job(
                mock_job(1, "gdrive:", JobType::Sync, Some("old_profile")),
                None,
            )
            .await;
        cache
            .add_job(
                mock_job(2, "gdrive:", JobType::Copy, Some("old_profile")),
                None,
            )
            .await;
        cache
            .add_job(mock_job(3, "s3:", JobType::Sync, Some("old_profile")), None)
            .await; // Different remote

        let updated = cache
            .rename_profile("gdrive:", "old_profile", "new_profile", None)
            .await;
        assert_eq!(updated, 2); // Only gdrive jobs renamed

        // Verify
        let job1 = cache.get_job(1).await.unwrap();
        assert_eq!(job1.profile, Some("new_profile".to_string()));

        let job3 = cache.get_job(3).await.unwrap();
        assert_eq!(job3.profile, Some("old_profile".to_string())); // Unchanged
    }
}
