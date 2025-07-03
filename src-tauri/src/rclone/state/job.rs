use once_cell::sync::Lazy;
use serde_json::Value;
use tokio::sync::RwLock;

use crate::utils::types::{JobCache, JobInfo, JobStatus};

pub static JOB_CACHE: Lazy<JobCache> = Lazy::new(|| JobCache {
    jobs: RwLock::new(Vec::new()),
});

impl JobCache {
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

    pub async fn update_job_stats(&self, jobid: u64, stats: Value) -> Result<(), String> {
        let mut jobs = self.jobs.write().await;
        if let Some(job) = jobs.iter_mut().find(|j| j.jobid == jobid) {
            job.stats = Some(stats);
            Ok(())
        } else {
            Err("JobInfo not found".to_string())
        }
    }

    pub async fn complete_job(&self, jobid: u64, success: bool) -> Result<(), String> {
        let mut jobs = self.jobs.write().await;
        if let Some(job) = jobs.iter_mut().find(|j| j.jobid == jobid) {
            job.status = if success {
                JobStatus::Completed
            } else {
                JobStatus::Failed
            };
            Ok(())
        } else {
            Err("JobInfo not found".to_string())
        }
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

    pub async fn stop_job(&self, jobid: u64) -> Result<(), String> {
        let mut jobs = self.jobs.write().await;
        if let Some(job) = jobs.iter_mut().find(|j| j.jobid == jobid) {
            job.status = JobStatus::Stopped;
            Ok(())
        } else {
            Err("JobInfo not found".to_string())
        }
    }
}

#[tauri::command]
pub async fn get_jobs() -> Result<Vec<JobInfo>, String> {
    Ok(JOB_CACHE.get_jobs().await)
}

#[tauri::command]
pub async fn delete_job(jobid: u64) -> Result<(), String> {
    JOB_CACHE.delete_job(jobid).await
}

#[tauri::command]
pub async fn get_job_status(jobid: u64) -> Result<Option<JobInfo>, String> {
    Ok(JOB_CACHE.get_job(jobid).await)
}

#[tauri::command]
pub async fn get_active_jobs() -> Result<Vec<JobInfo>, String> {
    Ok(JOB_CACHE.get_active_jobs().await)
}
