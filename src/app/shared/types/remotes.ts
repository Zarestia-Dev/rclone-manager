import { Origin } from './origin';
import { Starter } from './starter';
import { ALL_PRIMARY_ACTIONS, PrimaryActionType } from './operations';
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
  overview?: RemoteProviderOverview | null;
}

/** General backend capabilities embedded in rclone, rather than a configured remote's fsinfo. */
export interface RemoteProviderOverview {
  Name?: string;
  Backend?: string;
  Tier?: string;
  Features?: string[] | null;
  Hashes?: string[] | null;
  Virtual?: boolean;
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
  starter?: Starter;
  execute_id?: string;
  origin?: Origin;
}

/**
 * Unified response returned when starting any operation (mount, serve, sync, etc.)
 */
export interface OperationExecutionResult {
  executeId: string;
  origin: Origin;
  operationType: PrimaryActionType;
  remoteName: string;
  starter?: Starter;
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

/** The live state of a remote: one entry per operation of the registry, and serve with its list. */
export type RemoteStatus = { diskUsage: DiskUsage } & Record<
  Exclude<PrimaryActionType, 'serve'>,
  RemoteOperationState
> & { serve: RemoteServeState };

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

export function createDefaultRemoteOperationState(): RemoteOperationState {
  return {
    active: false,
  };
}

export function createDefaultRemoteStatus(): RemoteStatus {
  return {
    diskUsage: {},
    ...(Object.fromEntries(
      ALL_PRIMARY_ACTIONS.map(op => [op, createDefaultRemoteOperationState()])
    ) as Record<Exclude<PrimaryActionType, 'serve'>, RemoteOperationState>),
    serve: { active: false, count: 0, serves: [] },
  };
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
