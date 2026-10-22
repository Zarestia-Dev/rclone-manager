use std::collections::HashMap;

use serde_json::Value;

use crate::utils::json_helpers::build_full_path;
use crate::utils::types::jobs::{JobInfo, JobType, ResolveState};

#[derive(Clone)]
struct CandidateJob {
    jobid: u64,
    started_at: chrono::DateTime<chrono::Utc>,
    progress: ResolveState,
}

fn normalized_path(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_string()
}

fn resolve_progress(job: &JobInfo) -> ResolveState {
    let stats = job.stats.as_ref().unwrap_or(&Value::Null);
    let mut bytes = stats["bytes"].as_i64().unwrap_or(0);
    let mut size = stats["totalBytes"].as_i64().unwrap_or(0);
    let mut speed = stats["speed"].as_f64().unwrap_or(0.0);
    let mut eta = stats["eta"].as_u64().unwrap_or(0);
    // A single active transfer can provide a size before aggregate totals are ready.
    if size <= 0
        && let Some(transfers) = stats["transferring"].as_array()
        && transfers.len() == 1
    {
        let transfer = &transfers[0];
        bytes = transfer["bytes"].as_i64().unwrap_or(0);
        size = transfer["size"].as_i64().unwrap_or(0);
        speed = transfer["speedAvg"]
            .as_f64()
            .or_else(|| transfer["speed"].as_f64())
            .unwrap_or(0.0);
        eta = transfer["eta"].as_u64().unwrap_or(0);
    }
    ResolveState {
        status: job.status.clone(),
        percentage: if size > 0 {
            ((bytes as f64 / size as f64) * 100.0).clamp(0.0, 100.0) as u8
        } else {
            0
        },
        is_preparing: size <= 0,
        bytes,
        size,
        speed,
        eta,
        error: job.error.clone(),
    }
}

/// File repairs and retries carry an explicit parent ID. Match both complete paths;
/// a successful copy is a repair outcome, not a new verification result.
pub fn link_resolving_jobs(jobs: &mut HashMap<u64, JobInfo>, parent_job_id: u64) -> bool {
    let has_rows = jobs
        .get(&parent_job_id)
        .and_then(|parent| parent.stats.as_ref())
        .and_then(|stats| stats.get("completed"))
        .and_then(Value::as_array)
        .is_some_and(|rows| !rows.is_empty());
    if !has_rows {
        return false;
    }
    let mut children: HashMap<(String, String), CandidateJob> = HashMap::new();
    for job in jobs.values().filter(|job| {
        job.parent_job_id == Some(parent_job_id) && job.job_type == JobType::Copy && !job.dry_run
    }) {
        let candidate = CandidateJob {
            jobid: job.jobid,
            started_at: job.start_time,
            progress: resolve_progress(job),
        };
        let destination = normalized_path(&job.destination);
        for source in &job.source {
            children
                .entry((normalized_path(source), destination.clone()))
                .and_modify(|previous| {
                    if (candidate.started_at, candidate.jobid)
                        > (previous.started_at, previous.jobid)
                    {
                        *previous = candidate.clone();
                    }
                })
                .or_insert_with(|| candidate.clone());
        }
    }

    let Some(parent) = jobs.get_mut(&parent_job_id) else {
        return false;
    };
    let Some(completed) = parent
        .stats
        .as_mut()
        .and_then(|stats| stats.get_mut("completed"))
        .and_then(Value::as_array_mut)
    else {
        return false;
    };
    let mut changed = false;
    for item in completed {
        let name = item["name"].as_str().unwrap_or("").replace('\\', "/");
        let source = item["srcFs"].as_str().unwrap_or("");
        let destination = item["dstFs"].as_str().unwrap_or("");
        let reverse = item["status"] == "missing_src";
        let (from, to) = if reverse {
            (destination, source)
        } else {
            (source, destination)
        };
        let parent_path = name.rsplit_once('/').map_or("", |(path, _)| path);
        let full_source = normalized_path(&build_full_path(from, &name));
        let target_directory = normalized_path(&build_full_path(to, parent_path));
        let child = if name.is_empty() || from.is_empty() || to.is_empty() {
            None
        } else {
            children.get(&(full_source, target_directory))
        };
        if let Some(item) = item.as_object_mut() {
            if let Some(child) = child {
                let id = serde_json::json!(child.jobid);
                let state = serde_json::to_value(&child.progress).unwrap_or(Value::Null);
                if item.get("resolveJobId") != Some(&id) {
                    item.insert("resolveJobId".into(), id);
                    changed = true;
                }
                if item.get("resolveState") != Some(&state) {
                    item.insert("resolveState".into(), state);
                    changed = true;
                }
            } else {
                let removed_id = item.remove("resolveJobId").is_some();
                let removed_state = item.remove("resolveState").is_some();
                changed |= removed_id || removed_state;
            }
        }
    }
    if changed {
        parent.stats_revision += 1;
    }
    changed
}

