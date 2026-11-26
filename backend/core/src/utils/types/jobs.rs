use crate::utils::types::origin::Origin;
use crate::utils::types::starter::Starter;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::sync::Arc;

// Core Manager Types

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum JobType {
    Sync,
    Copy,
    Move,
    Bisync,
    Check,
    Mount,
    List,
    Stat,
    Info,
    About,
    Size,
    Hash,
    CopyUrl,
    Mkdir,
    Cleanup,
    Delete,
    Rename,
    Rmdirs,
    Index,
    Upload,
    /// A file this app copies from a remote onto this device, to keep or to open.
    Download,
    ArchiveCreate,
    ArchiveExtract,
    ArchiveList,
    CryptCheck,
    Unknown(String),
}

impl fmt::Display for JobType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            JobType::Unknown(s) => f.write_str(s),
            _ => f.write_str(
                serde_json::to_value(self)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .as_deref()
                    .unwrap_or_default(),
            ),
        }
    }
}

impl JobType {
    /// Whether a change of this job can alter the tray: the jobs that profiles start.
    #[must_use]
    pub fn is_tray_relevant(&self) -> bool {
        crate::utils::types::remotes::OperationType::ALL
            .iter()
            .any(|op| op.as_job_type().as_ref() == Some(self))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum JobStatus {
    Running,
    Completed,
    Failed,
    Stopped,
}

impl JobStatus {
    #[must_use]
    pub fn is_finished(&self) -> bool {
        matches!(
            self,
            JobStatus::Completed | JobStatus::Failed | JobStatus::Stopped
        )
    }

    #[must_use]
    pub fn is_running(&self) -> bool {
        matches!(self, JobStatus::Running)
    }
}

/// Stable wire values shared with the activity panel.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferStatus {
    Completed,
    Checked,
    Failed,
    Partial,
    MissingDst,
    MissingSrc,
}

/// Rclone may add activities; keep unknown values intact for older clients.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RcloneActivity {
    Transferring,
    Checking,
    Deleting,
    Moving,
    Renaming,
    Hashing,
    Listing,
    Importing,
    Merging,
    #[serde(untagged)]
    Unknown(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveState {
    pub status: JobStatus,
    pub percentage: u8,
    pub is_preparing: bool,
    pub bytes: i64,
    pub size: i64,
    pub speed: f64,
    pub eta: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedTransfer {
    pub name: String,
    pub size: i64,
    pub bytes: i64,
    pub checked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub what: Option<RcloneActivity>,
    pub error: String,
    pub jobid: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src_fs: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dst_fs: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    pub status: TransferStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolve_job_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolve_state: Option<ResolveState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobInfo {
    pub jobid: u64,
    /// Orders telemetry and snapshot updates within this execution.
    #[serde(default)]
    pub stats_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execute_id: Option<String>,
    pub job_type: JobType,
    pub remote_name: String,
    pub source: Vec<String>,
    pub destination: String,
    pub start_time: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_time: Option<DateTime<Utc>>,
    pub status: JobStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub stats: Option<Value>,
    pub group: String,
    /// What started this job; none for ad hoc work.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub starter: Option<Starter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    #[serde(default = "crate::rclone::backend::types::default_backend_name")]
    pub backend_name: String,
    /// Whether this job was started with the `--dry-run` flag (no actual changes).
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_job_id: Option<u64>,
    /// The names of the options a file browser transfer runs with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transfer_options: Option<String>,
    /// The file reports rclone returned for a sync, copy or move, exactly as it returned them.
    /// They can be large, so they never travel with the job; `get_job_report` fetches them.
    #[serde(skip)]
    pub report: Option<Arc<Value>>,
    /// How many files each report in `report` lists, so a view knows what it can ask for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report_counts: Option<BTreeMap<String, usize>>,
    /// What a retry of this job sends to rclone; see `JobRequest`. It never leaves the backend:
    /// the frontend learns only whether there is one, as `retryable`.
    #[serde(
        rename = "retryable",
        skip_deserializing,
        serialize_with = "serialize_present"
    )]
    pub request: Option<Arc<crate::rclone::commands::job::JobRequest>>,
    /// How many files of a finished job failed. Only the job lists carry it, in place of the
    /// rows they leave out (see [`JobInfo::summary`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_files: Option<usize>,
}

/// The stats that hold a job's file rows: the transfer history and a check's report.
const ROW_STATS: [&str; 2] = ["completed", "checkOutput"];

impl JobInfo {
    /// The job as the job lists carry it. A finished job leaves out its file rows, which can be
    /// thousands of a check, and says how many files failed instead; a view of the job fetches
    /// the rows with `get_job_stats`. A running job keeps them: they change with every poll.
    #[must_use]
    pub fn summary(&self) -> Self {
        let finished = self.status.is_finished();
        let stats = self.stats.as_ref().map(|stats| match stats.as_object() {
            Some(fields) if finished => Value::Object(
                fields
                    .iter()
                    .filter(|(key, _)| !ROW_STATS.contains(&key.as_str()))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
            ),
            _ => stats.clone(),
        });
        Self {
            jobid: self.jobid,
            stats_revision: self.stats_revision,
            execute_id: self.execute_id.clone(),
            job_type: self.job_type.clone(),
            remote_name: self.remote_name.clone(),
            source: self.source.clone(),
            destination: self.destination.clone(),
            start_time: self.start_time,
            end_time: self.end_time,
            status: self.status.clone(),
            error: self.error.clone(),
            stats,
            group: self.group.clone(),
            starter: self.starter.clone(),
            origin: self.origin.clone(),
            backend_name: self.backend_name.clone(),
            dry_run: self.dry_run,
            parent_job_id: self.parent_job_id,
            transfer_options: self.transfer_options.clone(),
            report: None,
            report_counts: self.report_counts.clone(),
            request: self.request.clone(),
            failed_files: finished
                .then(|| failed_files(self.stats.as_ref()))
                .filter(|&count| count > 0),
        }
    }
}

/// The files whose last attempt failed. The rows are newest first, and rclone lists a file again
/// when a retry moves it, so a file that failed and then arrived counts as arrived.
fn failed_files(stats: Option<&Value>) -> usize {
    let rows = stats
        .and_then(|stats| stats.get("completed"))
        .and_then(Value::as_array);
    let mut seen = std::collections::HashSet::new();
    rows.into_iter()
        .flatten()
        .filter_map(|row| Some((row.get("name")?.as_str()?, row.get("status")?.as_str()?)))
        .filter(|(name, status)| seen.insert(*name) && *status == "failed")
        .count()
}

fn serialize_present<S: serde::Serializer, T>(
    value: &Option<T>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_bool(value.is_some())
}

// State Management

#[derive(Debug)]
pub struct JobCache {
    pub jobs: tokio::sync::RwLock<HashMap<u64, JobInfo>>,
    /// The jobs this process carries out itself instead of rclone, by id.
    pub(crate) own_jobs: parking_lot::Mutex<HashMap<u64, OwnJobCancellation>>,
    /// Woken whenever a job changes, so that waiting for a job to finish need not poll.
    pub(crate) changed: tokio::sync::Notify,
}

/// What running jobs have transferred, summed over them: the progress the Android notification
/// shows.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct JobProgress {
    pub jobs: usize,
    pub bytes: u64,
    /// Zero while rclone does not know yet how much there is to transfer.
    pub total_bytes: u64,
    /// Bytes per second.
    pub speed: f64,
    /// Files rclone has compared with the destination.
    pub checks: u64,
}

impl JobProgress {
    pub fn add(&mut self, other: Self) {
        self.jobs += other.jobs;
        self.bytes += other.bytes;
        self.total_bytes += other.total_bytes;
        self.speed += other.speed;
        self.checks += other.checks;
    }

