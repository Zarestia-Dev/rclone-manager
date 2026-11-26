// Event constants for Tauri emit/listen operations.
//
// ============================================================================
// ARCHITECTURE GUIDE: Event-Driven State Flow
// ----------------------------------------------------------------------------
// Backend mutations (e.g. creating remotes, modifying settings, starting jobs)
// emit structured events over Tauri's IPC / SSE event bus.
//
// Frontend services listen to these domain-specific events, coalesce rapid
// successive emissions with `auditTime`, and re-fetch only the affected data.
// UI components (e.g. HomeComponent) reactively bind to Angular signals in
// those services rather than issuing manual ad-hoc full refreshes.
// ============================================================================

// --- Core Engine Events ---

/// Emitted when rclone engine transitions between phases (Ready, Updating, Error, etc.).
/// - Emitted by: `rclone::engine::lifecycle`, `services::check_binaries`, `rclone::binaries::updater`
/// - Handled by: `RcloneStatusService`, `SystemHealthService`, `BannerComponent`
pub const RCLONE_ENGINE_STATUS_CHANGED: &str = "rclone_engine_status_changed";

/// Emitted when the rclone configuration password has been saved or unlocked.
/// - Emitted by: `services::security::commands`
/// - Handled by: `services::event_listener` (re-initializes engine)
pub const RCLONE_PASSWORD_STORED: &str = "rclone_password_stored";

/// Emitted when the active backend switches (e.g. between local rclone, docker, or remote daemon).
/// - Emitted by: `rclone::commands::backend`
/// - Handled by: `services::event_listener` (tray refresh), `RemoteFacadeService`, `NautilusService`
pub const BACKEND_SWITCHED: &str = "backend_switched";

// --- Remote Management Events ---

/// Emitted when remotes are created, updated, deleted, or renamed in rclone configuration.
/// - Emitted by: `rclone::commands::remote` (`create_remote`, `update_remote`, `delete_remote`, `rename_remote`)
/// - Handled by: `services::event_listener` (cache refresh & tray update), `RemoteFacadeService` (loadRemotes)
pub const REMOTE_CACHE_CHANGED: &str = "remote_cache_changed";

/// Emitted when an interactive OAuth URL is generated for remote configuration authorization.
/// - Emitted by: `rclone::commands::remote`
/// - Handled by: `AuthStateService` (opens browser / displays auth dialog)
pub const RCLONE_OAUTH_URL: &str = "rclone_oauth_url";

// --- System and Settings Events ---

/// Emitted when operational profiles/settings (mount, sync, bisync) for a remote are saved or deleted.
/// - Emitted by: `services::settings::remote::manager` (`save_remote_settings`, `delete_remote_settings`)
/// - Handled by: `services::event_listener` (tray update), `RemoteFacadeService` (loadRemotes)
pub const REMOTE_SETTINGS_CHANGED: &str = "remote_settings_changed";

/// Emitted when global system settings (notifications, autostart, theme, bandwidth, etc.) change.
/// - Emitted by: `services::settings::operations::core`
/// - Handled by: `services::event_listener` (applies setting to OS/engine), `AppSettingsService`
///
/// `category` and `key` of `"*"` mean "reload everything". After a reset all, `value` is
/// `{"category.key": new value}` for every setting the reset changed, which the backend
/// listener applies; the other `"*"` emitters (vault unlock, system refresh) send `null`.
pub const SYSTEM_SETTINGS_CHANGED: &str = "system_settings_changed";

/// Emitted when the active bandwidth limit is changed.
/// - Emitted by: `services::event_listener`, `rclone::commands::system`
/// - Handled by: `RcloneStatusService`
pub const BANDWIDTH_LIMIT_CHANGED: &str = "bandwidth_limit_changed";

/// Emitted when an encrypted rclone configuration has been successfully unlocked.
pub const RCLONE_CONFIG_UNLOCKED: &str = "rclone_config_unlocked";

