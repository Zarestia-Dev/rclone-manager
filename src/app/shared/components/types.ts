import { SettingsService } from "../../services/settings.service";

export type AppTab = "mount" | "sync" | "copy" | "jobs";
export type JobType = "sync" | "copy" | "move" | "check";
export type JobStatus = "running" | "finished" | "failed";
export type RemoteAction =
  | "mount"
  | "unmount"
  | "sync"
  | "copy"
  | "stop"
  | "open"
  | null;

export interface RemoteSpecs {
  name: string;
  type: string;
  [key: string]: any;
}

export interface DiskUsage {
  total_space?: string;
  used_space?: string;
  free_space?: string;
  loading?: boolean;
  error?: boolean;
  notSupported?: boolean;
}

export interface TransferFile {
  bytes: number;
  dstFs: string;
  eta: number;
  group: string;
  name: string;
  percentage: number;
  size: number;
  speed: number;
  speedAvg: number;
  srcFs: string;
  isError?: boolean;
}

export interface SyncStats {
  bytes: number;
  checks: number;
  deletedDirs: number;
  deletes: number;
  elapsedTime: number;
  errors: number;
  eta: number;
  fatalError: boolean;
  lastError: string;
  renames: number;
  retryError: boolean;
  serverSideCopies: number;
  serverSideCopyBytes: number;
  serverSideMoveBytes: number;
  serverSideMoves: number;
  speed: number;
  totalBytes: number;
  totalChecks: number;
  totalTransfers: number;
  transferTime: number;
  transferring: TransferFile[];
  transfers: number;
  startTime?: string;
}

export interface Job {
  jobid: number;
  job_type: JobType;
  source: string;
  destination: string;
  start_time: string;
  status: JobStatus;
  remote_name: string;
  stats: SyncStats;
}

export interface Remote {
  custom_flags?: { [key: string]: any };
  mount_options?: { [key: string]: any };
  name?: string;
  showOnTray?: boolean;
  type?: string;
  remoteSpecs: RemoteSpecs;
  mountState?: {
    mounted?: boolean | "error";
    diskUsage?: DiskUsage;
  };
  syncState?: {
    isOnSync?: boolean | "error";
    syncJobID?: number;
  };
  copyState?: {
    isOnCopy?: boolean | "error";
    copyJobID?: number;
  };
}

export interface RemoteSettings {
  [key: string]: { [key: string]: any };
}

export interface RemoteSettingsSection {
  key: string;
  title: string;
  icon: string;
}

export interface MountedRemote {
  fs: string;
  mount_point: string;
}

export interface RemoteActionProgress {
  [remoteName: string]: RemoteAction;
}

export interface ModalSize {
  width: string;
  maxWidth: string;
  minWidth: string;
  height: string;
  maxHeight: string;
}

export const STANDARD_MODAL_SIZE: ModalSize = {
  width: "90vw",
  maxWidth: "642px",
  minWidth: "360px",
  height: "80vh",
  maxHeight: "600px",
};

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
}

export interface CheckResult {
  successful: string[];
  failed: Record<string, string>;
  retries_used: Record<string, number>;
}

export interface ConfirmDialogData {
  title: string;
  message: string;
  confirmText?: string; // Optional: Defaults to "Yes"
  cancelText?: string; // Optional: Defaults to "No"
}

export interface ExportModalData {
  remoteName?: string; // Optional remote name to pre-select
  defaultExportType?: string; // Optional default export type
}

export interface LogContext {
  job_id?: number;
  response?: string;
  [key: string]: any;
}

export interface RemoteLogEntry {
  timestamp: string;
  remote_name?: string;
  level: string;
  message: string;
  context?: LogContext | null;
}

export interface RepairData {
  type:
    | "rclone_path"
    | "mount_plugin"
    | "config_corrupt"
    | "backend_unreachable";
  title?: string;
  message?: string;
}

export const SENSITIVE_KEYS = [
  "password",
  "secret",
  "endpoint",
  "token",
  "key",
  "credentials",
  "auth",
  "client_secret",
  "client_id",
  "api_key",
];