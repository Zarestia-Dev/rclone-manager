import { PrimaryActionType } from './remotes';

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
  startTime?: string;
}

export const DEFAULT_JOB_STATS: GlobalStats = {
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
};

export interface JobInfo {
  jobid: number;
  job_type: PrimaryActionType;
  source: string;
  destination: string;
  start_time: string;
  status: JobStatus;
  remote_name: string;
  stats: GlobalStats;
  group?: string;
}