/// Emitted when the rcman configuration vault state changes (locked, unlocked, auto_locked, password_changed, enabled, disabled).
/// - Emitted by: `services::settings::vault` and `rcman::on_vault_event`
/// - Handled by: `VaultService`, `EventListenersService`
pub const VAULT_STATE_CHANGED: &str = "vault_state_changed";

// --- UI and Cache Events ---

/// Emitted to trigger an immediate tray menu re-render.
/// - Emitted by: `utils::i18n`, `native::theme`, `services::automation::engine`,
///   `services::initialization`, `rclone::engine::post_start`
/// - Handled by: `services::event_listener` (delegates to the desktop tray host)
pub const UPDATE_TRAY_MENU: &str = "tray_menu_updated";

/// Emitted when the OS system theme (dark/light) changes. In `PUBLIC_EVENTS`.
/// - Emitted by: `native::theme`
/// - Handled by: `WindowService`
pub const SYSTEM_THEME_CHANGED: &str = "system_theme_changed";

/// Emitted on Linux desktops when the title bar button layout changes, with the new layout
/// string or null. Desktop only: headless has no window buttons, so it is not in
/// `SSE_FORWARD_EVENTS`. In `PUBLIC_EVENTS`.
/// - Emitted by: `native::window` (XDG settings portal watcher, started by `get_window_button_layout`)
/// - Handled by: `WindowService`
pub const WINDOW_BUTTON_LAYOUT_CHANGED: &str = "window_button_layout_changed";

/// Emitted on Linux, Windows and macOS when the system accent colour changes, with the new
/// colour as `#rrggbb` or null. Desktop only, like the button layout. In `PUBLIC_EVENTS`.
/// - Emitted by: `native::accent` (started by `get_system_accent_color`)
/// - Handled by: `WindowService`
pub const SYSTEM_ACCENT_COLOR_CHANGED: &str = "system_accent_color_changed";

/// Emitted when a job is added, starts, completes, fails, stops, or is removed, with the job
/// itself ([`JobChangeEvent`]), so a listener need not fetch the whole list again.
/// - Emitted by: `rclone::state::job`
/// - Handled by: `services::event_listener` (tray update & workflow engine), `JobManagementService`,
///   `NautilusTabService` (refreshes the folders a job that ended changed)
pub const JOB_CACHE_CHANGED: &str = "job_cache_changed";

/// Emitted during ongoing job monitoring when transfer progress or speed statistics are updated.
/// - Emitted by: `rclone::state::job`
/// - Handled by: `JobManagementService`, `services::event_listener` (Android notification progress)
pub const JOB_STATS_UPDATED: &str = "job_stats_updated";

/// Emitted when a remote mount state changes (mounted, unmounted, error).
/// - Emitted by: `rclone::state::cache`
/// - Handled by: `services::event_listener` (tray update & power inhibition), `MountManagementService`
pub const MOUNT_STATE_CHANGED: &str = "mount_state_changed";

/// Emitted when a serve daemon state changes (started, stopped, error).
/// - Emitted by: `rclone::state::cache`
/// - Handled by: `services::event_listener` (tray update & power inhibition), `ServeManagementService`
pub const SERVE_STATE_CHANGED: &str = "serve_state_changed";

/// Emitted with system CPU, memory, and disk health metrics.
/// - Emitted by: `services::initialization`
/// - Handled by: `RcloneStatusService`
pub const SYSTEM_STATUS: &str = "system_status";

// --- Plugin and Installation Events ---

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub const MOUNT_PLUGIN_INSTALLED: &str = "mount_plugin_installed";
pub const PROVISION_PROGRESS: &str = "provision_progress";

// --- Network Events ---

/// Emitted when network status (online/offline/metered) changes.
/// - Emitted by: `utils::io::network`
/// - Handled by: `BannerComponent`
pub const NETWORK_STATUS_CHANGED: &str = "network_status_changed";

// --- Automation Events ---

/// Emitted when scheduled automations (cron, watchers) are added, updated, removed, or bulk-reloaded.
/// - Emitted by: `rclone::state::automations`, `services::settings::remote::manager`
/// - Handled by: `AutomationService` (refreshAutomations)
pub const AUTOMATIONS_CACHE_CHANGED: &str = "automations_cache_changed";

