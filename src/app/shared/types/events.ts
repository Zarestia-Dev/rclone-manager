import { GlobalStats } from './jobs';
import { MemoryStats, RcloneInfo, RcloneStatus } from './system';

// Event constants
export const RCLONE_ENGINE_STATUS_CHANGED = 'rclone_engine_status_changed';
export const RCLONE_PASSWORD_STORED = 'rclone_password_stored';
export const REMOTE_CACHE_CHANGED = 'remote_cache_changed';
export const RCLONE_OAUTH_URL = 'rclone_oauth_url';
export const ALERT_FIRED = 'alert_fired';
export const REMOTE_SETTINGS_CHANGED = 'remote_settings_changed';
export const SYSTEM_SETTINGS_CHANGED = 'system_settings_changed';
export const BANDWIDTH_LIMIT_CHANGED = 'bandwidth_limit_changed';
export const RCLONE_CONFIG_UNLOCKED = 'rclone_config_unlocked';
export const UPDATE_TRAY_MENU = 'tray_menu_updated';
export const JOB_CACHE_CHANGED = 'job_cache_changed';
export const MOUNT_STATE_CHANGED = 'mount_state_changed';
export const SERVE_STATE_CHANGED = 'serve_state_changed';
export const SYSTEM_STATUS = 'system_status';
export const MOUNT_PLUGIN_INSTALLED = 'mount_plugin_installed';
export const NETWORK_STATUS_CHANGED = 'network_status_changed';
export const AUTOMATIONS_CACHE_CHANGED = 'automations_cache_changed';
export const APP_EVENT = 'app_event';
export const BROWSE = 'browse';

export interface SettingsChangeEvent {
  category: string;
  key: string;
  value: unknown;
}

export interface OAuthUrlEvent {
  url: string;
}

export interface JobChangeEvent {
  jobId: string;
  status: 'Running' | 'Completed' | 'Failed' | 'Stopped';
  remote?: string;
  source?: string;
  destination?: string;
}

export interface SystemStatusPayload {
  rcloneInfo: RcloneInfo | null;
  pid: number | null;
  stats: GlobalStats;
  memory: MemoryStats | null;
  status: RcloneStatus;
  hasActiveJobs: boolean;
}

export type EngineStatus =
  | { status: 'ready' }
  | { status: 'error'; payload: { message: string } }
  | { status: 'passwordError' }
  | { status: 'pathError' }
  | { status: 'versionError'; payload: { version: string; required: string } }
  | { status: 'updating' }
  | { status: 'restarted'; payload: { reason: string } };

export type EngineErrorType = 'password' | 'path' | 'version' | 'generic' | null;
