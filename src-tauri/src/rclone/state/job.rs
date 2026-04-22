use log::info;
use serde_json::Value;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

use crate::utils::types::{
    events::JOB_CACHE_CHANGED,
    jobs::{BatchMasterJob, JobCache, JobInfo, JobStatus, JobType},
};

impl JobCache {
    pub fn new() -> Self {
        Self {
            jobs: RwLock::new(HashMap::new()),
            batch_jobs: RwLock::new(HashMap::new()),
        }
    }

    pub async fn set_all_jobs(&self, jobs: Vec<JobInfo>) {
        *self.jobs.write().await = jobs.into_iter().map(|j| (j.jobid, j)).collect();
    }

    pub async fn add_job(&self, job: JobInfo, app: Option<&AppHandle>) {
        let jobid = job.jobid;
        self.jobs.write().await.insert(jobid, job);
        self.emit(app, jobid);
    }

    pub async fn delete_job(&self, jobid: u64, app: Option<&AppHandle>) -> Result<(), String> {
        self.jobs
            .write()
            .await
            .remove(&jobid)
            .ok_or_else(|| crate::localized_error!("backendErrors.job.notFound"))?;
        self.emit(app, jobid);
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
        self.emit(app, jobid);
        Ok(result)
    }

    pub async fn update_job_stats(&self, jobid: u64, stats: Value) -> Result<(), String> {
        self.update_job(jobid, |job| job.stats = Some(stats), None)
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
            |job| {
                if job.status != JobStatus::Stopped {
                    job.status = if success {
                        job.error = None;
                        JobStatus::Completed
                    } else {
                        job.error = error;
                        JobStatus::Failed
                    };
                }
                job.end_time = Some(chrono::Utc::now());
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
                job.end_time = Some(chrono::Utc::now());
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
            .filter(|j| j.status == JobStatus::Running)
            .cloned()
            .collect()
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
                && j.status == JobStatus::Running
                && j.profile.as_deref() == profile
        })
    }

    pub async fn delete_jobs_by_remote(&self, remote_name: &str, app: Option<&AppHandle>) {
        self.delete_jobs_matching(|j| j.remote_name == remote_name, app)
            .await;
        info!("📡 All jobs for remote {remote_name} deleted");
    }

    pub async fn delete_jobs_by_profile(
        &self,
        remote_name: &str,
        profile_name: &str,
        app: Option<&AppHandle>,
    ) {
        self.delete_jobs_matching(
            |j| j.remote_name == remote_name && j.profile.as_deref() == Some(profile_name),
            app,
        )
        .await;
        info!("📡 All jobs for profile {profile_name} on remote {remote_name} deleted");
    }

    // ---- Batch jobs ----

    pub async fn add_batch_job(&self, batch_job: BatchMasterJob, app: Option<&AppHandle>) {
        let batch_id = batch_job.batch_id.clone();
        self.batch_jobs
            .write()
            .await
            .insert(batch_id.clone(), batch_job);
        self.emit_str(app, &batch_id);
    }

    pub async fn get_batch_job(&self, batch_id: &str) -> Option<BatchMasterJob> {
        self.batch_jobs.read().await.get(batch_id).cloned()
    }

    pub async fn get_batch_jobs(&self) -> Vec<BatchMasterJob> {
        self.batch_jobs.read().await.values().cloned().collect()
    }

    pub async fn update_batch_job(
        &self,
        batch_id: &str,
        update_fn: impl FnOnce(&mut BatchMasterJob),
        app: Option<&AppHandle>,
    ) -> Result<BatchMasterJob, String> {
        let mut batches = self.batch_jobs.write().await;
        let batch = batches
            .get_mut(batch_id)
            .ok_or_else(|| crate::localized_error!("backendErrors.job.notFound"))?;
        update_fn(batch);
        let result = batch.clone();
        drop(batches);
        self.emit_str(app, batch_id);
        Ok(result)
    }

    // ---- Private helpers ----

    fn emit(&self, app: Option<&AppHandle>, jobid: u64) {
        if let Some(app) = app {
            let _ = app.emit(JOB_CACHE_CHANGED, jobid);
        }
    }

    fn emit_str(&self, app: Option<&AppHandle>, id: &str) {
        if let Some(app) = app {
            let _ = app.emit(JOB_CACHE_CHANGED, id);
        }
    }

    async fn delete_jobs_matching(
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
        for id in to_remove {
            jobs.remove(&id);
            self.emit(app, id);
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
    use crate::rclone::backend::types::default_backend_name;

    use super::*;

    fn mock_job(jobid: u64, remote: &str, job_type: JobType, profile: Option<&str>) -> JobInfo {
        JobInfo {
            jobid,
            remote_name: remote.to_string(),
            job_type,
            source: format!("{}path", remote),
            destination: "/local/path".to_string(),
            start_time: chrono::Utc::now(),
            end_time: None,
            profile: profile.map(str::to_string),
            status: JobStatus::Running,
            error: None,
            stats: None,
            uploaded_files: Vec::new(),
            group: format!("job/{jobid}"),
            origin: None,
            backend_name: default_backend_name(),
            execute_id: None,
            parent_batch_id: None,
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
        assert!(cache.delete_job(999, None).await.is_err());
    }

    #[tokio::test]
    async fn test_complete_job() {
        let cache = JobCache::new();
        cache
            .add_job(mock_job(1, "gdrive:", JobType::Sync, None), None)
            .await;
        cache.complete_job(1, true, None, None).await.unwrap();
        assert_eq!(cache.get_job(1).await.unwrap().status, JobStatus::Completed);

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
        assert_eq!(cache.get_job(1).await.unwrap().status, JobStatus::Stopped);
    }

    #[tokio::test]
    async fn test_get_active_jobs() {
        let cache = JobCache::new();
        for (id, remote, jt) in [
            (1, "gdrive:", JobType::Sync),
            (2, "s3:", JobType::Copy),
            (3, "b2:", JobType::Move),
        ] {
            cache.add_job(mock_job(id, remote, jt, None), None).await;
        }
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

        assert!(
            cache
                .is_job_running("gdrive:", JobType::Sync, Some("default"))
                .await
        );
        assert!(
            !cache
                .is_job_running("s3:", JobType::Sync, Some("default"))
                .await
        );
        assert!(
            !cache
                .is_job_running("gdrive:", JobType::Copy, Some("default"))
                .await
        );
        assert!(
            !cache
                .is_job_running("gdrive:", JobType::Sync, Some("other"))
                .await
        );

        cache.stop_job(1, None).await.unwrap();
        assert!(
            !cache
                .is_job_running("gdrive:", JobType::Sync, Some("default"))
                .await
        );
    }
}
