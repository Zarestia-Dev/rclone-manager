//! Core types for the Alert & Action system.
//!
//! This module is completely independent from the OS notification system
//! (`utils::app::notification`). It defines the data model for alert rules,
//! actions, and history records.

use chrono::{DateTime, Utc};
use rcman::DeriveSettingsSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::utils::types::origin::Origin;

// =============================================================================
// SEVERITY
// =============================================================================

/// Alert severity levels, ordered from lowest to highest.
/// Used to filter which events trigger a rule.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
#[serde(rename_all = "lowercase")]
pub enum AlertSeverity {
    #[default]
    Info = 1,
    Warning = 2,
    Average = 3,
    High = 4,
    Critical = 5,
}

impl std::fmt::Display for AlertSeverity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl AlertSeverity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warning => "warning",
            Self::Average => "average",
            Self::High => "high",
            Self::Critical => "critical",
        }
    }

    pub fn as_code(&self) -> u8 {
        match self {
            Self::Info => 1,
            Self::Warning => 2,
            Self::Average => 3,
            Self::High => 4,
            Self::Critical => 5,
        }
    }
}

// =============================================================================
// EVENT KIND
// =============================================================================

/// The class of event that triggered an alert.
/// Derived from `NotificationEvent` variants in the alert engine.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "snake_case")]
pub enum AlertEventKind {
    /// Matches any event (wildcard).
    #[default]
    Any,
    // Job lifecycle
    JobCompleted,
    JobStarted,
    JobFailed,
    JobStopped,
    // Serve lifecycle
    ServeStarted,
    ServeFailed,
    ServeStopped,
    AllServesStopped,
    // Mount lifecycle
    MountSucceeded,
    MountFailed,
    UnmountSucceeded,
    AllUnmounted,
    // Engine
    EnginePasswordRequired,
    EngineBinaryNotFound,
    EngineConnectionFailed,
    EngineRestarted,
    EngineRestartFailed,
    // Updates
    AppUpdateAvailable,
    AppUpdateStarted,
    AppUpdateComplete,
    AppUpdateFailed,
    AppUpdateInstalled,
    RcloneUpdateAvailable,
    RcloneUpdateStarted,
    RcloneUpdateComplete,
    RcloneUpdateFailed,
    RcloneUpdateInstalled,
    // Scheduled tasks
    ScheduledTaskStarted,
    ScheduledTaskCompleted,
    ScheduledTaskFailed,
    // Misc
    AlreadyRunning,
    AllJobsStopped,
}

impl std::fmt::Display for AlertEventKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl AlertEventKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Any => "any",
            Self::JobCompleted => "job_completed",
            Self::JobStarted => "job_started",
            Self::JobFailed => "job_failed",
            Self::JobStopped => "job_stopped",
            Self::ServeStarted => "serve_started",
            Self::ServeFailed => "serve_failed",
            Self::ServeStopped => "serve_stopped",
            Self::AllServesStopped => "all_serves_stopped",
            Self::MountSucceeded => "mount_succeeded",
            Self::MountFailed => "mount_failed",
            Self::UnmountSucceeded => "unmount_succeeded",
            Self::AllUnmounted => "all_unmounted",
            Self::EnginePasswordRequired => "engine_password_required",
            Self::EngineBinaryNotFound => "engine_binary_not_found",
            Self::EngineConnectionFailed => "engine_connection_failed",
            Self::EngineRestarted => "engine_restarted",
            Self::EngineRestartFailed => "engine_restart_failed",
            Self::AppUpdateAvailable => "app_update_available",
            Self::AppUpdateStarted => "app_update_started",
            Self::AppUpdateComplete => "app_update_complete",
            Self::AppUpdateFailed => "app_update_failed",
            Self::AppUpdateInstalled => "app_update_installed",
            Self::RcloneUpdateAvailable => "rclone_update_available",
            Self::RcloneUpdateStarted => "rclone_update_started",
            Self::RcloneUpdateComplete => "rclone_update_complete",
            Self::RcloneUpdateFailed => "rclone_update_failed",
            Self::RcloneUpdateInstalled => "rclone_update_installed",
            Self::ScheduledTaskStarted => "scheduled_task_started",
            Self::ScheduledTaskCompleted => "scheduled_task_completed",
            Self::ScheduledTaskFailed => "scheduled_task_failed",
            Self::AlreadyRunning => "already_running",
            Self::AllJobsStopped => "all_jobs_stopped",
        }
    }
}

// =============================================================================
// ALERT RULE
// =============================================================================

/// A user-defined rule: "When this event fires under these conditions →
/// execute these actions."
#[derive(Debug, Clone, Serialize, Deserialize, DeriveSettingsSchema)]
pub struct AlertRule {
    /// UUID
    pub id: String,
    #[setting(label = "Name")]
    pub name: String,
    #[setting(label = "Enabled")]
    pub enabled: bool,

