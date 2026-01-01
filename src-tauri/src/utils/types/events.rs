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

// Application events
pub const APP_EVENT: &str = "app_event";
pub const OPEN_INTERNAL_ROUTE: &str = "open_internal_route";
