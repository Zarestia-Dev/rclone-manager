use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::utils::types::jobs::JobType;

/// Type of scheduled task
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskType {
    Copy,
    Sync,
    Move,
    Bisync,
}

impl TaskType {
    pub fn as_job_type(&self) -> JobType {
        match self {
            TaskType::Copy => JobType::Copy,
            TaskType::Sync => JobType::Sync,
            TaskType::Move => JobType::Move,
            TaskType::Bisync => JobType::Bisync,
        }
    }
}

/// Status of a scheduled task
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Enabled,
    Disabled,
    Running,
    Failed,
    Stopping,
}

/// Represents a scheduled task with cron configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    /// Unique identifier for the task
    pub id: String,

    /// Human-readable name for the task
    pub name: String,

    /// Type of rclone operation
    pub task_type: TaskType,

    /// Cron expression (e.g., "0 0 * * *" for daily at midnight)
    pub cron_expression: String,

    /// Current status
    pub status: TaskStatus,

    /// Task arguments (source, destination, options, etc.)
    pub args: Value,

    /// Backend this task belongs to (e.g., "Local", "NAS")
    /// Tasks only execute when their assigned backend is active
    #[serde(default = "default_backend_name")]
    pub backend_name: String,

    /// When the task was created
    pub created_at: DateTime<Utc>,

    /// Last time the task ran
    pub last_run: Option<DateTime<Utc>>,

    /// Next scheduled run time
    pub next_run: Option<DateTime<Utc>>,

    /// Last error message if task failed
    pub last_error: Option<String>,

    /// Current rclone job ID if task is running
    pub current_job_id: Option<u64>,

    /// Scheduler job UUID (used to unschedule the task)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduler_job_id: Option<String>,

    /// Total number of times this task has run
    pub run_count: u64,

    /// Number of successful runs
    pub success_count: u64,

    /// Number of failed runs
    pub failure_count: u64,
}

// In scheduled_task.rs
impl ScheduledTask {
    /// Validate and transition task state
    pub fn transition_to(&mut self, new_status: TaskStatus) -> Result<(), String> {
        let valid_transition = match (&self.status, &new_status) {
            // From Enabled
            (TaskStatus::Enabled, TaskStatus::Disabled) => true,
            (TaskStatus::Enabled, TaskStatus::Running) => true,

            // From Disabled
            (TaskStatus::Disabled, TaskStatus::Enabled) => true,

            // From Running
            (TaskStatus::Running, TaskStatus::Enabled) => true, // Success
            (TaskStatus::Running, TaskStatus::Failed) => true,
            (TaskStatus::Running, TaskStatus::Stopping) => true,

            // From Stopping
            (TaskStatus::Stopping, TaskStatus::Disabled) => true,
            (TaskStatus::Stopping, TaskStatus::Enabled) => true,

            // From Failed
            (TaskStatus::Failed, TaskStatus::Enabled) => true,
            (TaskStatus::Failed, TaskStatus::Disabled) => true,

            _ => false,
        };

        if !valid_transition {
            return Err(format!(
                "Invalid state transition from {:?} to {:?}",
                self.status, new_status
            ));
        }

        self.status = new_status;
        Ok(())
    }

    /// Update the task after a successful run
    pub fn mark_success(&mut self) {
        self.last_run = Some(Utc::now());
        self.last_error = None;
        self.current_job_id = None;
        self.success_count += 1;

        // Clear transition: Running -> Enabled or Stopping -> Disabled
        self.status = if self.status == TaskStatus::Stopping {
            TaskStatus::Disabled
        } else {
            TaskStatus::Enabled
        };
    }

    /// Update the task after a failed run
    pub fn mark_failure(&mut self, error: String) {
        self.last_run = Some(Utc::now());
        self.last_error = Some(error);
        self.current_job_id = None;
        self.failure_count += 1;

        self.status = if self.status == TaskStatus::Stopping {
            TaskStatus::Disabled
        } else {
            TaskStatus::Enabled
        };
    }

    /// Mark task as starting execution
    pub fn mark_starting(&mut self) -> Result<(), String> {
        if !self.can_run() {
            return Err(format!("Task cannot start from status {:?}", self.status));
        }

        self.transition_to(TaskStatus::Running)?;
        self.last_run = Some(Utc::now());
        self.current_job_id = None;
        self.run_count += 1;
        Ok(())
    }

    /// Mark task as running with job ID (after operation starts)
    pub fn mark_running(&mut self, job_id: u64) {
        self.current_job_id = Some(job_id);
        self.status = TaskStatus::Running;
    }

