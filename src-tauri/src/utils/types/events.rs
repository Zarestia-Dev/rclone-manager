// Event constants for emit/listen operations

// Core engine events

pub const ENGINE_RESTARTED: &str = "engine_restarted";

// Dedicated engine state events (no payload needed - event name indicates state)
pub const RCLONE_ENGINE_READY: &str = "rclone_engine_ready";
pub const RCLONE_ENGINE_ERROR: &str = "rclone_engine_error";
pub const RCLONE_ENGINE_PASSWORD_ERROR: &str = "rclone_engine_password_error";
pub const RCLONE_ENGINE_PATH_ERROR: &str = "rclone_engine_path_error";
pub const RCLONE_ENGINE_UPDATING: &str = "rclone_engine_updating";
pub const RCLONE_PASSWORD_STORED: &str = "rclone_password_stored";
pub const BACKEND_SWITCHED: &str = "backend_switched";

// Remote management events
pub const REMOTE_CACHE_CHANGED: &str = "remote_cache_changed";
pub const RCLONE_OAUTH_URL: &str = "rclone_oauth_url";

// System and settings events
pub const REMOTE_SETTINGS_CHANGED: &str = "remote_settings_changed";
pub const SYSTEM_SETTINGS_CHANGED: &str = "system_settings_changed";
pub const BANDWIDTH_LIMIT_CHANGED: &str = "bandwidth_limit_changed";
pub const RCLONE_CONFIG_UNLOCKED: &str = "rclone_config_unlocked";

// UI and cache events
pub const UPDATE_TRAY_MENU: &str = "tray_menu_updated";
pub const JOB_CACHE_CHANGED: &str = "job_cache_changed";
pub const MOUNT_STATE_CHANGED: &str = "mount_state_changed";
pub const SERVE_STATE_CHANGED: &str = "serve_state_changed";

// Plugin and installation events
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub const MOUNT_PLUGIN_INSTALLED: &str = "mount_plugin_installed";

// Network events
pub const NETWORK_STATUS_CHANGED: &str = "network_status_changed";

// Scheduled task events
pub const SCHEDULED_TASKS_CACHE_CHANGED: &str = "scheduled_tasks_cache_changed";

// Alert events
pub const ALERT_FIRED: &str = "alert_fired";

// Application events
pub const APP_EVENT: &str = "app_event";
pub const BROWSE: &str = "browse";

/// List of all events that should be forwarded to SSE clients in headless mode
pub const SSE_FORWARD_EVENTS: &[&str] = &[
    ENGINE_RESTARTED,
    RCLONE_ENGINE_READY,
    RCLONE_ENGINE_ERROR,
    RCLONE_ENGINE_PASSWORD_ERROR,
    RCLONE_ENGINE_PATH_ERROR,
    RCLONE_ENGINE_UPDATING,
    RCLONE_PASSWORD_STORED,
    BACKEND_SWITCHED,
    REMOTE_CACHE_CHANGED,
    RCLONE_OAUTH_URL,
    REMOTE_SETTINGS_CHANGED,
    SYSTEM_SETTINGS_CHANGED,
    BANDWIDTH_LIMIT_CHANGED,
    RCLONE_CONFIG_UNLOCKED,
    UPDATE_TRAY_MENU,
    JOB_CACHE_CHANGED,
    MOUNT_STATE_CHANGED,
    SERVE_STATE_CHANGED,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    MOUNT_PLUGIN_INSTALLED,
    NETWORK_STATUS_CHANGED,
    SCHEDULED_TASKS_CACHE_CHANGED,
    APP_EVENT,
    BROWSE,
    ALERT_FIRED,
];

/// Strongly typed payload for settings change events
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct SettingsChangeEvent {
    pub category: String,
    pub key: String,
    pub value: serde_json::Value,
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
            value: json!("en"),
        };

        let serialized = serde_json::to_string(&event).unwrap();
        let expected = r#"{"category":"general","key":"language","value":"en"}"#;
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
}
