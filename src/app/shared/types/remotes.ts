import type { PrimaryActionType, SyncOperationType } from './operations';

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

export interface Remote {
  name?: string;
  showOnTray?: boolean;
  type?: string;
  remoteSpecs: RemoteSpecs;
  mountState?: {
    diskUsage?: DiskUsage;
    mounted?: boolean;
  };
  syncState?: {
    isOnSync?: boolean;
    syncJobID?: number;
    isLocal?: boolean;
  };
  copyState?: {
    isOnCopy?: boolean;
    copyJobID?: number;
    isLocal?: boolean;
  };
  bisyncState?: {
    isOnBisync?: boolean;
    bisyncJobID?: number;
    isLocal?: boolean;
  };
  moveState?: {
    isOnMove?: boolean;
    moveJobID?: number;
    isLocal?: boolean;
  };
  primaryActions?: PrimaryActionType[];
  selectedSyncOperation?: SyncOperationType;
}

export type RemoteSettings = Record<string, any>;

export interface RemoteSettingsSection {
  key: string;
  title: string;
  icon: string;
}

export interface MountedRemote {
  fs: string;
  mount_point: string;
}

// === Remote Providers & Non-interactive Config ===
export interface RemoteProvider {
  name: string;
  description: string;
}

// Use unknown for values to avoid any; many consumers pass through to backend without inspecting values
export type RemoteConfig = Record<string, unknown>;

export interface RcConfigExample {
  Value: string;
  Help: string;
}

export interface RcConfigOption {
  Name: string;
  FieldName?: string;
  Help: string;
  Default?: unknown;
  Value?: unknown;
  Examples?: RcConfigExample[];
  Hide?: number;
  Required?: boolean;
  IsPassword?: boolean;
  NoPrefix?: boolean;
  Advanced?: boolean;
  Exclusive?: boolean;
  Sensitive?: boolean;
  DefaultStr?: string;
  ValueStr?: string;
  Type: string;
}

export interface RcConfigQuestionResponse {
  State: string;
  Option: RcConfigOption | null;
  Error: string;
  Result?: string;
}
