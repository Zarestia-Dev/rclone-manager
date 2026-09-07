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
/// - Emitted by: `rclone::engine::lifecycle`, `core::check_binaries`, `utils::rclone::updater`
/// - Handled by: `RcloneStatusService`, `SystemHealthService`, `BannerComponent`
pub const RCLONE_ENGINE_STATUS_CHANGED: &str = "rclone_engine_status_changed";

/// Emitted when the rclone configuration password has been saved or unlocked.
/// - Emitted by: `core::security::commands`
/// - Handled by: `core::event_listener` (re-initializes engine), `AuthStateService`
pub const RCLONE_PASSWORD_STORED: &str = "rclone_password_stored";

/// Emitted when the active backend switches (e.g. between local rclone, docker, or remote daemon).
/// - Emitted by: `rclone::commands::backend`
/// - Handled by: `core::event_listener` (tray refresh), `RemoteFacadeService`, `NautilusService`
pub const BACKEND_SWITCHED: &str = "backend_switched";

// --- Remote Management Events ---

/// Emitted when remotes are created, updated, deleted, or renamed in rclone configuration.
/// - Emitted by: `rclone::commands::remote` (`create_remote`, `update_remote`, `delete_remote`, `rename_remote`)
/// - Handled by: `core::event_listener` (cache refresh & tray update), `RemoteFacadeService` (loadRemotes)
pub const REMOTE_CACHE_CHANGED: &str = "remote_cache_changed";

/// Emitted when an interactive OAuth URL is generated for remote configuration authorization.
/// - Emitted by: `rclone::commands::remote`
/// - Handled by: `AuthStateService` (opens browser / displays auth dialog)
pub const RCLONE_OAUTH_URL: &str = "rclone_oauth_url";

// --- System and Settings Events ---

/// Emitted when operational profiles/settings (mount, sync, bisync) for a remote are saved or deleted.
/// - Emitted by: `core::settings::remote::manager` (`save_remote_settings`, `delete_remote_settings`)
/// - Handled by: `core::event_listener` (tray update), `RemoteFacadeService` (loadRemotes)
pub const REMOTE_SETTINGS_CHANGED: &str = "remote_settings_changed";

/// Emitted when global system settings (notifications, autostart, theme, bandwith, etc.) change.
/// - Emitted by: `core::settings::operations::core`
/// - Handled by: `core::event_listener` (applies setting to OS/engine), `AppSettingsService`
pub const SYSTEM_SETTINGS_CHANGED: &str = "system_settings_changed";

/// Emitted when the active bandwidth limit is changed.
/// - Emitted by: `core::event_listener`, `rclone::commands::system`
/// - Handled by: `RcloneStatusService`
pub const BANDWIDTH_LIMIT_CHANGED: &str = "bandwidth_limit_changed";

/// Emitted when an encrypted rclone configuration has been successfully unlocked.
pub const RCLONE_CONFIG_UNLOCKED: &str = "rclone_config_unlocked";

// --- UI and Cache Events ---

/// Emitted to trigger an immediate tray menu re-render.
/// - Emitted by: `core::tray::core`, `core::event_listener`
pub const UPDATE_TRAY_MENU: &str = "tray_menu_updated";

/// Emitted when the OS system theme (dark/light) changes.
/// - Emitted by: `utils::app::ui`
/// - Handled by: `WindowService`
pub const SYSTEM_THEME_CHANGED: &str = "system_theme_changed";

/// Emitted when a background job starts, makes progress, or completes.
/// - Emitted by: `rclone::state::job`
/// - Handled by: `core::event_listener` (tray update & workflow engine), `JobManagementService`
pub const JOB_CACHE_CHANGED: &str = "job_cache_changed";

/// Emitted when a remote mount state changes (mounted, unmounted, error).
/// - Emitted by: `rclone::state::cache`
/// - Handled by: `core::event_listener` (tray update & power inhibition), `MountManagementService`
pub const MOUNT_STATE_CHANGED: &str = "mount_state_changed";

/// Emitted when a serve daemon state changes (started, stopped, error).
/// - Emitted by: `rclone::state::cache`
/// - Handled by: `core::event_listener` (tray update & power inhibition), `ServeManagementService`
pub const SERVE_STATE_CHANGED: &str = "serve_state_changed";

/// Emitted with system CPU, memory, and disk health metrics.
/// - Emitted by: `core::initialization`
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
/// - Emitted by: `rclone::state::automations`, `core::settings::remote::manager`
/// - Handled by: `AutomationService` (refreshAutomations)
pub const AUTOMATIONS_CACHE_CHANGED: &str = "automations_cache_changed";

// --- Workflow Events ---

pub const WORKFLOW_NODE_STATE_CHANGED: &str = "workflow_node_state_changed";
pub const WORKFLOW_EXECUTION_STATE_CHANGED: &str = "workflow_execution_state_changed";

// --- Alert Events ---

pub const ALERT_FIRED: &str = "alert_fired";

// --- Application Events ---

pub const APP_EVENT: &str = "app_event";

#[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
pub const APP_EXIT_REQUESTED: &str = "app_exit_requested";

pub const BROWSE: &str = "browse";

// --- File Transfer Events ---

/// Emitted during native file downloads to report throttled progress updates.
/// - Emitted by: `utils::io::file_helper::download_file`
/// - Handled by: `DownloadService`
pub const FILE_DOWNLOAD_PROGRESS: &str = "file_download_progress";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileDownloadProgressPayload {
    pub destination: String,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub percentage: Option<f64>,
}

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
    BROWSE,
    ALERT_FIRED,
    SYSTEM_STATUS,
    FILE_DOWNLOAD_PROGRESS,
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

/// Strongly typed payload for settings change events
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct SettingsChangeEvent {
    pub category: String,
    pub key: String,
    pub value: serde_json::Value,
}

/// Strongly typed payload for job cache change events
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobChangeEvent {
    pub job_id: String,
    pub status: crate::utils::types::jobs::JobStatus,
    pub remote: Option<String>,
    pub source: Option<String>,
    pub destination: Option<String>,
}

impl From<&crate::utils::types::jobs::JobInfo> for JobChangeEvent {
    fn from(job: &crate::utils::types::jobs::JobInfo) -> Self {
        Self {
            job_id: job.jobid.to_string(),
            status: job.status.clone(),
            remote: Some(job.remote_name.clone()),
            source: Some(job.source.join(", ")),
            destination: Some(job.destination.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