    /// Which event kinds trigger this rule. Empty = any event kind.
    #[setting(label = "Event Types")]
    pub event_filter: Vec<AlertEventKind>,

    /// Minimum severity to trigger. Defaults to `Info`.
    #[setting(object)]
    pub severity_min: AlertSeverity,

    /// Which remote names to watch. Empty = all remotes.
    #[setting(label = "Remote Filter")]
    pub remote_filter: Vec<String>,

    /// Which origins to watch (e.g. `[Origin::Scheduler]`). Empty = any origin.
    #[setting(label = "Origin Filter")]
    pub origin_filter: Vec<Origin>,

    /// IDs of `AlertAction` entries to execute when this rule fires.
    #[setting(label = "Actions")]
    pub action_ids: Vec<String>,

    /// Minimum seconds between firings of this rule. 0 = no cooldown.
    #[setting(label = "Cooldown (s)", min = 0)]
    #[serde(default)]
    pub cooldown_secs: u64,

    pub created_at: DateTime<Utc>,

    /// Updated by the engine after every successful dispatch.
    pub last_fired: Option<DateTime<Utc>>,

    /// Total number of times this rule has fired.
    #[serde(default)]
    pub fire_count: u64,
}

impl std::fmt::Display for AlertRule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.name)
    }
}

impl Default for AlertRule {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            enabled: false,
            event_filter: vec![],
            severity_min: AlertSeverity::Info,
            remote_filter: vec![],
            origin_filter: vec![],
            action_ids: vec![],
            cooldown_secs: 0,
            created_at: Utc::now(),
            last_fired: None,
            fire_count: 0,
        }
    }
}

// =============================================================================
// ALERT ACTIONS
// =============================================================================

/// A tagged-union of the different action types.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum AlertAction {
    #[serde(rename = "webhook")]
    Webhook(WebhookAction),
    #[serde(rename = "script")]
    Script(ScriptAction),
    #[serde(rename = "os_toast")]
    OsToast(OsToastAction),
}

impl rcman::SettingsSchema for AlertAction {
    fn get_metadata() -> std::collections::HashMap<String, rcman::SettingMetadata> {
        let mut meta = std::collections::HashMap::new();

        // Merge schemas from all variants to satisfy rcman's strict schema validation
        // Without this, rcman will reject valid payloads that contain variant-specific fields (like `id`, `url`, `command`).
        meta.extend(<WebhookAction as rcman::SettingsSchema>::get_metadata());
        meta.extend(<ScriptAction as rcman::SettingsSchema>::get_metadata());
        meta.extend(<OsToastAction as rcman::SettingsSchema>::get_metadata());

        // Add the enum tag field
        meta.insert(
            "kind".to_string(),
            rcman::SettingMetadata::select(
                "os_toast",
                vec![
                    rcman::opt("webhook", "Webhook"),
                    rcman::opt("script", "Shell Script"),
                    rcman::opt("os_toast", "System Notification"),
                ],
            )
            .meta_str("label", "Action Type"),
        );

        meta
    }
}

impl std::fmt::Display for AlertAction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.name())
    }
}

impl Default for AlertAction {
    fn default() -> Self {
        Self::OsToast(OsToastAction::default())
    }
}

impl AlertAction {
    pub fn id(&self) -> &str {
        match self {
            Self::Webhook(a) => &a.id,
            Self::Script(a) => &a.id,
            Self::OsToast(a) => &a.id,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Self::Webhook(a) => &a.name,
            Self::Script(a) => &a.name,
            Self::OsToast(a) => &a.name,
        }
    }

    pub fn is_enabled(&self) -> bool {
        match self {
            Self::Webhook(a) => a.enabled,
            Self::Script(a) => a.enabled,
            Self::OsToast(a) => a.enabled,
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        match self {
            Self::Webhook(a) => a.enabled = enabled,
            Self::Script(a) => a.enabled = enabled,
            Self::OsToast(a) => a.enabled = enabled,
        }
    }

    pub fn kind_str(&self) -> &'static str {
        match self {
            Self::Webhook(_) => "webhook",
            Self::Script(_) => "script",
            Self::OsToast(_) => "os_toast",
        }
    }
}

/// HTTP webhook action.
///
/// The `body_template` field supports Handlebars variables:
/// `{{title}}`, `{{body}}`, `{{severity}}`, `{{event_kind}}`,
/// `{{remote}}`, `{{operation}}`, `{{origin}}`, `{{timestamp}}`,
/// `{{rule_name}}`, etc.
#[derive(Debug, Clone, Serialize, Deserialize, DeriveSettingsSchema)]
pub struct WebhookAction {
    pub id: String,
    #[setting(label = "Name")]
    pub name: String,
    #[setting(label = "Enabled")]
    pub enabled: bool,
    #[setting(label = "URL", placeholder = "https://example.com/webhook")]
    pub url: String,
    #[setting(label = "Method", options(("POST", "POST"), ("GET", "GET"), ("PUT", "PUT")))]
    pub method: String,
    pub headers: HashMap<String, String>,
    #[setting(label = "Body Template", input_type = "textarea")]
    pub body_template: String,
    #[setting(label = "Timeout (s)", min = 1, max = 300)]
    pub timeout_secs: u64,
    #[setting(label = "Verify TLS")]
    pub tls_verify: bool,
    #[setting(label = "Retry Count", min = 0, max = 3)]
    pub retry_count: u8,
}

