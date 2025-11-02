import { PrimaryActionType, SyncOperationType } from './operations';
// ============================================================================
// REMOTE CONFIGURATION & SPECS
// ============================================================================
export interface RemoteSpecs {
  name: string;
  type: string;
  [key: string]: any;
}

export interface RemoteProvider {
  name: string;
  description: string;
}

export type RemoteConfig = Record<string, unknown>;
export type RemoteSettings = Record<string, any>;

export interface RemoteSettingsSection {
  key: string;
  title: string;
  icon: string;
  group?: 'operation' | 'shared';
}

export interface MountedRemote {
  fs: string;
  mount_point: string;
}

// ============================================================================
// REMOTE STATE & OPERATIONS
// ============================================================================
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
  diskUsage?: DiskUsage;
  mountState?: {
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
