use std::collections::HashMap;

use serde_json::Value;

use crate::utils::types::jobs::{JobInfo, JobStatus, JobType, ResolveState};

struct CandidateJob {
    jobid: u64,
    job_type: JobType,
    status: JobStatus,
    error: Option<String>,
    stats: Option<Value>,
    // Pre-normalized sources (backslashes -> forward slashes).
    norm_sources: Vec<String>,
}

/// Links child resolving jobs with completed transfers in a parent job,
/// calculating progress, speed, ETA, and resolve states.
pub fn link_resolving_jobs(jobs: &mut HashMap<u64, JobInfo>, parent_job_id: u64) {
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
                    if matching_child_job.is_none() || job.jobid > matching_child_job.unwrap().jobid
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
                        let current_eta = stats.get("eta").and_then(|v| v.as_u64()).unwrap_or(0);

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
                                tf.get("percentage").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
                            is_preparing = false;
                            bytes = tf.get("bytes").and_then(|v| v.as_i64()).unwrap_or(0);
                            size = tf.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
                            speed = tf.get("speed").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            eta = tf.get("eta").and_then(|v| v.as_u64()).unwrap_or(0);
                        }
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

/// Cleans up transient transferring metrics when a job finishes or is stopped.
pub fn sanitize_finished_stats(stats: &mut Value) {
    if let Some(obj) = stats.as_object_mut() {
        obj.insert("transferring".to_string(), serde_json::json!([]));
        obj.insert("speed".to_string(), serde_json::json!(0.0));
        obj.insert("eta".to_string(), Value::Null);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rclone::backend::types::default_backend_name;

    fn mock_job(jobid: u64, remote: &str, job_type: JobType) -> JobInfo {
        JobInfo {
            jobid,
            remote_name: remote.to_string(),
            job_type,
            source: vec![format!("{remote}path/file.txt")],
            destination: "/local/path".to_string(),
            start_time: chrono::Utc::now(),
            end_time: None,
            status: JobStatus::Running,
            error: None,
            stats: None,
            group: format!("job/{jobid}"),
            profile: None,
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

    #[test]
    fn test_sanitize_finished_stats() {
        let mut stats = serde_json::json!({
            "speed": 1024.0,
            "eta": 30,
            "transferring": [{"name": "a.txt"}],
            "bytes": 500
        });
        sanitize_finished_stats(&mut stats);
        assert_eq!(stats["speed"], 0.0);
        assert!(stats["eta"].is_null());
        assert_eq!(stats["transferring"].as_array().unwrap().len(), 0);
        assert_eq!(stats["bytes"], 500);
    }

    #[test]
    fn test_link_resolving_jobs_matching() {
        let mut jobs = HashMap::new();

        let mut parent = mock_job(1, "gdrive:", JobType::Check);
        parent.stats = Some(serde_json::json!({
            "completed": [
                {
                    "name": "folder/doc.pdf",
                    "srcFs": "gdrive:",
                    "dstFs": "local:",
                    "status": "differ"
                }
            ]
        }));
        jobs.insert(1, parent);

        let mut child = mock_job(2, "gdrive:", JobType::Copy);
        child.parent_job_id = Some(1);
        child.source = vec!["gdrive:folder/doc.pdf".to_string()];
        child.stats = Some(serde_json::json!({
            "bytes": 500,
            "totalBytes": 1000,
            "speed": 2048.0,
            "eta": 10
        }));
        jobs.insert(2, child);

        link_resolving_jobs(&mut jobs, 1);

        let parent_job = jobs.get(&1).unwrap();
        let stats = parent_job.stats.as_ref().unwrap();
        let completed = stats["completed"].as_array().unwrap();
        assert_eq!(completed[0]["resolveJobId"], 2);

        let resolve_state = &completed[0]["resolveState"];
        assert_eq!(resolve_state["percentage"], 50);
        assert_eq!(resolve_state["speed"], 2048.0);
        assert_eq!(resolve_state["eta"], 10);
    }
}
