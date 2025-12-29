use serde_json::Value;
use tokio::sync::RwLock;

use crate::utils::types::all_types::{JobCache, JobInfo, JobStatus};

impl JobCache {
    pub fn new() -> Self {
        Self {
            jobs: RwLock::new(Vec::new()),
        }
    }

    pub async fn clear(&self) {
        let mut jobs = self.jobs.write().await;
        jobs.clear();
    }

    pub async fn add_job(&self, job: JobInfo) {
        let mut jobs = self.jobs.write().await;
        jobs.push(job);
    }

    pub async fn delete_job(&self, jobid: u64) -> Result<(), String> {
        let mut jobs = self.jobs.write().await;
        let len_before = jobs.len();
        jobs.retain(|j| j.jobid != jobid);
        if jobs.len() < len_before {
            Ok(())
        } else {
            Err("JobInfo not found".to_string())
        }
    }

    /// A generic function to update a job using a closure
    pub async fn update_job(
        &self,
        jobid: u64,
        update_fn: impl FnOnce(&mut JobInfo),
    ) -> Result<JobInfo, String> {
        let mut jobs = self.jobs.write().await;
        if let Some(job) = jobs.iter_mut().find(|j| j.jobid == jobid) {
            update_fn(job);
            Ok(job.clone())
        } else {
            Err("JobInfo not found".to_string())
        }
    }

    pub async fn update_job_stats(&self, jobid: u64, stats: Value) -> Result<(), String> {
        self.update_job(jobid, |job| {
            job.stats = Some(stats);
        })
        .await?;
        Ok(())
    }

    pub async fn complete_job(&self, jobid: u64, success: bool) -> Result<(), String> {
        self.update_job(jobid, |job| {
            job.status = if success {
                JobStatus::Completed
            } else {
                JobStatus::Failed
            };
        })
        .await?;
        Ok(())
    }

    pub async fn stop_job(&self, jobid: u64) -> Result<(), String> {
        self.update_job(jobid, |job| {
            job.status = JobStatus::Stopped;
        })
        .await?;
        Ok(())
    }

    pub async fn get_jobs(&self) -> Vec<JobInfo> {
        self.jobs.read().await.clone()
    }

    pub async fn get_active_jobs(&self) -> Vec<JobInfo> {
        let jobs = self.get_jobs().await;
        jobs.into_iter()
            .filter(|job| job.status == JobStatus::Running)
            .collect()
    }

    pub async fn get_job(&self, jobid: u64) -> Option<JobInfo> {
        self.jobs
            .read()
            .await
            .iter()
            .find(|j| j.jobid == jobid)
            .cloned()
    }

    /// Checks if a job of a specific type is already running for a specific remote.
    pub async fn is_job_running(
        &self,
        remote_name: &str,
        job_type: &str,
        profile: Option<&str>,
    ) -> bool {
        let jobs = self.jobs.read().await;
        jobs.iter().any(|job| {
            job.remote_name == remote_name
                && job.job_type == job_type
                && job.status == JobStatus::Running
                && job.profile.as_deref() == profile
        })
    }
    /// Get jobs filtered by source_ui
    pub async fn get_jobs_by_source(&self, source: &str) -> Vec<JobInfo> {
        self.jobs
            .read()
            .await
            .iter()
            .filter(|job| job.source_ui.as_deref() == Some(source))
            .cloned()
            .collect()
    }

