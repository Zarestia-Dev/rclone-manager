export interface RcloneInfo {
  version: string;
  decomposed: number[];
  goVersion: string;
  os: string;
  arch: string;
  isBeta: boolean;
  isGit: boolean;
  linking: string;
  goTags: string;
  pid: number | null;
}

export interface CheckResult {
  successful: string[];
  failed: Record<string, string>;
  retries_used: Record<string, number>;
}

export interface BandwidthLimitResponse {
  bytesPerSecond: number;
  bytesPerSecondRx: number;
  bytesPerSecondTx: number;
  rate: string;
  loading: boolean;
  error?: string;
}

export interface MemoryStats {
  Alloc: number;
  BuckHashSys: number;
  Frees: number;
  GCSys: number;
  HeapAlloc: number;
  HeapIdle: number;
  HeapInuse: number;
  HeapObjects: number;
  HeapReleased: number;
  HeapSys: number;
  MCacheInuse: number;
  MCacheSys: number;
  MSpanInuse: number;
  MSpanSys: number;
  Mallocs: number;
  OtherSys: number;
  StackInuse: number;
  StackSys: number;
  Sys: number;
  TotalAlloc: number;
}

export interface PanelState {
  bandwidth: boolean;
  system: boolean;
  jobs: boolean;
}

export interface SystemStats {
  memoryUsage: string;
  uptime: string;
}

export type RcloneStatus = 'active' | 'inactive' | 'error';

export const SENSITIVE_KEYS = [
  'password',
  'secret',
  'endpoint',
  'token',
  'key',
  'credentials',
  'auth',
  'client_secret',
  'client_id',
  'api_key',
  'drive_id',
];

// === Engine & App Events ===
export interface RcloneEngineEvent {
  status: string;
  port?: number;
  timestamp?: string;
  message?: string;
  error_type?: string;
}

export interface UpdateResult {
  success: boolean;
  message?: string;
}

export type RcloneEnginePayload = RcloneEngineEvent | string;

// === Update Info ===
export interface RcloneUpdateInfo {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  current_version_clean: string;
  latest_version_clean: string;
  release_notes?: string;
  release_date?: string;
  download_url?: string;
}

export interface UpdateStatus {
  checking: boolean;
  updating: boolean;
  available: boolean;
  error: string | null;
  lastCheck: Date | null;
  updateInfo: RcloneUpdateInfo | null;
}

// === Security / Passwords ===
export interface PasswordLockoutStatus {
  is_locked: boolean;
  failed_attempts: number;
  max_attempts: number;
  remaining_lockout_time?: number;
}

export interface LoadingStates {
  isValidating: boolean;
  isEncrypting: boolean;
  isUnencrypting: boolean;
  isChangingPassword: boolean;
  isStoringPassword: boolean;
  isRemovingPassword: boolean;
  isSettingEnv: boolean;
  isClearingEnv: boolean;
  isResettingLockout: boolean;
}

export interface PasswordManagerState {
  hasStoredPassword: boolean;
  hasEnvPassword: boolean;
  isConfigEncrypted: boolean;
  lockoutStatus: PasswordLockoutStatus | null;
  loading: LoadingStates;
  errors: string[];
}

export interface SettingTab {
  label: string;
  icon: string;
  key: string;
}

export interface SettingMetadata {
  display_name: string;
  help_text: string;
  value_type: 'bool' | 'number' | 'string' | 'array' | 'path';
  required?: boolean;
  validation_type?: string; // 'regex' | 'frontend:<validatorName>' | other types
  validation_pattern?: string;
  validation_message?: string;
  min_value?: number;
  max_value?: number;
  step?: number;
  options?: string[];
  placeholder?: string;
  requires_restart?: boolean;
}

export interface SearchResult {
  category: string;
  key: string;
}

export interface PasswordTab {
  label: string;
  icon: string;
  key: 'overview' | 'security' | 'advanced';
}

export enum RepairSheetType {
  MOUNT_PLUGIN = 'mount_plugin',
  RCLONE_PASSWORD = 'rclone_password',
  RCLONE_PATH = 'rclone_path',
}