// --- Workflow Events ---

/// Emitted when a step of a workflow run changes state. Carries the run's `runId` and a
/// `seq` that orders the events of the run; the same events make up the snapshots
/// `get_workflow_runs` returns.
/// - Emitted by: `services::flow::workflow::engine::record::RunHandle`
/// - Handled by: `WorkflowEventService`
pub const WORKFLOW_NODE_STATE_CHANGED: &str = "workflow_node_state_changed";

/// Emitted when a workflow run starts, makes progress or ends (completed, failed or cancelled).
/// - Emitted by: `services::flow::workflow::engine::record::RunHandle`
/// - Handled by: `WorkflowEventService`, and the tray (re-render)
pub const WORKFLOW_EXECUTION_STATE_CHANGED: &str = "workflow_execution_state_changed";

// --- Alert Events ---

pub const ALERT_FIRED: &str = "alert_fired";

// --- Application Events ---

pub const APP_EVENT: &str = "app_event";

/// Emitted once when shutdown begins, with a null payload, so the interface can show its
/// closing screen. In `PUBLIC_EVENTS`: it carries no vault data, and a locked interface
/// would otherwise close without a word.
/// - Emitted by: `services::lifecycle::shutdown`
/// - Handled by: `GlobalLoadingService`
pub const APP_SHUTTING_DOWN: &str = "app_shutting_down";

/// `status` values of updater [`APP_EVENT`]s, consumed by `EventListenersService`.
/// `UPDATE_FOUND`/`RCLONE_UPDATE_FOUND` carry an `UpdateInfo` (services/updates,
/// rclone/binaries/updater); `DOWNLOAD_PROGRESS` a `DownloadStatus` (updates/install).
pub mod app_event_status {
    pub const UPDATE_FOUND: &str = "update_found";
    pub const RCLONE_UPDATE_FOUND: &str = "rclone_update_found";
    pub const DOWNLOAD_PROGRESS: &str = "download_progress";
}

/// Emitted by app/rclone updaters after state changes; consumed by frontend update services.
pub const UPDATER_STATE_CHANGED: &str = "updater_state_changed";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "target", rename_all = "camelCase")]
pub enum UpdaterStateChanged {
    App,
    Rclone,
}

/// Emitted by the native host; consumed by AppLifecycleService for exit confirmation.
/// Locked desktop windows receive a native-only notice with operation counts redacted.
#[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
pub const APP_EXIT_REQUESTED: &str = "app_exit_requested";

pub const BROWSE: &str = "browse";

/// Events a locked interface still receives. They carry no vault data: the vault state
/// itself and display state the lock screen needs to look right. Every other event is
/// withheld until the vault is unlocked.
pub const PUBLIC_EVENTS: &[&str] = &[
    VAULT_STATE_CHANGED,
    SYSTEM_THEME_CHANGED,
    WINDOW_BUTTON_LAYOUT_CHANGED,
    SYSTEM_ACCENT_COLOR_CHANGED,
    APP_SHUTTING_DOWN,
];

/// List of all events that should be forwarded to SSE clients in headless mode
pub const SSE_FORWARD_EVENTS: &[&str] = &[
    RCLONE_ENGINE_STATUS_CHANGED,
    RCLONE_PASSWORD_STORED,
    BACKEND_SWITCHED,
    REMOTE_CACHE_CHANGED,
    RCLONE_OAUTH_URL,
    REMOTE_SETTINGS_CHANGED,
    SYSTEM_SETTINGS_CHANGED,
    BANDWIDTH_LIMIT_CHANGED,
    RCLONE_CONFIG_UNLOCKED,
    UPDATE_TRAY_MENU,
    SYSTEM_THEME_CHANGED,
    JOB_CACHE_CHANGED,
    JOB_STATS_UPDATED,
    MOUNT_STATE_CHANGED,
    SERVE_STATE_CHANGED,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    MOUNT_PLUGIN_INSTALLED,
    PROVISION_PROGRESS,
    NETWORK_STATUS_CHANGED,
    AUTOMATIONS_CACHE_CHANGED,
    WORKFLOW_NODE_STATE_CHANGED,
    WORKFLOW_EXECUTION_STATE_CHANGED,
    APP_EVENT,
    APP_SHUTTING_DOWN,
    BROWSE,
    UPDATER_STATE_CHANGED,
    ALERT_FIRED,
    SYSTEM_STATUS,
    VAULT_STATE_CHANGED,
];

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(tag = "status", content = "payload", rename_all = "camelCase")]
pub enum EngineStatus {
    Ready,
    Error { message: String },
    PasswordError,
    AuthError { message: String },
    PathError,
    VersionError { version: String, required: String },
    PortError { port: u16, message: String },
    Updating,
    Restarted { reason: String },
}

