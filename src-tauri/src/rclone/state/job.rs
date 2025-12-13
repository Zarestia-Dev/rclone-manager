use serde_json::Value;
use tauri::State;
use tokio::sync::RwLock;

use crate::utils::types::all_types::{JobCache, JobInfo, JobStatus};

impl JobCache {
    pub fn new() -> Self {
        Self {
            jobs: RwLock::new(Vec::new()),
        }
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

#[tauri::command]
pub async fn get_jobs(job_cache: State<'_, JobCache>) -> Result<Vec<JobInfo>, String> {
    Ok(job_cache.get_jobs().await)
}

#[tauri::command]
pub async fn delete_job(job_cache: State<'_, JobCache>, jobid: u64) -> Result<(), String> {
    job_cache.delete_job(jobid).await
}

#[tauri::command]
pub async fn get_job_status(
    job_cache: State<'_, JobCache>,
    jobid: u64,
) -> Result<Option<JobInfo>, String> {
    Ok(job_cache.get_job(jobid).await)
}

#[tauri::command]
pub async fn get_active_jobs(job_cache: State<'_, JobCache>) -> Result<Vec<JobInfo>, String> {
    Ok(job_cache.get_active_jobs().await)
}

/// Rename a profile in all cached running jobs
#[tauri::command]
pub async fn rename_profile_in_cache(
    job_cache: State<'_, JobCache>,
    remote_name: String,
    old_name: String,
    new_name: String,
) -> Result<usize, String> {
    Ok(job_cache
        .rename_profile(&remote_name, &old_name, &new_name)
        .await)
}

impl Default for JobCache {
    fn default() -> Self {
        Self::new()
    }
}
