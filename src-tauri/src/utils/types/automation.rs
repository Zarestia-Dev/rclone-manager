use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::utils::types::jobs::JobType;
use crate::utils::types::remotes::ProfileParams;

/// Type of automation
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AutomationType {
    Copy,
    Sync,
    Move,
    Bisync,
}

impl std::fmt::Display for AutomationType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AutomationType::Copy => write!(f, "Copy"),
            AutomationType::Sync => write!(f, "Sync"),
            AutomationType::Move => write!(f, "Move"),
            AutomationType::Bisync => write!(f, "Bisync"),
        }
    }
}

impl AutomationType {
    #[must_use]
    pub fn as_job_type(&self) -> JobType {
        match self {
            AutomationType::Copy => JobType::Copy,
            AutomationType::Sync => JobType::Sync,
            AutomationType::Move => JobType::Move,
            AutomationType::Bisync => JobType::Bisync,
        }
    }
}

/// Status of an automation
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AutomationStatus {
    Enabled,
    Disabled,
    Running,
    Failed,
    Stopping,
}

/// Arguments for an automation
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationArgs {
    /// Core parameters for the profile operation
    #[serde(flatten)]
    pub params: ProfileParams,

    /// All source paths from the profile (can be 1 or many)
    pub src_paths: Vec<String>,

    /// All destination paths from the profile (can be 1 or many)
    pub dst_paths: Vec<String>,
}

impl AutomationArgs {
    /// Returns a display string for the source paths (comma-joined).
    #[must_use]
    pub fn src_display(&self) -> String {
        self.src_paths.join(", ")
    }
    /// Returns a display string for the dest paths (comma-joined).
    #[must_use]
    pub fn dst_display(&self) -> String {
        self.dst_paths.join(", ")
    }
}

fn default_watch_delay() -> u64 {
    5
}

/// Represents an automation with cron configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    /// Unique identifier for the automation
    pub id: String,

    /// Type of rclone operation
    pub automation_type: AutomationType,

    /// Remote name this automation is associated with
    pub remote_name: String,

    /// Profile name within the remote
    pub profile_name: String,

    /// Cron expression (e.g., "0 0 * * *" for daily at midnight)
    pub cron_expression: Option<String>,

    /// Current status
    pub status: AutomationStatus,

    /// Automation arguments (source, destination, options, etc.)
    pub args: AutomationArgs,

    /// Backend this automation belongs to (e.g., "Local", "NAS")
    /// Automations only execute when their assigned backend is active
    #[serde(default = "crate::rclone::backend::types::default_backend_name")]
    pub backend_name: String,

    /// When the automation was created
    pub created_at: DateTime<Utc>,

    /// Last time the automation ran
    pub last_run: Option<DateTime<Utc>>,

    /// Next scheduled run time
    pub next_run: Option<DateTime<Utc>>,

    /// Last error message if automation failed
    pub last_error: Option<String>,

    /// Current rclone job ID or batch ID if automation is running
    pub current_job_id: Option<String>,

    /// Scheduler job UUID (used to unschedule the automation)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduler_job_id: Option<String>,

    /// Total number of times this automation has run
    pub run_count: u64,

    /// Number of successful runs
    pub success_count: u64,

    /// Number of failed runs
    pub failure_count: u64,

    /// Number of stopped runs
    #[serde(default)]
    pub stopped_count: u64,

    /// Enable real-time filesystem monitoring
    #[serde(default)]
    pub watch_enabled: bool,

    /// Delay in seconds to debounce file changes before running the sync
    #[serde(default = "default_watch_delay")]
    pub watch_delay: u64,
}

impl Automation {
    #[must_use]
    pub fn display_name(&self) -> String {
        format!("{} ({})", self.profile_name, self.backend_name)
    }

    #[must_use]
    pub fn log_name(&self) -> String {
        format!(
            "{}: {}-{}.{}",
            self.backend_name, self.remote_name, self.profile_name, self.id
        )
    }

    /// Update the automation after a successful run
    pub fn mark_success(&mut self) {
        self.last_run = Some(Utc::now());
        self.last_error = None;
        self.current_job_id = None;
        self.success_count += 1;
        self.status = if self.status == AutomationStatus::Stopping {
            AutomationStatus::Disabled
        } else {
            AutomationStatus::Enabled
        };
    }

    /// Update the automation after a failed run
    pub fn mark_failure(&mut self, error: String) {
        self.last_run = Some(Utc::now());
        self.last_error = Some(error);
        self.current_job_id = None;
        self.failure_count += 1;
        self.status = if self.status == AutomationStatus::Stopping {
            AutomationStatus::Disabled
        } else {
            AutomationStatus::Failed
        };
    }

    /// Mark automation as starting execution
    pub fn mark_starting(&mut self) -> Result<(), String> {
        if !self.can_run() {
            return Err(format!(
                "Automation cannot start from status {:?}",
                self.status
            ));
        }

        self.status = AutomationStatus::Running;
        self.current_job_id = None;
        self.last_run = Some(Utc::now());
        self.run_count += 1;
        Ok(())
    }