impl From<&crate::utils::types::state::EnginePhase> for EngineStatus {
    fn from(phase: &crate::utils::types::state::EnginePhase) -> Self {
        use crate::utils::types::state::EnginePhase;
        match phase {
            EnginePhase::Running => Self::Ready,
            #[cfg(not(feature = "librclone"))]
            EnginePhase::Updating => Self::Updating,
            #[cfg(not(feature = "librclone"))]
            EnginePhase::FailedPath => Self::PathError,
            #[cfg(not(feature = "librclone"))]
            EnginePhase::FailedVersion { version, required } => Self::VersionError {
                version: version.clone(),
                required: required.clone(),
            },
            #[cfg(not(feature = "librclone"))]
            EnginePhase::FailedPort { port, message } => Self::PortError {
                port: *port,
                message: message.clone(),
            },
            EnginePhase::FailedPassword => Self::PasswordError,
            EnginePhase::FailedAuth { message } => Self::AuthError {
                message: message.clone(),
            },
            EnginePhase::FailedOther { message } => Self::Error {
                message: message.clone(),
            },
            EnginePhase::Stopped | EnginePhase::Starting | EnginePhase::Stopping => Self::Error {
                message: format!("engine phase: {phase}"),
            },
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(tag = "status", content = "payload", rename_all = "camelCase")]
pub enum ProvisionProgressPayload {
    InProgress(String),
    Complete(String),
    Error(String),
}

/// Strongly typed payload for job stats update events
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobStatsUpdatedEvent {
    pub job_id: u64,
    pub backend_name: String,
    #[serde(default)]
    pub execute_id: Option<String>,
    #[serde(default)]
    pub stats_revision: u64,
    pub stats: serde_json::Value,
}

impl From<&super::jobs::JobInfo> for JobStatsUpdatedEvent {
    fn from(job: &super::jobs::JobInfo) -> Self {
        Self {
            job_id: job.jobid,
            backend_name: job.backend_name.clone(),
            execute_id: job.execute_id.clone(),
            stats_revision: job.stats_revision,
            stats: job.stats.clone().unwrap_or(serde_json::Value::Null),
        }
    }
}

/// Strongly typed payload for settings change events
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsChangeEvent {
    pub category: String,
    pub key: String,
    pub value: serde_json::Value,
}

/// Strongly typed payload for configuration vault state events
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatePayload {
    pub event: String,
    pub is_locked: bool,
    pub is_enabled: bool,
    #[serde(default)]
    pub lock_timeout: Option<u64>,
}

/// A change in the list of jobs: one was added, changed or removed.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobChangeEvent {
    pub job_id: u64,
    pub backend_name: String,
    /// The job after the change, as the job lists carry it ([`super::jobs::JobInfo::summary`]);
    /// none once it was removed from the list.
    pub job: Option<super::jobs::JobInfo>,
    /// Set only by the change that ended the job, not by later ones (its final stats, a parent
    /// refresh), so a listener reacts to the end once.
    #[serde(default)]
    pub ended: bool,
}

impl JobChangeEvent {
    #[must_use]
    pub fn changed(job: &super::jobs::JobInfo, ended: bool) -> Self {
        Self {
            job_id: job.jobid,
            backend_name: job.backend_name.clone(),
            job: Some(job.summary()),
            ended,
        }
    }

