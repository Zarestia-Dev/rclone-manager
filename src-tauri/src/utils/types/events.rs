// Event constants for emit/listen operations

// Core engine events
pub const RCLONE_API_URL_UPDATED: &str = "rclone_api_url_updated";
pub const ENGINE_RESTARTED: &str = "engine_restarted";

// Dedicated engine state events (no payload needed - event name indicates state)
pub const RCLONE_ENGINE_READY: &str = "rclone_engine_ready";
pub const RCLONE_ENGINE_ERROR: &str = "rclone_engine_error";
pub const RCLONE_ENGINE_PASSWORD_ERROR: &str = "rclone_engine_password_error";
pub const RCLONE_ENGINE_PATH_ERROR: &str = "rclone_engine_path_error";
pub const RCLONE_ENGINE_UPDATING: &str = "rclone_engine_updating";
pub const RCLONE_PASSWORD_STORED: &str = "rclone_password_stored";

// Remote management events
pub const REMOTE_STATE_CHANGED: &str = "remote_state_changed";
pub const REMOTE_PRESENCE_CHANGED: &str = "remote_presence_changed";
pub const REMOTE_CACHE_UPDATED: &str = "remote_cache_updated";
pub const REMOTE_DELETED: &str = "remote_deleted";

// System and settings events
pub const SYSTEM_SETTINGS_CHANGED: &str = "system_settings_changed";
pub const BANDWIDTH_LIMIT_CHANGED: &str = "bandwidth_limit_changed";
pub const RCLONE_CONFIG_UNLOCKED: &str = "rclone_config_unlocked";

// UI and cache events
pub const UPDATE_TRAY_MENU: &str = "tray_menu_updated";
pub const JOB_CACHE_CHANGED: &str = "job_cache_changed";
pub const NOTIFY_UI: &str = "notify_ui";
pub const MOUNT_STATE_CHANGED: &str = "mount_state_changed";
pub const SERVE_STATE_CHANGED: &str = "serve_state_changed";

// Plugin and installation events
pub const MOUNT_PLUGIN_INSTALLED: &str = "mount_plugin_installed";

// Network events
pub const NETWORK_STATUS_CHANGED: &str = "network_status_changed";

// Scheduled task events
pub const SCHEDULED_TASK_ERROR: &str = "scheduled_task_error";
pub const SCHEDULED_TASK_COMPLETED: &str = "scheduled_task_completed";
pub const SCHEDULED_TASK_STOPPED: &str = "scheduled_task_stopped";

// Application events
pub const APP_EVENT: &str = "app_event";