    /// Rename a profile in all matching running jobs
    /// Returns the number of jobs updated
    pub async fn rename_profile(&self, remote_name: &str, old_name: &str, new_name: &str) -> usize {
        let mut jobs = self.jobs.write().await;
        let mut updated_count = 0;

        for job in jobs.iter_mut() {
            if job.remote_name == remote_name && job.profile.as_deref() == Some(old_name) {
                job.profile = Some(new_name.to_string());
                updated_count += 1;
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

    fn mock_job(jobid: u64, remote: &str, job_type: &str, profile: Option<&str>) -> JobInfo {
        JobInfo {
            jobid,
            remote_name: remote.to_string(),
            job_type: job_type.to_string(),
            source: format!("{}path", remote),
            destination: "/local/path".to_string(),
            start_time: chrono::Utc::now(),
            profile: profile.map(|s| s.to_string()),
            status: JobStatus::Running,
            stats: None,
            group: format!("job/{}", jobid),
            source_ui: None,
            backend_name: Some("Local".to_string()),
        }
    }

    #[tokio::test]
    async fn test_add_and_get_job() {
        let cache = JobCache::new();
        let job = mock_job(1, "gdrive:", "sync", Some("default"));

        cache.add_job(job.clone()).await;

        let retrieved = cache.get_job(1).await;
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().remote_name, "gdrive:");
    }

    #[tokio::test]
    async fn test_delete_job() {
        let cache = JobCache::new();
        cache.add_job(mock_job(1, "gdrive:", "sync", None)).await;
        cache.add_job(mock_job(2, "s3:", "copy", None)).await;

        assert_eq!(cache.get_jobs().await.len(), 2);

        let result = cache.delete_job(1).await;
        assert!(result.is_ok());
        assert_eq!(cache.get_jobs().await.len(), 1);

        // Deleting non-existent job should fail
        let result = cache.delete_job(999).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_complete_job() {
        let cache = JobCache::new();
        cache.add_job(mock_job(1, "gdrive:", "sync", None)).await;

        // Complete successfully
        cache.complete_job(1, true).await.unwrap();
        let job = cache.get_job(1).await.unwrap();
        assert_eq!(job.status, JobStatus::Completed);

        // Add another and fail it
        cache.add_job(mock_job(2, "s3:", "copy", None)).await;
        cache.complete_job(2, false).await.unwrap();
        let job = cache.get_job(2).await.unwrap();
        assert_eq!(job.status, JobStatus::Failed);
    }

    #[tokio::test]
    async fn test_stop_job() {
        let cache = JobCache::new();
        cache.add_job(mock_job(1, "gdrive:", "sync", None)).await;

        cache.stop_job(1).await.unwrap();

        let job = cache.get_job(1).await.unwrap();
        assert_eq!(job.status, JobStatus::Stopped);
    }

    #[tokio::test]
    async fn test_get_active_jobs() {
        let cache = JobCache::new();
        cache.add_job(mock_job(1, "gdrive:", "sync", None)).await;
        cache.add_job(mock_job(2, "s3:", "copy", None)).await;
        cache.add_job(mock_job(3, "b2:", "move", None)).await;

        // Stop one, complete one
        cache.stop_job(1).await.unwrap();
        cache.complete_job(2, true).await.unwrap();

        let active = cache.get_active_jobs().await;
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].jobid, 3);
    }

    #[tokio::test]
    async fn test_is_job_running() {
        let cache = JobCache::new();
        cache
            .add_job(mock_job(1, "gdrive:", "sync", Some("default")))
            .await;

        // Should find running job
        assert!(
            cache
                .is_job_running("gdrive:", "sync", Some("default"))
                .await
        );

        // Wrong remote
        assert!(!cache.is_job_running("s3:", "sync", Some("default")).await);

        // Wrong job type
        assert!(
            !cache
                .is_job_running("gdrive:", "copy", Some("default"))
                .await
        );

        // Wrong profile
        assert!(!cache.is_job_running("gdrive:", "sync", Some("other")).await);

        // Stop the job
        cache.stop_job(1).await.unwrap();
        assert!(
            !cache
                .is_job_running("gdrive:", "sync", Some("default"))
                .await
        );
    }

    #[tokio::test]
    async fn test_rename_profile() {
        let cache = JobCache::new();
        cache
            .add_job(mock_job(1, "gdrive:", "sync", Some("old_profile")))
            .await;
        cache
            .add_job(mock_job(2, "gdrive:", "copy", Some("old_profile")))
            .await;
        cache
            .add_job(mock_job(3, "s3:", "sync", Some("old_profile")))
            .await; // Different remote

        let updated = cache
            .rename_profile("gdrive:", "old_profile", "new_profile")
            .await;
        assert_eq!(updated, 2); // Only gdrive jobs renamed

        // Verify
        let job1 = cache.get_job(1).await.unwrap();
        assert_eq!(job1.profile, Some("new_profile".to_string()));

        let job3 = cache.get_job(3).await.unwrap();
        assert_eq!(job3.profile, Some("old_profile".to_string())); // Unchanged
    }

    #[tokio::test]
    async fn test_clear() {
        let cache = JobCache::new();
        cache.add_job(mock_job(1, "gdrive:", "sync", None)).await;
        cache.add_job(mock_job(2, "s3:", "copy", None)).await;

        assert_eq!(cache.get_jobs().await.len(), 2);

        cache.clear().await;
        assert_eq!(cache.get_jobs().await.len(), 0);
    }
}