impl Default for WebhookAction {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            enabled: true,
            url: String::new(),
            method: "POST".to_string(), // Solves: Value must be one of the available options
            headers: HashMap::new(),
            body_template: String::new(),
            timeout_secs: 30, // Solves: min = 1 violation
            tls_verify: true,
            retry_count: 0,
        }
    }
}

/// Shell script / binary execution action.
///
/// The script receives alert context via environment variables:
/// `ALERT_TITLE`, `ALERT_BODY`, `ALERT_SEVERITY`, `ALERT_SEVERITY_CODE`,
/// `ALERT_EVENT_KIND`, `ALERT_REMOTE`, `ALERT_OPERATION`, `ALERT_ORIGIN`,
/// `ALERT_TIMESTAMP`, `ALERT_RULE_ID`, `ALERT_RULE_NAME`.
#[derive(Debug, Clone, Serialize, Deserialize, DeriveSettingsSchema)]
pub struct ScriptAction {
    pub id: String,
    #[setting(label = "Name")]
    pub name: String,
    #[setting(label = "Enabled")]
    pub enabled: bool,
    #[setting(label = "Command", placeholder = "/path/to/script.sh")]
    pub command: String,
    pub args: Vec<String>,
    #[setting(label = "Timeout (s)", min = 1, max = 3600)]
    pub timeout_secs: u64,
    pub env_vars: HashMap<String, String>,
}

impl Default for ScriptAction {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            enabled: true,
            command: String::new(),
            args: Vec::new(),
            timeout_secs: 30, // Solves: min = 1 violation
            env_vars: HashMap::new(),
        }
    }
}

/// OS native notification action.
///
/// Fires a system notification using `tauri-plugin-notification`.
/// Enabled/disabled state is toggled directly when the user changes the
/// `general.notifications` setting — there is no separate runtime flag check.
#[derive(Debug, Clone, Serialize, Deserialize, Default, DeriveSettingsSchema)]
pub struct OsToastAction {
    pub id: String,
    #[setting(label = "Name")]
    pub name: String,
    #[setting(label = "Enabled")]
    pub enabled: bool,
}

// =============================================================================
// ALERT RECORD  (history)
// =============================================================================

/// Immutable record of one alert firing. Written to the in-memory history cache.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertRecord {
    /// UUID
    pub id: String,
    pub rule_id: String,
    pub rule_name: String,
    pub event_kind: AlertEventKind,
    pub severity: AlertSeverity,
    /// Rendered notification title (i18n)
    pub title: String,
    /// Rendered notification body (i18n)
    pub body: String,
    pub remote: Option<String>,
    pub origin: Option<Origin>,
    pub timestamp: DateTime<Utc>,
    pub action_results: Vec<ActionResult>,
    pub acknowledged: bool,
    pub ack_at: Option<DateTime<Utc>>,
}

impl AlertRecord {
    pub fn new(
        rule: &AlertRule,
        event_kind: AlertEventKind,
        severity: AlertSeverity,
        title: String,
        body: String,
        remote: Option<String>,
        origin: Option<Origin>,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            rule_id: rule.id.clone(),
            rule_name: rule.name.clone(),
            event_kind,
            severity,
            title,
            body,
            remote,
            origin,
            timestamp: Utc::now(),
            action_results: vec![],
            acknowledged: false,
            ack_at: None,
        }
    }
}

/// Result of executing a single action within a rule firing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionResult {
    pub action_id: String,
    pub action_name: String,
    pub action_kind: String,
    pub success: bool,
    pub error: Option<String>,
    /// Execution duration in milliseconds.
    pub duration_ms: u64,
}

// =============================================================================
// ALERT STATS
// =============================================================================

/// Aggregate statistics about the alert history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertStats {
    pub total_fired: usize,
    pub unacknowledged: usize,
    pub by_severity: HashMap<String, usize>,
    pub by_rule: HashMap<String, usize>,
}

// =============================================================================
// PAGINATED HISTORY QUERY
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AlertHistoryFilter {
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    pub severity_min: Option<AlertSeverity>,
    pub event_kind: Option<AlertEventKind>,
    pub remote: Option<String>,
    pub acknowledged: Option<bool>,
    pub rule_id: Option<String>,
    pub origins: Option<Vec<crate::utils::types::origin::Origin>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertHistoryPage {
    pub items: Vec<AlertRecord>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
}