    /// How much is done out of 100, when rclone knows how much there is.
    pub fn percent(&self) -> Option<u8> {
        (self.total_bytes > 0)
            .then(|| (self.bytes.min(self.total_bytes) * 100 / self.total_bytes) as u8)
    }

    /// The seconds the rest takes at the current speed, when something is moving.
    pub fn seconds_left(&self) -> Option<u64> {
        (self.total_bytes > self.bytes && self.speed >= 1.0)
            .then(|| ((self.total_bytes - self.bytes) as f64 / self.speed).ceil() as u64)
    }
}

/// How a job this process carries out itself is stopped, and how it confirms it stopped.
#[derive(Debug, Clone)]
pub(crate) struct OwnJobCancellation {
    pub token: tokio_util::sync::CancellationToken,
    pub result: tokio::sync::watch::Receiver<Option<Result<(), String>>>,
}

#[cfg(test)]
impl JobInfo {
    /// A running job for tests: set what a test cares about, take the rest from here
    /// (`JobInfo { jobid: 2, ..JobInfo::for_test() }`), so a new field is added once.
    pub(crate) fn for_test() -> Self {
        Self {
            stats_revision: 0,
            jobid: 1,
            execute_id: None,
            job_type: JobType::Sync,
            remote_name: "drive:".into(),
            source: Vec::new(),
            destination: String::new(),
            start_time: Utc::now(),
            end_time: None,
            status: JobStatus::Running,
            error: None,
            stats: None,
            group: "g".into(),
            starter: None,
            origin: None,
            backend_name: crate::rclone::backend::types::default_backend_name(),
            dry_run: false,
            parent_job_id: None,
            transfer_options: None,
            report: None,
            report_counts: None,
            request: None,
            failed_files: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::JobProgress;
    use super::JobType;

    #[test]
    fn progress_adds_up_and_knows_its_percent_and_time_left_only_with_a_size() {
        let mut progress = JobProgress {
            jobs: 1,
            bytes: 300,
            total_bytes: 1000,
            speed: 100.0,
            checks: 2,
        };
        progress.add(JobProgress {
            jobs: 1,
            bytes: 0,
            total_bytes: 0,
            speed: 0.5,
            checks: 3,
        });
        assert_eq!(progress.jobs, 2);
        assert_eq!(progress.checks, 5);
        assert_eq!(progress.percent(), Some(30));
        // 700 bytes at 100.5 bytes a second.
        assert_eq!(progress.seconds_left(), Some(7));

        let sizing = JobProgress {
            jobs: 1,
            checks: 120,
            ..Default::default()
        };
        assert_eq!(sizing.percent(), None);
        assert_eq!(sizing.seconds_left(), None);
        let stalled = JobProgress {
            speed: 0.0,
            ..progress
        };
        assert_eq!(stalled.seconds_left(), None);
        // rclone can count a little past its total while it retries a file.
        let over = JobProgress {
            bytes: 1200,
            ..progress
        };
        assert_eq!(over.percent(), Some(100));
        assert_eq!(over.seconds_left(), None);
    }

    #[test]
    fn a_finished_job_in_the_list_counts_its_failed_files_instead_of_listing_them() {
        use super::{JobInfo, JobStatus};
        let row = |name: &str, status: &str| serde_json::json!({ "name": name, "status": status });
        let stats = serde_json::json!({
            "bytes": 3,
            // Newest first: `c` failed, then arrived on a retry.
            "completed": [row("c", "completed"), row("b", "failed"), row("c", "failed"), row("a", "completed")],
            "checkOutput": { "differ": ["x"] },
        });
        let running = JobInfo {
            stats: Some(stats.clone()),
            ..JobInfo::for_test()
        };
        assert_eq!(running.summary().stats, running.stats);
        assert_eq!(running.summary().failed_files, None);

        let finished = JobInfo {
            status: JobStatus::Failed,
            ..running
        };
        let summary = finished.summary();
        assert_eq!(summary.stats, Some(serde_json::json!({ "bytes": 3 })));
        assert_eq!(summary.failed_files, Some(1));
        // The job itself keeps them for its own view.
        assert_eq!(finished.stats, Some(stats));
        let clean = JobInfo {
            status: JobStatus::Completed,
            stats: Some(serde_json::json!({ "completed": [row("a", "completed")] })),
            ..JobInfo::for_test()
        };
        assert_eq!(clean.summary().failed_files, None);
    }

    #[test]
    fn only_the_jobs_a_profile_starts_refresh_the_tray() {
        for job in [
            JobType::Sync,
            JobType::Mount,
            JobType::Delete,
            JobType::CryptCheck,
            JobType::CopyUrl,
            JobType::ArchiveCreate,
            JobType::Index,
        ] {
            assert!(job.is_tray_relevant(), "{job:?}");
        }
        for job in [
            JobType::List,
            JobType::Upload,
            JobType::Download,
            JobType::Rename,
            JobType::Rmdirs,
            JobType::ArchiveExtract,
        ] {
            assert!(!job.is_tray_relevant(), "{job:?}");
        }
    }
}
