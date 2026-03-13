import { PrimaryActionType } from './operations';
import { ServeListItem } from './serve';
// ============================================================================
// REMOTE CONFIGURATION & SPECS
// ============================================================================
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
}

// ============================================================================
// REMOTE STATE & OPERATIONS
// ============================================================================
export interface DiskUsage {
  total_space?: number;
  used_space?: number;
  free_space?: number;
  loading?: boolean;
  error?: boolean;
  errorMessage?: string;
  notSupported?: boolean;
}

export interface RemoteOperationState {
  active: boolean;
  jobId?: number;
  activeProfiles?: Record<string, number | string>;
}

export interface RemoteServeState {
  active: boolean;
  count: number;
  serves: ServeListItem[];
  activeProfiles?: Record<string, string>;
}

export interface RemoteStatus {
  diskUsage: DiskUsage;
  mount: RemoteOperationState;
  sync: RemoteOperationState;
  copy: RemoteOperationState;
  bisync: RemoteOperationState;
  move: RemoteOperationState;
  serve: RemoteServeState;
}

export interface RemoteFeatures {
  isLocal: boolean;
  hasAbout: boolean;
  hasBucket: boolean;
  hasCleanUp: boolean;
  hasPublicLink: boolean;
  changeNotify: boolean;
  hashes: string[];
}

export interface Remote {
  name: string;
  type: string;
  config: RemoteConfig;
  status: RemoteStatus;
  features: RemoteFeatures;
  primaryActions: PrimaryActionType[];
}