    /// Mark automation as running with job ID or batch ID (after operation starts)
    pub fn mark_running(&mut self, job_id: String) {
        debug_assert_eq!(
            self.status,
            AutomationStatus::Running,
            "mark_running called from unexpected state {:?}",
            self.status
        );
        self.current_job_id = Some(job_id);
    }

    pub fn mark_stopped(&mut self) {
        self.last_run = Some(Utc::now());
        self.current_job_id = None;
        self.stopped_count += 1;
        self.status = if self.status == AutomationStatus::Stopping {
            AutomationStatus::Disabled
        } else {
            AutomationStatus::Enabled
        };
    }

    /// Check if automation can transition to running
    #[must_use]
    pub fn can_run(&self) -> bool {
        (self.status == AutomationStatus::Enabled || self.status == AutomationStatus::Failed)
            && self.current_job_id.is_none()
    }
}

/// Response for cron validation
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronValidationResponse {
    pub is_valid: bool,
    pub error_message: Option<String>,
    pub next_run: Option<DateTime<Utc>>,
}

/// Statistics for automations
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationStats {
    pub total_automations: usize,
    pub enabled_automations: usize,
    pub running_automations: usize,
    pub failed_automations: usize,
    pub total_runs: u64,
    pub successful_runs: u64,
    pub failed_runs: u64,
    pub stopped_runs: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::types::jobs::JobType;

    fn create_test_automation() -> Automation {
        Automation {
            id: "test-id".to_string(),
            automation_type: AutomationType::Sync,
            remote_name: "remote".to_string(),
            profile_name: "profile".to_string(),
            cron_expression: Some("0 0 * * *".to_string()),
            status: AutomationStatus::Enabled,
            args: AutomationArgs {
                params: ProfileParams {
                    remote_name: "remote".to_string(),
                    profile_name: "profile".to_string(),
                    source: None,
                    no_cache: None,
                },
                src_paths: vec![],
                dst_paths: vec![],
            },
            backend_name: "Local".to_string(),
            created_at: Utc::now(),
            last_run: None,
            next_run: None,
            last_error: None,
            current_job_id: None,
            scheduler_job_id: None,
            run_count: 0,
            success_count: 0,
            failure_count: 0,
            stopped_count: 0,
            watch_enabled: false,
            watch_delay: 5,
        }
    }

    #[test]
    fn test_automation_type_conversion() {
        assert_eq!(AutomationType::Sync.as_job_type(), JobType::Sync);
        assert_eq!(AutomationType::Copy.as_job_type(), JobType::Copy);
        assert_eq!(AutomationType::Move.as_job_type(), JobType::Move);
        assert_eq!(AutomationType::Bisync.as_job_type(), JobType::Bisync);
    }

    #[test]
    fn test_mark_starting_and_running() {
        let mut automation = create_test_automation();

        assert!(automation.can_run());
        assert!(automation.mark_starting().is_ok());
        assert_eq!(automation.status, AutomationStatus::Running);
        assert_eq!(automation.run_count, 1);
        assert!(automation.last_run.is_some());

        automation.mark_running("12345".to_string());
        assert_eq!(automation.current_job_id, Some("12345".to_string()));
        assert!(!automation.can_run());
    }

    #[test]
    fn test_mark_success_failure() {
        let mut automation = create_test_automation();

        // Success path
        automation.status = AutomationStatus::Running;
        automation.mark_success();
        assert_eq!(automation.status, AutomationStatus::Enabled);
        assert_eq!(automation.success_count, 1);
        assert!(automation.last_run.is_some());

        // Failure path — task must land on Failed, not Enabled
        automation.status = AutomationStatus::Running;
        automation.mark_failure("error".to_string());
        assert_eq!(automation.status, AutomationStatus::Failed);
        assert_eq!(automation.failure_count, 1);
        assert_eq!(automation.last_error, Some("error".to_string()));

        automation.status = AutomationStatus::Enabled;
    }

    #[test]
    fn test_mark_stopped() {
        let mut automation = create_test_automation();

        automation.status = AutomationStatus::Running;
        automation.current_job_id = Some("123".to_string());
        automation.mark_stopped();

        assert_eq!(automation.status, AutomationStatus::Enabled);
        assert_eq!(automation.current_job_id, None);
        assert_eq!(automation.stopped_count, 1);

        // Test Stopping -> Disabled
        automation.status = AutomationStatus::Stopping;
        automation.mark_stopped();
        assert_eq!(automation.status, AutomationStatus::Disabled);
        assert_eq!(automation.stopped_count, 2);
    }

    #[test]
    fn test_log_name() {
        let automation = create_test_automation();
        assert_eq!(automation.log_name(), "Local: remote-profile.test-id");
    }
}
