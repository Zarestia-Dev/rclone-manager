// Event constants for emit/listen operations

// Core engine events
export const ENGINE_RESTARTED = 'engine_restarted';

// Dedicated engine state events (no payload needed - event name indicates state)
export const RCLONE_ENGINE_READY = 'rclone_engine_ready';
export const RCLONE_ENGINE_ERROR = 'rclone_engine_error';
export const RCLONE_ENGINE_PASSWORD_ERROR = 'rclone_engine_password_error';
export const RCLONE_ENGINE_PATH_ERROR = 'rclone_engine_path_error';
export const RCLONE_ENGINE_UPDATING = 'rclone_engine_updating';
export const RCLONE_PASSWORD_STORED = 'rclone_password_stored';

// Remote management events
// Remote management events
export const REMOTE_CACHE_CHANGED = 'remote_cache_changed';

// System and settings events
export const REMOTE_SETTINGS_CHANGED = 'remote_settings_changed';
export const SYSTEM_SETTINGS_CHANGED = 'system_settings_changed';
export const BANDWIDTH_LIMIT_CHANGED = 'bandwidth_limit_changed';
export const RCLONE_CONFIG_UNLOCKED = 'rclone_config_unlocked';

// UI and cache events
export const UPDATE_TRAY_MENU = 'tray_menu_updated';
export const JOB_CACHE_CHANGED = 'job_cache_changed';
export const MOUNT_STATE_CHANGED = 'mount_state_changed';
export const SERVE_STATE_CHANGED = 'serve_state_changed';

// Plugin and installation events
export const MOUNT_PLUGIN_INSTALLED = 'mount_plugin_installed';

// Network events
export const NETWORK_STATUS_CHANGED = 'network_status_changed';

// Scheduled task event
export const SCHEDULED_TASKS_CACHE_CHANGED = 'scheduled_tasks_cache_changed';

// Application events
export const APP_EVENT = 'app_event';
export const OPEN_INTERNAL_ROUTE = 'open_internal_route';
