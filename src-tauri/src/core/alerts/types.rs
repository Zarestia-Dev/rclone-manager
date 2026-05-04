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

    /// Returns the numeric severity code.
    /// Delegates to the enum discriminant — always in sync with variant order.
    pub fn as_code(&self) -> u8 {
        self.clone() as u8
    }
}

// =============================================================================
// EVENT KIND
// =============================================================================

/// The class of event that triggered an alert.
/// Derived from `NotificationEvent` variants in the alert engine.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AlertEventKind {
    /// Manual rclone jobs (Sync, Copy, Move, Delete, etc.)
    Job,
    /// Background server processes (DLNA, WebDAV, etc.)
    Serve,
    /// FUSE drive mounting operations
    Mount,
    /// Core engine status and backend errors
    Engine,
    /// Software update lifecycle (App and Rclone)
    Update,
    /// Automated tasks triggered by the scheduler
    ScheduledTask,
    /// Application-level events (Startup, etc.)
    System,
    /// Export operations (credentials, profiles, settings, etc.)
    Export,
}

impl std::fmt::Display for AlertEventKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl AlertEventKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Job => "job",
            Self::Serve => "serve",
            Self::Mount => "mount",
            Self::Engine => "engine",
            Self::Update => "update",
            Self::ScheduledTask => "scheduled_task",
            Self::System => "system",
            Self::Export => "export",
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

    /// Which backend names to watch. Empty = all backends.
    #[setting(label = "Backend Filter")]
    pub backend_filter: Vec<String>,

    /// Which profile names to watch. Empty = all profiles.
    #[setting(label = "Profile Filter")]
    pub profile_filter: Vec<String>,

    /// IDs of `AlertAction` entries to execute when this rule fires.
    #[setting(label = "Actions")]
    pub action_ids: Vec<String>,

    /// Minimum seconds between firings of this rule. 0 = no cooldown.
    #[setting(label = "Cooldown (s)", min = 0)]
    #[serde(default)]
    pub cooldown_secs: u64,

    /// Maximum number of times this rule may fire. 0 = unlimited.
    #[setting(label = "Max Firings (0 = unlimited)", min = 0)]
    #[serde(default)]
    pub max_fire_count: u64,

    pub created_at: DateTime<Utc>,

    /// Updated by the engine immediately after the cooldown check passes,
    /// before actions are dispatched, to prevent double-firing on concurrent events.
    pub last_fired: Option<DateTime<Utc>>,

    /// Total number of times this rule has fired.
    #[serde(default)]
    pub fire_count: u64,

    /// If true, alerts fired by this rule will be automatically acknowledged.
    #[setting(label = "Auto Acknowledge")]
    #[serde(default)]
    pub auto_acknowledge: bool,

    /// Optional substring to match against the alert body.
    /// The filter is case-sensitive. Empty / None = match any body.
    #[setting(label = "Body Contains")]
    #[serde(default)]
    pub body_filter: Option<String>,
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
            backend_filter: vec![],
            profile_filter: vec![],
            action_ids: vec![],
            cooldown_secs: 0,
            max_fire_count: 0,
            created_at: Utc::now(),
            last_fired: None,
            fire_count: 0,
            auto_acknowledge: false,
            body_filter: None,
        }
    }
}

// =============================================================================
// ALERT ACTIONS
// =============================================================================

/// Shared fields present on every action variant.
/// Embed this in each concrete action struct so `AlertAction` accessor
/// methods can be a single field access instead of a 6-arm match.
#[derive(Debug, Clone, Serialize, Deserialize, Default, DeriveSettingsSchema)]
pub struct ActionCommon {
    pub id: String,
    #[setting(label = "Name")]
    pub name: String,
    #[setting(label = "Enabled")]
    pub enabled: bool,
}

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
    #[serde(rename = "telegram")]
    Telegram(TelegramAction),
    #[serde(rename = "mqtt")]
    Mqtt(MqttAction),
    #[serde(rename = "email")]
    Email(EmailAction),
}