    #[must_use]
    pub fn removed(job: &super::jobs::JobInfo) -> Self {
        Self {
            job_id: job.jobid,
            backend_name: job.backend_name.clone(),
            job: None,
            ended: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::types::starter::{Starter, WorkflowRun};
    use serde_json::json;

    #[test]
    fn test_settings_change_event_serialization() {
        let event = SettingsChangeEvent {
            category: "general".to_string(),
            key: "language".to_string(),
            value: json!("en-US"),
        };

        let serialized = serde_json::to_string(&event).unwrap();
        let expected = r#"{"category":"general","key":"language","value":"en-US"}"#;
        assert_eq!(serialized, expected);

        let deserialized: SettingsChangeEvent = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized, event);
    }

    #[test]
    fn test_settings_change_event_with_complex_value() {
        let event = SettingsChangeEvent {
            category: "core".to_string(),
            key: "bandwidth_limit".to_string(),
            value: json!({ "limit": "10M", "enabled": true }),
        };

        let serialized = serde_json::to_string(&event).unwrap();
        let deserialized: SettingsChangeEvent = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized.value["limit"], "10M");
        assert_eq!(deserialized.value["enabled"], true);
    }

    #[test]
    fn test_engine_status_port_error_serialization() {
        let status = EngineStatus::PortError {
            port: 51900,
            message: "Port in use".to_string(),
        };
        let serialized = serde_json::to_string(&status).unwrap();
        assert!(serialized.contains(r#""status":"portError""#));
        assert!(serialized.contains(r#""port":51900"#));

        let deserialized: EngineStatus = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized, status);
    }

    #[test]
    #[cfg(not(feature = "librclone"))]
    fn test_engine_phase_to_engine_status_conversion() {
        use crate::utils::types::state::EnginePhase;

        let phase = EnginePhase::FailedPort {
            port: 51901,
            message: "Address already in use".to_string(),
        };
        let status: EngineStatus = (&phase).into();
        assert_eq!(
            status,
            EngineStatus::PortError {
                port: 51901,
                message: "Address already in use".to_string(),
            }
        );
    }

    #[test]
    fn a_job_change_carries_the_job_and_a_removal_carries_none() {
        use crate::utils::types::jobs::JobInfo;

        let job = JobInfo {
            jobid: 42,
            source: vec!["first:folder/a, b.txt".into(), "second:c.txt".into()],
            destination: "gdrive:backup".to_string(),
            starter: Some(Starter::Workflow(WorkflowRun::new(
                "wf-b",
                "Workflow",
                "node-1",
                vec!["wf-a".into()],
            ))),
            backend_name: "NAS".to_string(),
            ..JobInfo::for_test()
        };

        let json = serde_json::to_value(JobChangeEvent::changed(&job, true)).unwrap();
        assert_eq!(json["jobId"], 42);
        assert_eq!(json["backendName"], "NAS");
        assert_eq!(json["ended"], true);
        assert_eq!(json["job"]["source"], json!(job.source));
        assert_eq!(json["job"]["starter"]["workflowId"], "wf-b");
        let parsed: JobChangeEvent = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.job.unwrap().destination, "gdrive:backup");

        let removed = serde_json::to_value(JobChangeEvent::removed(&job)).unwrap();
        assert_eq!(removed["job"], serde_json::Value::Null);
        assert_eq!(removed["ended"], false);
    }

    #[test]
    fn test_job_stats_updated_event_serialization() {
        let ev = JobStatsUpdatedEvent {
            job_id: 585,
            backend_name: "Local".to_string(),
            execute_id: Some("exec-585".to_string()),
            stats_revision: 7,
            stats: json!({
                "bytes": 1024,
                "speed": 128.5,
                "eta": 10
            }),
        };

        let serialized = serde_json::to_string(&ev).unwrap();
        assert!(serialized.contains(r#""jobId":585"#));
        assert!(serialized.contains(r#""executeId":"exec-585""#));
        assert!(serialized.contains(r#""statsRevision":7"#));
        assert!(serialized.contains(r#""bytes":1024"#));

        let deserialized: JobStatsUpdatedEvent = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized, ev);
    }
}
