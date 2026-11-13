//! Turns the stats rclone reports for a job into the list of completed transfers.

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::utils::types::jobs::{
    CompletedTransfer, JobInfo, JobType, RcloneActivity, TransferStatus,
};

/// Recomputes the `completed` transfers of a job's stats.
pub fn normalize_job_stats(job: &mut JobInfo) {
    let completed = compute_completed_transfers(
        job.jobid,
        &job.job_type,
        &job.group,
        &job.source,
        &job.destination,
        job.end_time,
        &job.stats,
    );
    if let (Some(val), Some(obj)) = (
        completed.and_then(|c| serde_json::to_value(c).ok()),
        job.stats.as_mut().and_then(|s| s.as_object_mut()),
    ) {
        obj.insert("completed".to_string(), val);
    }
}

/// The check results a Check or CryptCheck job kept: one per source root of a batch
/// (`{ "results": [..] }`), or the single result of one `operations/check` call. Each result
/// lists `differ`, `missingOnDst`, `missingOnSrc`, `match` and `error` as rclone returned them.
pub(crate) fn check_reports(stats: &Value) -> Vec<&Value> {
    let Some(output) = stats
        .get("checkOutput")
        .filter(|output| output.is_object() || output.is_array())
    else {
        return Vec::new();
    };
    let results = output.get("results").unwrap_or(output);
    results
        .as_array()
        .map_or_else(|| vec![results], |reports| reports.iter().collect())
}