impl rcman::SettingsSchema for AlertAction {
    fn get_metadata() -> std::collections::HashMap<String, rcman::SettingMetadata> {
        let mut meta = std::collections::HashMap::new();

        // Merge schemas from all variants to satisfy rcman's strict schema validation.
        meta.extend(<WebhookAction as rcman::SettingsSchema>::get_metadata());
        meta.extend(<ScriptAction as rcman::SettingsSchema>::get_metadata());
        meta.extend(<OsToastAction as rcman::SettingsSchema>::get_metadata());
        meta.extend(<TelegramAction as rcman::SettingsSchema>::get_metadata());
        meta.extend(<MqttAction as rcman::SettingsSchema>::get_metadata());
        meta.extend(<EmailAction as rcman::SettingsSchema>::get_metadata());

        // Add the enum tag field
        meta.insert(
            "kind".to_string(),
            rcman::SettingMetadata::select(
                "os_toast",
                vec![
                    rcman::opt("webhook", "Webhook"),
                    rcman::opt("script", "Shell Script"),
                    rcman::opt("os_toast", "System Notification"),
                    rcman::opt("telegram", "Telegram"),
                    rcman::opt("mqtt", "MQTT"),
                    rcman::opt("email", "Email"),
                ],
            )
            .meta_str("label", "Action Type"),
        );

        meta
    }
}

impl std::fmt::Display for AlertAction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.common().name)
    }
}

impl Default for AlertAction {
    fn default() -> Self {
        Self::OsToast(OsToastAction::default())
    }
}

impl AlertAction {
    /// Returns a reference to the shared fields common to all action variants.
    pub fn common(&self) -> &ActionCommon {
        match self {
            Self::Webhook(a) => &a.common,
            Self::Script(a) => &a.common,
            Self::OsToast(a) => &a.common,
            Self::Telegram(a) => &a.common,
            Self::Mqtt(a) => &a.common,
            Self::Email(a) => &a.common,
        }
    }

    /// Returns a mutable reference to the shared fields.
    pub fn common_mut(&mut self) -> &mut ActionCommon {
        match self {
            Self::Webhook(a) => &mut a.common,
            Self::Script(a) => &mut a.common,
            Self::OsToast(a) => &mut a.common,
            Self::Telegram(a) => &mut a.common,
            Self::Mqtt(a) => &mut a.common,
            Self::Email(a) => &mut a.common,
        }
    }

    pub fn id(&self) -> &str {
        &self.common().id
    }

    pub fn name(&self) -> &str {
        &self.common().name
    }

    pub fn is_enabled(&self) -> bool {
        self.common().enabled
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.common_mut().enabled = enabled;
    }

    pub fn kind_str(&self) -> &'static str {
        match self {
            Self::Webhook(_) => "webhook",
            Self::Script(_) => "script",
            Self::OsToast(_) => "os_toast",
            Self::Telegram(_) => "telegram",
            Self::Mqtt(_) => "mqtt",
            Self::Email(_) => "email",
        }
    }
}

/// HTTP webhook action.
///
/// The `body_template` field supports Handlebars variables:
/// `{{title}}`, `{{body}}`, `{{severity}}`, `{{event_kind}}`,
/// `{{remote}}`, `{{profile}}`, `{{backend}}`, `{{operation}}`, `{{origin}}`, `{{timestamp}}`,
/// `{{rule_name}}`, etc.
#[derive(Debug, Clone, Serialize, Deserialize, DeriveSettingsSchema)]
pub struct WebhookAction {
    #[serde(flatten)]
    pub common: ActionCommon,
    #[setting(
        secret,
        label = "URL",
        placeholder = "https://example.com/webhook",
        input_type = "password"
    )]
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
            common: ActionCommon {
                id: String::new(),
                name: String::new(),
                enabled: true,
            },
            url: String::new(),
            method: "POST".to_string(),
            headers: HashMap::new(),
            body_template: String::new(),
            timeout_secs: 30,
            tls_verify: true,
            retry_count: 0,
        }
    }
}

