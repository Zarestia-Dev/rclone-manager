import { Origin } from './origin';
import { PrimaryActionType } from './operations';
import { ServeListItem } from './serve';

// ── Remote configuration ────────────────────────────────────────────────────

export interface RemoteConfig {
  name: string;
  type: string;
  [key: string]: unknown;
}

export interface RemoteProvider {
  name: string;
  description: string;
}

export type ConfigRecord = Record<string, unknown>;
export type RemoteSettings = Record<string, unknown>;

export interface RemoteSettingsSection {
  key: string;
  title: string;
  icon: string;
  group?: 'operation' | 'shared';
}

export interface MountedRemote {
  fs: string;
  mount_point: string;
  profile?: string;
  quick_run_id?: string;
  execute_id?: string;
  origin?: Origin;
  workflow_id?: string;
  node_id?: string;
}

/**
 * Unified response returned when starting any operation (mount, serve, sync, etc.)
 */
export interface OperationExecutionResult {
  executeId: string;
  origin: Origin;
  operationType: PrimaryActionType;
  remoteName: string;
  quickRunId?: string;
  profile?: string;
  success: boolean;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  error?: string;
  startTime: string;
  jobId?: number;
  serveId?: string;
  serveAddr?: string;
  mountPoint?: string;
}

// ── Remote runtime state ────────────────────────────────────────────────────

export type DiskUsageSeverity = 'healthy' | 'warning' | 'high' | 'critical';

export interface DiskUsage {
  total?: number;
  used?: number;
  free?: number;
  loading?: boolean;
  error?: boolean;
  errorMessage?: string;
  notSupported?: boolean;
}

export interface RemoteOperationState {
  active: boolean;
  jobId?: number;
  activeProfiles?: Record<string, number | string>;
  lastRunProfiles?: Record<string, number | string>;
  configuredProfiles?: string[];
  profileBrowsePaths?: Record<string, string[]>;
}

export interface RemoteServeState {
  active: boolean;
  count: number;
  serves: ServeListItem[];
  activeProfiles?: Record<string, string>;
  lastRunProfiles?: Record<string, string>;
  configuredProfiles?: string[];
  profileBrowsePaths?: Record<string, string[]>;
}

export interface RemoteStatus {
  diskUsage: DiskUsage;
  mount: RemoteOperationState;
  sync: RemoteOperationState;
  copy: RemoteOperationState;
  bisync: RemoteOperationState;
  move: RemoteOperationState;
  check: RemoteOperationState;
  delete: RemoteOperationState;
  copyurl: RemoteOperationState;
  archivecreate: RemoteOperationState;
  cryptcheck: RemoteOperationState;
  serve: RemoteServeState;
}

export interface RemoteFeatures {
  IsLocal: boolean;
  About: boolean;
  BucketBased: boolean;
  CleanUp: boolean;
  PublicLink: boolean;
  ChangeNotify: boolean;
  Purge?: boolean;
  Copy?: boolean;
  Move?: boolean;
  DirMove?: boolean;
  UserMetadata?: boolean;
  CanHaveEmptyDirectories?: boolean;
  Hashes: string[];
  Error?: string;
  loading?: boolean;
  [feature: string]: unknown;
}

export function createDefaultRemoteFeatures(isLocal = false, loading = false): RemoteFeatures {
  return {
    IsLocal: isLocal,
    About: false,
    BucketBased: false,
    CleanUp: false,
    PublicLink: false,
    ChangeNotify: false,
    Hashes: [],
    loading,
  };
}

export interface Remote {
  name: string;
  type: string;
  config: RemoteConfig;
  status: RemoteStatus;
  features: RemoteFeatures;
  primaryActions: PrimaryActionType[];
  syncActions: PrimaryActionType[];
}

// ── Remote layout ───────────────────────────────────────────────────────────

export interface RemotesLayout {
  order: string[];
  hidden: string[];
}

/** Keyed by backend name */
export type BackendsRemotesLayout = Record<string, RemotesLayout>;

export type ProfileConfigMap = Record<string, Record<string, unknown>>;
