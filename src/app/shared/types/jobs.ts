import { JobActionType } from './operations';
import { OPERATION_REGISTRY } from './operation-registry';
import { Origin } from './origin';
import type { CompletedTransfer } from './components';

export type JobStatus = 'Running' | 'Completed' | 'Failed' | 'Stopped';

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
  isCompleted?: boolean;
  error?: string;
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
  transfers: number;
  listed: number;
  completed?: CompletedTransfer[];
  startTime?: string;
  checkOutput?: {
    differ?: string[];
    missingOnDst?: string[];
    missingOnSrc?: string[];
    error?: string[];
    status?: string;
    success?: boolean;
    hashType?: string;
  };
}

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
  copyurl: 'link',
  rename: 'pen',
  cleanup: 'broom',
  rmdirs: 'broom',
  upload: 'file-arrow-up',
});