/// Cleans up transient transferring metrics when a job finishes or is stopped.
pub fn sanitize_finished_stats(stats: &mut Value) {
    if let Some(obj) = stats.as_object_mut() {
        obj.insert("transferring".to_string(), serde_json::json!([]));
        obj.insert("checking".to_string(), serde_json::json!([]));
        obj.insert("speed".to_string(), serde_json::json!(0.0));
        obj.insert("eta".to_string(), Value::Null);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rclone::backend::types::default_backend_name;
    use crate::utils::types::jobs::JobStatus;

    fn mock_job(jobid: u64, remote: &str, job_type: JobType) -> JobInfo {
        JobInfo {
            stats_revision: 0,
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
            "checking": ["b.txt"],
            "bytes": 500
        });
        sanitize_finished_stats(&mut stats);
        assert_eq!(stats["speed"], 0.0);
        assert!(stats["eta"].is_null());
        assert_eq!(stats["transferring"].as_array().unwrap().len(), 0);
        assert_eq!(stats["checking"].as_array().unwrap().len(), 0);
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
        child.destination = "local:folder".to_string();
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

    #[test]
    fn repairs_require_both_paths_and_keep_the_original_comparison() {
        let mut parent = mock_job(1, "drive:", JobType::Check);
        parent.stats = Some(serde_json::json!({"completed": [
            {"name": "doc.pdf", "srcFs": "drive:one", "dstFs": "backup:one", "status": "partial"},
            {"name": "doc.pdf", "srcFs": "drive:two", "dstFs": "backup:two", "status": "missing_dst"},
            {"name": "doc.pdf", "srcFs": "drive:reverse", "dstFs": "backup:reverse", "status": "missing_src"}
        ]}));
        let mut repaired = mock_job(2, "drive:", JobType::Copy);
        repaired.parent_job_id = Some(1);
        repaired.source = vec!["drive:one/doc.pdf".into()];
        repaired.destination = "backup:one".into();
        repaired.status = JobStatus::Completed;
        let mut wrong_destination = repaired.clone();
        wrong_destination.jobid = 3;
        wrong_destination.source = vec!["drive:two/doc.pdf".into()];
        let mut reverse = repaired.clone();
        reverse.jobid = 4;
        reverse.source = vec!["backup:reverse/doc.pdf".into()];
        reverse.destination = "drive:reverse".into();
        let mut dry_run = repaired.clone();
        dry_run.jobid = 5;
        dry_run.dry_run = true;
        let mut jobs = HashMap::from([
            (1, parent),
            (2, repaired),
            (3, wrong_destination),
            (4, reverse),
            (5, dry_run),
        ]);
        link_resolving_jobs(&mut jobs, 1);
        let rows = &jobs[&1].stats.as_ref().unwrap()["completed"];
        assert_eq!(rows[0]["resolveJobId"], 2);
        assert_eq!(rows[0]["status"], "partial");
        assert_eq!(rows[0]["resolveState"]["status"], "Completed");
        assert!(rows[1]["resolveJobId"].is_null());
        assert_eq!(rows[2]["resolveJobId"], 4);
    }
}
