export type PrimitiveValue = string | number | boolean | null;
export type ConfigValue = PrimitiveValue | PrimitiveValue[] | { [key: string]: ConfigValue };

// ── Rclone System Info ──────────────────────────────────────────────────────
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
] as const;

export interface AppEventPayload {
  status: string;
  message?: string;
  language?: string;
  data?: unknown; // Replaced any
}

export type AppEventPayloadType = AppEventPayload;

export enum BackendUpdateStatus {
  Idle = 'idle',
  Checking = 'checking',
  Downloading = 'downloading',
  ReadyToRestart = 'readyToRestart',
  Available = 'available',
}

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

export enum DownloadStateStatus {
  InProgress = 'inProgress',
  Complete = 'complete',
  Failed = 'failed',
}

export interface DownloadState {
  status: DownloadStateStatus;
  data?: string;
}

export interface DownloadStatus {
  downloadedBytes: number;
  totalBytes: number;
  percentage: number;
  state: DownloadState;
}

export interface UpdateResult {
  success: boolean;
  message?: string;
  output?: string;
  channel?: string;
  manual?: boolean;
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

export interface SettingMetadata<T = ConfigValue> {
  value_type?: 'bool' | 'int' | 'string' | 'select' | 'bandwidth' | 'file' | 'folder' | 'string[]';
  default: T;
  value?: T;
  min?: number;
  max?: number;
  step?: number;
  options?: ConfigValue[];
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
  RCLONE_VERSION = 'rclone_version',
  RCLONE_AUTH = 'rclone_auth',
}

export type LocalDiskUsageColor = 'primary' | 'accent' | 'warn';

export interface LocalDiskUsage {
  free: number;
  total: number;
  used: number;
  dir?: string;
  usagePercentage: number;
  usageColor: LocalDiskUsageColor;
}

export interface PendingChange {
  category: string;
  key: string;
  value: ConfigValue; // Replaced unknown
  metadata: SettingMetadata;
}

export interface PendingChangeDisplay {
  displayName: string;
  category: string;
  key: string;
  value: unknown;
}

export type ViewId =
  | 'details'
  | 'about-app'
  | 'about-rclone'
  | 'credits'
  | 'legal'
  | 'whats-new-app'
  | 'whats-new-rclone'
  | 'memory'
  | 'debugging'
  | 'donate';

export interface OverlayView {
  id: ViewId;
}
