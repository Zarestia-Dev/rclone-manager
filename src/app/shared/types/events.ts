import { GlobalStats, JobStatus } from './jobs';
import { MemoryStats, RcloneInfo, RcloneStatus } from './system';

// Event constants
export const RCLONE_ENGINE_STATUS_CHANGED = 'rclone_engine_status_changed' as const;
export const RCLONE_PASSWORD_STORED = 'rclone_password_stored' as const;
export const BACKEND_SWITCHED = 'backend_switched' as const;
export const REMOTE_CACHE_CHANGED = 'remote_cache_changed' as const;
export const RCLONE_OAUTH_URL = 'rclone_oauth_url' as const;
export const ALERT_FIRED = 'alert_fired' as const;
export const REMOTE_SETTINGS_CHANGED = 'remote_settings_changed' as const;
export const SYSTEM_SETTINGS_CHANGED = 'system_settings_changed' as const;
export const BANDWIDTH_LIMIT_CHANGED = 'bandwidth_limit_changed' as const;
export const RCLONE_CONFIG_UNLOCKED = 'rclone_config_unlocked' as const;
export const UPDATE_TRAY_MENU = 'tray_menu_updated' as const;
export const JOB_CACHE_CHANGED = 'job_cache_changed' as const;
export const MOUNT_STATE_CHANGED = 'mount_state_changed' as const;
export const SERVE_STATE_CHANGED = 'serve_state_changed' as const;
export const SYSTEM_STATUS = 'system_status' as const;
export const MOUNT_PLUGIN_INSTALLED = 'mount_plugin_installed' as const;
export const NETWORK_STATUS_CHANGED = 'network_status_changed' as const;
export const AUTOMATIONS_CACHE_CHANGED = 'automations_cache_changed' as const;
export const APP_EVENT = 'app_event' as const;
export const BROWSE = 'browse' as const;

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
  status: JobStatus;
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
  | { status: 'authError'; payload: { message: string } }
  | { status: 'pathError' }
  | { status: 'versionError'; payload: { version: string; required: string } }
  | { status: 'updating' }
  | { status: 'restarted'; payload: { reason: string } };

export type EngineErrorType = 'password' | 'path' | 'version' | 'auth' | 'generic' | null;