/// Shell script / binary execution action.
///
/// The script receives alert context via environment variables:
/// `ALERT_TITLE`, `ALERT_BODY`, `ALERT_SEVERITY`, `ALERT_SEVERITY_CODE`,
/// `ALERT_EVENT_KIND`, `ALERT_REMOTE`, `ALERT_PROFILE`, `ALERT_BACKEND`,
/// `ALERT_OPERATION`, `ALERT_ORIGIN`, `ALERT_TIMESTAMP`, `ALERT_RULE_ID`,
/// `ALERT_RULE_NAME`, `ALERT_JSON`.
#[derive(Debug, Clone, Serialize, Deserialize, DeriveSettingsSchema)]
pub struct ScriptAction {
    #[serde(flatten)]
    pub common: ActionCommon,
    #[setting(label = "Command", placeholder = "/path/to/script.sh")]
    pub command: String,
    pub args: Vec<String>,
    #[setting(label = "Timeout (s)", min = 1, max = 3600)]
    pub timeout_secs: u64,
    pub env_vars: HashMap<String, String>,
    #[setting(label = "Retry Count", min = 0, max = 5)]
    pub retry_count: u8,
}

impl Default for ScriptAction {
    fn default() -> Self {
        Self {
            common: ActionCommon {
                id: String::new(),
                name: String::new(),
                enabled: true,
            },
            command: String::new(),
            args: Vec::new(),
            timeout_secs: 30,
            env_vars: HashMap::new(),
            retry_count: 0,
        }
    }
}

/// OS native notification action.
///
/// Fires a system notification using `tauri-plugin-notification`.
/// Enabled/disabled state is toggled directly when the user changes the
/// `general.notifications` setting.
#[derive(Debug, Clone, Serialize, Deserialize, Default, DeriveSettingsSchema)]
pub struct OsToastAction {
    #[serde(flatten)]
    pub common: ActionCommon,
}

/// Telegram bot notification action.
///
/// Sends messages to Telegram using the Bot API.
/// The `body_template` supports Handlebars variables like webhook actions.
#[derive(Debug, Clone, Serialize, Deserialize, DeriveSettingsSchema)]
pub struct TelegramAction {
    #[serde(flatten)]
    pub common: ActionCommon,
    #[setting(secret, label = "Bot Token", input_type = "password")]
    pub bot_token: String,
    #[setting(secret, label = "Chat ID", input_type = "password")]
    pub chat_id: String,
    #[setting(label = "Message Template", input_type = "textarea")]
    pub body_template: String,
    #[setting(label = "Timeout (s)", min = 1, max = 300)]
    pub timeout_secs: u64,
    #[setting(label = "Retry Count", min = 0, max = 3)]
    pub retry_count: u8,
}

impl Default for TelegramAction {
    fn default() -> Self {
        Self {
            common: ActionCommon {
                id: String::new(),
                name: String::new(),
                enabled: true,
            },
            bot_token: String::new(),
            chat_id: String::new(),
            body_template: String::new(),
            timeout_secs: 30,
            retry_count: 0,
        }
    }
}

/// MQTT publish action.
#[derive(Debug, Clone, Serialize, Deserialize, DeriveSettingsSchema)]
pub struct MqttAction {
    #[serde(flatten)]
    pub common: ActionCommon,
    #[setting(label = "Host", placeholder = "localhost")]
    pub host: String,
    #[setting(label = "Port", min = 1, max = 65535)]
    pub port: u16,
    #[setting(label = "Use TLS")]
    pub use_tls: bool,
    #[setting(label = "Topic", placeholder = "rclone/alerts")]
    pub topic: String,
    #[setting(secret, label = "Username", input_type = "password")]
    pub username: String,
    #[setting(secret, label = "Password", input_type = "password")]
    pub password: String,
    #[setting(label = "QoS", min = 0, max = 2)]
    pub qos: u8,
    #[setting(label = "Retain")]
    pub retain: bool,
    #[setting(label = "Message Template", input_type = "textarea")]
    pub body_template: String,
    #[setting(label = "Timeout (s)", min = 1, max = 300)]
    pub timeout_secs: u64,
    #[setting(label = "Retry Count", min = 0, max = 3)]
    pub retry_count: u8,
}