    /// Mark task as stopped/cancelled (job was manually stopped)
    pub fn mark_stopped(&mut self) {
        self.last_run = Some(Utc::now());
        self.current_job_id = None;
        self.status = if self.status == TaskStatus::Stopping {
            TaskStatus::Disabled
        } else {
            TaskStatus::Enabled
        };
    }

    /// Check if task can transition to running
    pub fn can_run(&self) -> bool {
        self.status == TaskStatus::Enabled && self.current_job_id.is_none()
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

/// Statistics for scheduled tasks
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskStats {
    pub total_tasks: usize,
    pub enabled_tasks: usize,
    pub running_tasks: usize,
    pub failed_tasks: usize,
    pub total_runs: u64,
    pub successful_runs: u64,
    pub failed_runs: u64,
}

/// Default backend name for deserialization (backward compatibility)
fn default_backend_name() -> String {
    "Local".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn create_test_task() -> ScheduledTask {
        ScheduledTask {
            id: "test-id".to_string(),
            name: "Test Task".to_string(),
            task_type: TaskType::Sync,
            cron_expression: "0 0 * * *".to_string(),
            status: TaskStatus::Enabled,
            args: json!({}),
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
        }
    }

    #[test]
    fn test_task_type_conversion() {
        assert_eq!(TaskType::Sync.as_job_type(), JobType::Sync);
        assert_eq!(TaskType::Copy.as_job_type(), JobType::Copy);
        assert_eq!(TaskType::Move.as_job_type(), JobType::Move);
        assert_eq!(TaskType::Bisync.as_job_type(), JobType::Bisync);
    }

    #[test]
    fn test_state_transitions() {
        let mut task = create_test_task();

        // Enabled -> Running
        assert!(task.transition_to(TaskStatus::Running).is_ok());
        assert_eq!(task.status, TaskStatus::Running);

        // Running -> Enabled (Success)
        assert!(task.transition_to(TaskStatus::Enabled).is_ok());
        assert_eq!(task.status, TaskStatus::Enabled);

        // Enabled -> Disabled
        assert!(task.transition_to(TaskStatus::Disabled).is_ok());
        assert_eq!(task.status, TaskStatus::Disabled);

        // Disabled -> Enabled
        assert!(task.transition_to(TaskStatus::Enabled).is_ok());
        assert_eq!(task.status, TaskStatus::Enabled);

        // Running -> Failed
        task.status = TaskStatus::Running;
        assert!(task.transition_to(TaskStatus::Failed).is_ok());
        assert_eq!(task.status, TaskStatus::Failed);

        // Failed -> Enabled
        assert!(task.transition_to(TaskStatus::Enabled).is_ok());
        assert_eq!(task.status, TaskStatus::Enabled);
    }

    #[test]
    fn test_invalid_transitions() {
        let mut task = create_test_task();
        task.status = TaskStatus::Disabled;

        // Disabled -> Running (Invalid)
        assert!(task.transition_to(TaskStatus::Running).is_err());
    }

    #[test]
    fn test_mark_starting_and_running() {
        let mut task = create_test_task();

        assert!(task.can_run());
        assert!(task.mark_starting().is_ok());
        assert_eq!(task.status, TaskStatus::Running);
        assert_eq!(task.run_count, 1);
        assert!(task.last_run.is_some());

        task.mark_running(12345);
        assert_eq!(task.current_job_id, Some(12345));
        assert!(!task.can_run());
    }

    #[test]
    fn test_mark_success_failure() {
        let mut task = create_test_task();

        // Success path
        task.status = TaskStatus::Running;
        task.mark_success();
        assert_eq!(task.status, TaskStatus::Enabled);
        assert_eq!(task.success_count, 1);
        assert!(task.last_run.is_some());

        // Failure path
        task.status = TaskStatus::Running;
        task.mark_failure("error".to_string());
        assert_eq!(task.status, TaskStatus::Enabled);
        assert_eq!(task.failure_count, 1);
        assert_eq!(task.last_error, Some("error".to_string()));
    }

    #[test]
    fn test_mark_stopped() {
        let mut task = create_test_task();

        task.status = TaskStatus::Running;
        task.current_job_id = Some(123);
        task.mark_stopped();

        assert_eq!(task.status, TaskStatus::Enabled);
        assert_eq!(task.current_job_id, None);

        // Test Stopping -> Disabled
        task.status = TaskStatus::Stopping;
        task.mark_stopped();
        assert_eq!(task.status, TaskStatus::Disabled);
    }
}