pub fn compute_completed_transfers(
    jobid: u64,
    job_type: &JobType,
    group: &str,
    source: &[String],
    destination: &str,
    end_time: Option<DateTime<Utc>>,
    stats: &Option<Value>,
) -> Option<Vec<CompletedTransfer>> {
    let stats = stats.as_ref()?;

    let reports = check_reports(stats);
    if matches!(job_type, JobType::Check | JobType::CryptCheck) && !reports.is_empty() {
        const REPORT_STATUSES: &[(&str, TransferStatus)] = &[
            ("missingOnDst", TransferStatus::MissingDst),
            ("missingOnSrc", TransferStatus::MissingSrc),
            ("differ", TransferStatus::Partial),
            ("error", TransferStatus::Failed),
            ("match", TransferStatus::Checked),
        ];
        let mut items = Vec::new();
        for (report_index, report) in reports.iter().enumerate() {
            // Batch reports follow source order. Never assign every result to the first root.
            let source_root = source.get(report_index).filter(|root| !root.is_empty());
            for &(key, status) in REPORT_STATUSES {
                let Some(names) = report.get(key).and_then(Value::as_array) else {
                    continue;
                };
                for name in names
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|name| !name.is_empty())
                {
                    // Cryptcheck error entries may contain a diagnostic, rather than a file path.
                    let actionable = status != TransferStatus::Failed;
                    items.push(CompletedTransfer {
                        name: name.to_string(),
                        size: -1,
                        bytes: 0,
                        checked: status == TransferStatus::Checked,
                        what: Some(RcloneActivity::Checking),
                        error: if status == TransferStatus::Failed {
                            name.to_string()
                        } else {
                            String::new()
                        },
                        jobid,
                        started_at: None,
                        completed_at: end_time,
                        src_fs: source_root.filter(|_| actionable).cloned(),
                        // A single destination string cannot describe several distinct batch roots.
                        dst_fs: (actionable && source.len() == 1 && !destination.is_empty())
                            .then(|| destination.to_string()),
                        group: Some(group.to_string()),
                        status,
                        resolve_job_id: None,
                        resolve_state: None,
                    });
                }
            }
        }
        Some(items)
    } else {
        let completed_array = stats.get("completed")?.as_array()?;
        let mut items = Vec::new();
        for val in completed_array {
            let name = val
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let size = val.get("size").and_then(|v| v.as_i64()).unwrap_or(-1);
            let bytes = val.get("bytes").and_then(|v| v.as_i64()).unwrap_or(0);
            let checked = val
                .get("checked")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let what = val
                .get("what")
                .and_then(|value| serde_json::from_value::<RcloneActivity>(value.clone()).ok());
            let error = val
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let started_at = val
                .get("started_at")
                .or_else(|| val.get("startedAt"))
                .and_then(|v| serde_json::from_value::<DateTime<Utc>>(v.clone()).ok());

            let completed_at = val
                .get("completed_at")
                .or_else(|| val.get("completedAt"))
                .and_then(|v| serde_json::from_value::<DateTime<Utc>>(v.clone()).ok());

            let src_fs = val
                .get("srcFs")
                .or_else(|| val.get("src_fs"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let dst_fs = val
                .get("dstFs")
                .or_else(|| val.get("dst_fs"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let group_val = val
                .get("group")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let mut status = TransferStatus::Completed;
            if !error.is_empty() {
                status = TransferStatus::Failed;
            } else if checked
                && what
                    .as_ref()
                    .is_none_or(|what| *what == RcloneActivity::Checking)
                && !matches!(
                    job_type,
                    JobType::Delete | JobType::Cleanup | JobType::Rmdirs
                )
            {
                status = TransferStatus::Checked;
            } else if bytes > 0
                && bytes < size
                && what
                    .as_ref()
                    .is_none_or(|what| *what == RcloneActivity::Transferring)
            {
                status = TransferStatus::Partial;
            }

            items.push(CompletedTransfer {
                name,
                size,
                bytes,
                checked,
                what,
                error,
                jobid,
                started_at,
                completed_at,
                src_fs,
                dst_fs,
                group: group_val,
                status,
                resolve_job_id: val.get("resolveJobId").and_then(Value::as_u64),
                resolve_state: val
                    .get("resolveState")
                    .and_then(|state| serde_json::from_value(state.clone()).ok()),
            });
        }

        items.sort_by_key(|item| std::cmp::Reverse(item.completed_at));

        Some(items)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::types::jobs::JobStatus;
    use serde_json::json;

    fn history(job_type: JobType, rows: Value) -> Vec<CompletedTransfer> {
        compute_completed_transfers(
            7,
            &job_type,
            "sync/7",
            &[],
            "",
            None,
            &Some(json!({"completed": rows})),
        )
        .unwrap()
    }

    #[test]
    fn preserves_activity_and_distinguishes_checks_from_other_work() {
        let items = history(
            JobType::Sync,
            json!([
                {"name": "deleted: ü.txt", "checked": true, "what": "deleting", "size": 100},
                {"name": "same.txt", "checked": true, "what": "checking"},
                {"name": "moved.txt", "checked": true, "what": "moving"},
                {"name": "hashed.txt", "checked": true, "what": "hashing"},
                {"name": "failed.txt", "checked": true, "what": "deleting", "error": "denied"},
                {"name": "partial.txt", "bytes": 5, "size": 10, "what": "transferring"}
            ]),
        );
        let statuses: Vec<TransferStatus> = items.iter().map(|item| item.status).collect();
        assert_eq!(
            statuses,
            [
                TransferStatus::Completed,
                TransferStatus::Checked,
                TransferStatus::Completed,
                TransferStatus::Completed,
                TransferStatus::Failed,
                TransferStatus::Partial
            ]
        );
        assert_eq!(items[0].what, Some(RcloneActivity::Deleting));
        assert_eq!(items[0].name, "deleted: ü.txt");
        assert_eq!(items[4].error, "denied");
    }

    #[test]
    fn supports_legacy_snapshots_and_repeated_normalization() {
        assert_eq!(
            history(JobType::Sync, json!([{"checked": true}]))[0].status,
            TransferStatus::Checked
        );
        assert_eq!(
            history(JobType::Delete, json!([{"checked": true}]))[0].status,
            TransferStatus::Completed
        );
        let first = history(
            JobType::Sync,
            json!([{"name": "gone.txt", "checked": true, "what": "deleting"}]),
        );
        let second = history(JobType::Sync, serde_json::to_value(&first).unwrap());
        assert_eq!(second[0].what, first[0].what);
        assert_eq!(second[0].status, TransferStatus::Completed);
        assert!(history(JobType::Sync, json!([])).is_empty());
        assert!(compute_completed_transfers(7, &JobType::Sync, "", &[], "", None, &None).is_none());
    }
    #[test]
    fn live_check_history_is_normalized_before_a_final_report_exists() {
        for operation in [JobType::Check, JobType::CryptCheck] {
            let items = history(
                operation,
                json!([{
                    "name": "a.txt", "checked": true, "what": "checking",
                    "completed_at": "2026-10-22T10:00:00Z"
                }]),
            );
            assert_eq!(items[0].jobid, 7);
            assert_eq!(items[0].status, TransferStatus::Checked);
            assert!(items[0].completed_at.is_some());
        }
    }

    #[test]
    fn repeated_normalization_preserves_retry_state_and_unknown_sizes() {
        let first = history(
            JobType::Copy,
            json!([{
                "name": "a.txt", "error": "denied", "what": "transferring",
                "resolveJobId": 8,
                "resolveState": {
                    "status": "Running", "percentage": 25, "isPreparing": false,
                    "bytes": 25, "size": 100, "speed": 10.0, "eta": 7
                }
            }]),
        );
        let second = history(JobType::Copy, serde_json::to_value(&first).unwrap());
        assert_eq!(second[0].size, -1);
        assert_eq!(second[0].status, TransferStatus::Failed);
        assert_eq!(second[0].error, "denied");
        assert_eq!(second[0].resolve_job_id, Some(8));
        let progress = second[0].resolve_state.as_ref().unwrap();
        assert_eq!(progress.status, JobStatus::Running);
        assert_eq!(progress.percentage, 25);
    }

    #[test]
    fn history_order_preserves_timestamp_precision() {
        let items = history(
            JobType::Copy,
            json!([
                {"name": "older", "completed_at": "2026-10-22T10:00:00.000001Z"},
                {"name": "newer", "completed_at": "2026-10-22T10:00:00.000002Z"}
            ]),
        );
        assert_eq!(items[0].name, "newer");
        assert_eq!(items[1].name, "older");
    }

    #[test]
    fn check_reports_keep_errors_matches_and_source_order() {
        let output = Some(json!({"checkOutput": {"results": [
            {"missingOnDst": ["same.txt"], "error": ["unreadable.txt"], "match": ["good.txt"]},
            {"differ": ["same.txt", "", null]}
        ]}}));
        let items = compute_completed_transfers(
            7,
            &JobType::Check,
            "check/7",
            &["first:root".into(), "second:root".into()],
            "backup:root",
            None,
            &output,
        )
        .unwrap();
        assert_eq!(items.len(), 4);
        assert_eq!(items[0].src_fs.as_deref(), Some("first:root"));
        assert_eq!(items[1].status, TransferStatus::Failed);
        assert_eq!(items[1].error, "unreadable.txt");
        assert!(items[1].src_fs.is_none());
        assert!(items[1].dst_fs.is_none());
        assert_eq!(items[2].status, TransferStatus::Checked);
        assert_eq!(items[3].src_fs.as_deref(), Some("second:root"));
        assert!(
            items
                .iter()
                .all(|item| item.completed_at.is_none() && item.dst_fs.is_none())
        );
        assert_eq!(items[0].size, -1);
    }

    #[test]
    fn future_activity_values_round_trip_without_breaking_history() {
        let activity: RcloneActivity = serde_json::from_value(json!("future activity")).unwrap();
        assert_eq!(activity, RcloneActivity::Unknown("future activity".into()));
        assert_eq!(
            serde_json::to_value(activity).unwrap(),
            json!("future activity")
        );
        let items = history(
            JobType::Sync,
            json!([{"name": "a", "what": "future activity", "checked": true}]),
        );
        assert_eq!(items[0].status, TransferStatus::Completed);
    }
}
