export interface RcloneInfo {
  version: string;
  decomposed: number[];
  goVersion: string;
  os: string;
  arch: string;
  osVersion: string;
  osKernel: string;
  osArch: string;
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
  memoryUsage: MemoryStats | null;
  uptime: number;
}

export type RcloneStatus = 'active' | 'inactive' | 'error';

export const SENSITIVE_KEYS = [
  'password',
  'pass',
  'session_id',
  '2fa',
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
// Note: Engine events now use dedicated event constants with no payload
// The event name itself indicates the state (ready, error, etc.)

// App events have payloads with status and message
export interface AppEventPayload {
  status: string;
  message?: string;
}

export type AppEventPayloadType = AppEventPayload | string;

// === Update Info ===
export interface RcloneUpdateInfo {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  current_version_clean: string;
  latest_version_clean: string;
  channel: string;
  release_notes?: string; // Add release notes support
  release_date?: string;
  release_url?: string;
}

export interface UpdateStatus {
  checking: boolean;
  updating: boolean;
  available: boolean;
  error: string | null;
  lastCheck: Date | null;
  updateInfo: RcloneUpdateInfo | null;
}

export interface UpdateResult {
  success: boolean;
  message?: string;
  output?: string;
  channel?: string;
}

// === Security / Passwords ===

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
  value_type: 'bool' | 'int' | 'string' | 'bandwidth' | 'file' | 'folder' | 'string[]';
  help_text: string;
  default: any;
  value?: any;
  min_value?: number;
  max_value?: number;
  step?: number;
  placeholder?: string;
  options?: string[];
  required?: boolean;
  engine_restart?: boolean;
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
