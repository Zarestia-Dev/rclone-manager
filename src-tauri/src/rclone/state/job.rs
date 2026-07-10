use std::collections::HashMap;

use log::info;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

use crate::utils::types::{
    events::JOB_CACHE_CHANGED,
    jobs::{JobCache, JobInfo, JobStatus, JobType, ResolveState},
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
        };

        self.add_job(job, app).await;
        jobid
    }

    pub async fn set_all_jobs(&self, jobs: Vec<JobInfo>) {
        *self.jobs.write().await = jobs.into_iter().map(|j| (j.jobid, j)).collect();
    }

    pub async fn add_job(&self, job: JobInfo, app: Option<&AppHandle>) {
        let jobid = job.jobid;
        let parent_id = job.parent_job_id;
        {
            let mut jobs = self.jobs.write().await;
            jobs.insert(jobid, job.clone());
            if let Some(p_id) = parent_id {
                Self::link_resolving_jobs_internal(&mut jobs, p_id);
            }
        }
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

        let mut removed_jobs = Vec::with_capacity(ids_to_delete.len());
        for id in &ids_to_delete {
            if let Some(job) = jobs.remove(id) {
                if let Some(parent_id) = job.parent_job_id
                    && !ids_to_delete.contains(&parent_id)
                {
                    Self::link_resolving_jobs_internal(&mut jobs, parent_id);
                }
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

        let parent_id = job.parent_job_id;
        let is_check = job.job_type == JobType::Check || job.job_type == JobType::CryptCheck;

        let mut result = job.clone();
        let mut parent_job_to_notify: Option<JobInfo> = None;

        if let Some(p_id) = parent_id {
            Self::link_resolving_jobs_internal(&mut jobs, p_id);
            if let Some(p_job) = jobs.get(&p_id) {
                parent_job_to_notify = Some(p_job.clone());
            }
        }
        if is_check {
            Self::link_resolving_jobs_internal(&mut jobs, jobid);
            if let Some(updated_job) = jobs.get(&jobid) {
                result = updated_job.clone();
            }
        }

        drop(jobs);

        if let Some(ref p_job) = parent_job_to_notify {
            self.notify_change(app, Some(p_job));
        }
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
                j.normalize_job_stats();
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
                    j.normalize_job_stats();
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
                    j.normalize_job_stats();
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

    fn link_resolving_jobs_internal(jobs: &mut HashMap<u64, JobInfo>, parent_job_id: u64) {
        // Pre-compute normalized sources for each candidate child job once,
        // instead of redoing `src.replace('\\', "/")` for every completed item.
        // The previous loop was O(N * M * K) String allocations; this drops the
        // per-item work to a HashMap/array lookup.
        struct CandidateJob {
            jobid: u64,
            job_type: JobType,
            status: JobStatus,
            error: Option<String>,
            stats: Option<Value>,
            // Pre-normalized sources (backslashes → forward slashes).
            norm_sources: Vec<String>,
        }

        let child_jobs: Vec<CandidateJob> = jobs
            .values()
            .filter(|j| j.parent_job_id == Some(parent_job_id))
            .map(|j| CandidateJob {
                jobid: j.jobid,
                job_type: j.job_type.clone(),
                status: j.status.clone(),
                error: j.error.clone(),
                stats: j.stats.clone(),
                norm_sources: j.source.iter().map(|s| s.replace('\\', "/")).collect(),
            })
            .collect();

        if let Some(parent_job) = jobs.get_mut(&parent_job_id) {
            let completed = match parent_job
                .stats
                .as_mut()
                .and_then(|s| s.get_mut("completed"))
                .and_then(|c| c.as_array_mut())
            {
                Some(ct) => ct,
                None => return,
            };

            for item in completed {
                let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let normalized_item_name = name.replace('\\', "/");
                // Pre-compute the suffixes we'll match against once per item.
                let suffix_slash = format!("/{normalized_item_name}");
                let suffix_colon = format!(":{normalized_item_name}");
                let item_src_fs = item
                    .get("srcFs")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .replace('\\', "/");
                let item_dst_fs = item
                    .get("dstFs")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .replace('\\', "/");
                let mut matching_child_job: Option<&CandidateJob> = None;

                for job in &child_jobs {
                    if job.job_type == JobType::Check || job.job_type == JobType::CryptCheck {
                        continue;
                    }

                    let has_direct_match = job.norm_sources.iter().any(|norm_src| {
                        norm_src.ends_with(&suffix_slash) || norm_src.ends_with(&suffix_colon)
                    });

                    if has_direct_match {
                        if matching_child_job.is_none()
                            || job.jobid > matching_child_job.unwrap().jobid
                        {
                            matching_child_job = Some(job);
                        }
                        continue;
                    }

                    let is_folder_match = job.norm_sources.iter().any(|norm_src| {
                        let colon_idx = norm_src.find(':');
                        let remote = if let Some(idx) = colon_idx {
                            &norm_src[..=idx]
                        } else {
                            ""
                        };
                        let folder_path = if let Some(idx) = colon_idx {
                            &norm_src[idx + 1..]
                        } else {
                            norm_src.as_str()
                        };

                        let remote_matches =
                            item_src_fs.starts_with(remote) || item_dst_fs.starts_with(remote);

                        if !remote_matches {
                            return false;
                        }
                        if folder_path.is_empty() || folder_path == "/" {
                            return true;
                        }

                        let clean_folder = folder_path.trim_end_matches('/');
                        normalized_item_name == clean_folder
                            || normalized_item_name.starts_with(&format!("{clean_folder}/"))
                    });

                    if is_folder_match
                        && (matching_child_job.is_none()
                            || job.jobid > matching_child_job.unwrap().jobid)
                    {
                        matching_child_job = Some(job);
                    }
                }

                if let Some(obj) = item.as_object_mut() {
                    obj.insert(
                        "resolveJobId".to_string(),
                        serde_json::json!(matching_child_job.map(|j| j.jobid)),
                    );

                    if let Some(child_job) = matching_child_job {
                        let mut percentage = 0;
                        let mut is_preparing = true;
                        let mut bytes = 0;
                        let mut size = 0;
                        let mut speed = 0.0;
                        let mut speed_class = "speed-slow".to_string();
                        let mut eta = 0;

                        if let Some(stats) = &child_job.stats {
                            let total_bytes = stats
                                .get("totalBytes")
                                .and_then(|v| v.as_i64())
                                .unwrap_or(0);
                            let current_bytes =
                                stats.get("bytes").and_then(|v| v.as_i64()).unwrap_or(0);
                            let current_speed =
                                stats.get("speed").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let current_eta =
                                stats.get("eta").and_then(|v| v.as_u64()).unwrap_or(0);

                            if total_bytes > 0 {
                                percentage =
                                    ((current_bytes as f64 / total_bytes as f64) * 100.0) as u8;
                                is_preparing = false;
                                bytes = current_bytes;
                                size = total_bytes;
                                speed = current_speed;
                                eta = current_eta;
                            } else if let Some(transferring) =
                                stats.get("transferring").and_then(|v| v.as_array())
                                && !transferring.is_empty()
                            {
                                let tf = transferring
                                    .iter()
                                    .find(|t| {
                                        let t_name = t
                                            .get("name")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .replace('\\', "/");
                                        t_name == normalized_item_name
                                            || t_name.ends_with(&suffix_slash)
                                    })
                                    .unwrap_or(&transferring[0]);

                                percentage =
                                    tf.get("percentage").and_then(|v| v.as_u64()).unwrap_or(0)
                                        as u8;
                                is_preparing = false;
                                bytes = tf.get("bytes").and_then(|v| v.as_i64()).unwrap_or(0);
                                size = tf.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
                                speed = tf.get("speed").and_then(|v| v.as_f64()).unwrap_or(0.0);
                                eta = tf.get("eta").and_then(|v| v.as_u64()).unwrap_or(0);
                            }
                        }

                        if speed > 1024.0 * 1024.0 * 5.0 {
                            speed_class = "speed-fast".to_string();
                        } else if speed > 1024.0 * 1024.0 {
                            speed_class = "speed-medium".to_string();
                        }

                        let status_str = serde_json::to_value(&child_job.status)
                            .ok()
                            .and_then(|v| v.as_str().map(String::from))
                            .unwrap_or_else(|| "Running".to_string());

                        // Overwrite item status if resolved
                        if child_job.status == JobStatus::Completed {
                            obj.insert("status".to_string(), serde_json::json!("checked"));
                        } else if child_job.status == JobStatus::Failed {
                            obj.insert("status".to_string(), serde_json::json!("failed"));
                            obj.insert(
                                "error".to_string(),
                                serde_json::json!(
                                    child_job
                                        .error
                                        .clone()
                                        .unwrap_or_else(|| "Resolve job failed".to_string())
                                ),
                            );
                        }

                        let resolve_state = ResolveState {
                            status: status_str,
                            percentage,
                            is_preparing,
                            bytes,
                            size,
                            speed,
                            speed_class,
                            eta,
                            error: child_job.error.clone(),
                        };
                        obj.insert(
                            "resolveState".to_string(),
                            serde_json::to_value(resolve_state).unwrap_or(Value::Null),
                        );
                    } else {
                        obj.insert("resolveState".to_string(), Value::Null);
                    }
                }
            }
        }
    }

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
