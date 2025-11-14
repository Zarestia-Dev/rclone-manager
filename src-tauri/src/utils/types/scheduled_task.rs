use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    pub fn as_str(&self) -> &str {
        match self {
            TaskType::Copy => "copy",
            TaskType::Sync => "sync",
            TaskType::Move => "move",
            TaskType::Bisync => "bisync",
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
    pub human_readable: Option<String>,
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
