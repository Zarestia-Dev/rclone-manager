import { JobActionType } from './operations';
import { OPERATION_REGISTRY } from './operation-registry';
import { Origin } from './origin';

export const JOB_STATUS = Object.freeze({
  Running: 'Running',
  Completed: 'Completed',
  Failed: 'Failed',
  Stopped: 'Stopped',
} as const);
export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

export const TRANSFER_STATUS = Object.freeze({
  Completed: 'completed',
  Checked: 'checked',
  Failed: 'failed',
  Partial: 'partial',
  MissingDestination: 'missing_dst',
  MissingSource: 'missing_src',
} as const);
export type TransferStatus = (typeof TRANSFER_STATUS)[keyof typeof TRANSFER_STATUS];

/** Values emitted by rclone's TransferSnapshot.what; unknown future values use the UI fallback. */
export const RCLONE_ACTIVITY = Object.freeze({
  Transferring: 'transferring',
  Checking: 'checking',
  Deleting: 'deleting',
  Moving: 'moving',
  Renaming: 'renaming',
  Hashing: 'hashing',
  Listing: 'listing',
  Importing: 'importing',
  Merging: 'merging',
} as const);
export type RcloneActivity = (typeof RCLONE_ACTIVITY)[keyof typeof RCLONE_ACTIVITY];

export interface ResolveState {
  status: JobStatus;
  percentage: number;
  isPreparing: boolean;
  bytes: number;
  size: number;
  speed: number;
  eta: number;
  error?: string;
}

export interface CompletedTransfer {
  name: string;
  size: number;
  bytes: number;
  checked: boolean;
  /** Rclone's per-entry activity (e.g. transferring, checking, deleting, moving). */
  what?: RcloneActivity;
  error: string;
  jobid: number;
  startedAt?: string;
  completedAt?: string;
  srcFs?: string;
  dstFs?: string;
  group?: string;
  status: TransferStatus;
  resolveJobId?: number;
  resolveState?: ResolveState;
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
}

export interface GlobalStats {
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
  /** Active non-transfer work; rclone exposes names without byte progress. */
  checking?: string[];
  transfers: number;
  listed: number;
  completed?: CompletedTransfer[];
  startTime?: string;
  checkOutput?: CheckOutput;
}

export interface RcloneCheckResult {
  match?: string[];
  combined?: string[];
  differ?: string[];
  missingOnDst?: string[];
  missingOnSrc?: string[];
  error?: string[];
  status?: string;
  success?: boolean;
  hashType?: string;
}

/** Standard checks return an object; batch and cryptcheck results may wrap several reports. */
export type CheckOutput =
  RcloneCheckResult | RcloneCheckResult[] | { results: RcloneCheckResult[] };

// Frozen to prevent accidental mutation of the default state
export const DEFAULT_JOB_STATS: Readonly<GlobalStats> = Object.freeze({
  bytes: 0,
  totalBytes: 0,
  speed: 0,
  eta: 0,
  totalTransfers: 0,
  transfers: 0,
  errors: 0,
  checks: 0,
  totalChecks: 0,
  deletedDirs: 0,
  deletes: 0,
  renames: 0,
  serverSideCopies: 0,
  serverSideMoves: 0,
  elapsedTime: 0,
  lastError: '',
  fatalError: false,
  retryError: false,
  serverSideCopyBytes: 0,
  serverSideMoveBytes: 0,
  transferTime: 0,
  transferring: [],
  listed: 0,
  completed: [],
});

export interface JobInfo {
  jobid: number;
  /** Monotonic within execute_id; absent on older servers. */
  stats_revision?: number;
  execute_id: string;
  job_type: JobActionType;
  source: string | string[];
  destination: string;
  start_time: string;
  end_time?: string;
  status: JobStatus;
  error?: string;
  remote_name: string;
  stats: GlobalStats;
  group?: string;
  profile?: string;
  quick_run_id?: string;
  workflow_id?: string;
  node_id?: string;
  /** Source UI that started this job (e.g., "nautilus", "dashboard", "scheduled") */
  origin?: Origin;
  /** The backend instance this job belongs to (e.g., "Local", "NAS") */
  backend_name?: string;
  /** True when the job was started with the --dry-run flag (no actual file changes). */
  dry_run?: boolean;
  parent_job_id?: number;
}

export interface BatchMasterJob {
  batch_id: string;
  job_type: JobActionType;
  total_jobs: number;
  completed_jobs: number;
  failed_jobs: number;
  start_time: string;
  end_time?: string;
  status: JobStatus;
  origin?: Origin;
  group?: string;
}

export const JOB_STATUS_BADGE_MAP: Readonly<Record<string, string>> = Object.freeze({
  completed: 'p-primary',
  failed: 'p-warn',
  stopped: 'p-orange',
});

export const JOB_ICON_MAP: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(OPERATION_REGISTRY.map(op => [op.key, op.icon])),
  rename: 'pen',
  cleanup: 'broom',
  rmdirs: 'broom',
  upload: 'file-arrow-up',
});