impl Default for MqttAction {
    fn default() -> Self {
        Self {
            common: ActionCommon {
                id: String::new(),
                name: String::new(),
                enabled: true,
            },
            host: "localhost".to_string(),
            port: 1883,
            use_tls: false,
            topic: "rclone/alerts".to_string(),
            username: String::new(),
            password: String::new(),
            qos: 0,
            retain: false,
            body_template: String::new(),
            timeout_secs: 30,
            retry_count: 0,
        }
    }
}

/// Email notification action.
#[derive(Debug, Clone, Serialize, Deserialize, DeriveSettingsSchema)]
pub struct EmailAction {
    #[serde(flatten)]
    pub common: ActionCommon,
    #[setting(label = "SMTP Server", placeholder = "smtp.gmail.com")]
    pub smtp_server: String,
    #[setting(label = "SMTP Port", min = 1, max = 65535)]
    pub smtp_port: u16,
    #[setting(secret, label = "Username", input_type = "password")]
    pub username: String,
    #[setting(secret, label = "Password", input_type = "password")]
    pub password: String,
    #[setting(label = "From Address", placeholder = "alerts@example.com")]
    pub from: String,
    #[setting(label = "To Address", placeholder = "you@example.com")]
    pub to: String,
    #[setting(label = "Subject Template")]
    pub subject_template: String,
    #[setting(label = "Body Template", input_type = "textarea")]
    pub body_template: String,
    #[setting(label = "Encryption", options(("none", "None"), ("tls", "TLS"), ("starttls", "StartTLS")))]
    pub encryption: String,
    #[setting(label = "Timeout (s)", min = 1, max = 300)]
    pub timeout_secs: u64,
    #[setting(label = "Retry Count", min = 0, max = 5)]
    pub retry_count: u8,
}

impl Default for EmailAction {
    fn default() -> Self {
        Self {
            common: ActionCommon {
                id: String::new(),
                name: String::new(),
                enabled: true,
            },
            smtp_server: String::new(),
            smtp_port: 587,
            username: String::new(),
            password: String::new(),
            from: String::new(),
            to: String::new(),
            subject_template: "Rclone Alert: {{title}}".to_string(),
            body_template: String::new(),
            encryption: "starttls".to_string(),
            timeout_secs: 30,
            retry_count: 1,
        }
    }
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
    pub profile: Option<String>,
    pub backend: Option<String>,
    pub operation: Option<String>,
    pub origin: Option<Origin>,
    pub timestamp: DateTime<Utc>,
    pub action_results: Vec<ActionResult>,
    pub acknowledged: bool,
    pub ack_at: Option<DateTime<Utc>>,
}

/// Details of an alert firing, grouped to avoid clippy::too_many_arguments.
#[derive(Debug, Clone)]
pub struct AlertDetails {
    pub event_kind: AlertEventKind,
    pub severity: AlertSeverity,
    pub title: String,
    pub body: String,
    pub remote: Option<String>,
    pub profile: Option<String>,
    pub backend: Option<String>,
    pub operation: Option<String>,
    pub origin: Option<Origin>,
}

impl AlertRecord {
    pub fn new(rule: &AlertRule, details: AlertDetails) -> Self {
        let timestamp = Utc::now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            rule_id: rule.id.clone(),
            rule_name: rule.name.clone(),
            event_kind: details.event_kind,
            severity: details.severity,
            title: details.title,
            body: details.body,
            remote: details.remote,
            profile: details.profile,
            backend: details.backend,
            operation: details.operation,
            origin: details.origin,
            timestamp,
            action_results: vec![],
            acknowledged: rule.auto_acknowledge,
            ack_at: rule.auto_acknowledge.then_some(timestamp),
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
    pub by_severity: HashMap<AlertSeverity, usize>,
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
    pub profile: Option<String>,
    pub backend: Option<String>,
    pub acknowledged: Option<bool>,
    pub rule_id: Option<String>,
    pub origins: Option<Vec<crate::utils::types::origin::Origin>>,
    pub from_ts: Option<DateTime<Utc>>,
    pub to_ts: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertHistoryPage {
    pub items: Vec<AlertRecord>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
}
