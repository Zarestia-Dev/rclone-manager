export interface RcloneInfo {
  version: string;
  decomposed: number[];
  goVersion: string;
  os: string;
  arch: string;
  osVersion?: string | null;
  osKernel?: string | null;
  osArch?: string | null;
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
  language?: string;
  data?: any;
}

export type AppEventPayloadType = AppEventPayload;

export enum BackendUpdateStatus {
  Idle = 'idle',
  Downloading = 'downloading',
  ReadyToRestart = 'readyToRestart',
  Available = 'available',
}

// === Update Info ===
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  updateAvailable: boolean;
  status: BackendUpdateStatus;
  releaseTag?: string;
  releaseNotes?: string;
  releaseDate?: string;
  releaseUrl?: string;
  channel?: string;
}

export interface DownloadStatus {
  downloadedBytes: number;
  totalBytes: number;
  percentage: number;
  isComplete: boolean;
  isFailed: boolean;
  failureMessage: string | null;
}

export interface UpdateStatus {
  checking: boolean;
  downloading: boolean;
  available: boolean;
  readyToRestart: boolean;
  error: string | null;
  lastCheck: Date | null;
  updateInfo: UpdateInfo | null;
}

export interface UpdateResult {
  success: boolean;
  message?: string;
  output?: string;
  channel?: string;
  manual?: boolean;
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

export interface RcloneFlagMetadata {
  display_name?: string;
  label?: string;
  help_text?: string;
  description?: string;
  required?: boolean;
  engine_restart?: boolean;
  placeholder?: string;
}

export interface SettingMetadata {
  value_type?: 'bool' | 'int' | 'string' | 'select' | 'bandwidth' | 'file' | 'folder' | 'string[]';
  default: any;
  value?: any;
  min?: number;
  max?: number;
  step?: number;
  options?: any[];
  metadata?: RcloneFlagMetadata;
  reserved?: string[];
}

export interface SearchResult {
  category: string;
  key: string;
}

export enum RepairSheetType {
  MOUNT_PLUGIN = 'mount_plugin',
  RCLONE_PASSWORD = 'rclone_password',
  RCLONE_BINARY = 'rclone_binary',
}

export interface LocalDiskUsage {
  free: number;
  total: number;
  used: number;
  dir?: string;
}
