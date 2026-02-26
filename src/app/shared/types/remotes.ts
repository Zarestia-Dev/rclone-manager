import { PrimaryActionType, SyncOperationType } from './operations';
import { ServeListItem } from './serve';
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

export interface Remote {
  name?: string;
  showOnTray?: boolean;
  type?: string;
  remoteSpecs: RemoteSpecs;
  diskUsage: DiskUsage;
  mountState?: {
    mounted?: boolean;
    activeProfiles?: Record<string, string>;
  };
  syncState?: {
    isOnSync?: boolean;
    syncJobID?: number;
    isLocal?: boolean;
    activeProfiles?: Record<string, number>;
  };
  copyState?: {
    isOnCopy?: boolean;
    copyJobID?: number;
    isLocal?: boolean;
    activeProfiles?: Record<string, number>;
  };
  bisyncState?: {
    isOnBisync?: boolean;
    bisyncJobID?: number;
    isLocal?: boolean;
    activeProfiles?: Record<string, number>;
  };
  moveState?: {
    isOnMove?: boolean;
    moveJobID?: number;
    isLocal?: boolean;
    activeProfiles?: Record<string, number>;
  };
  serveState?: {
    isOnServe?: boolean;
    serveCount?: number;
    serves?: ServeListItem[];
    activeProfiles?: Record<string, string>;
  };
  primaryActions?: PrimaryActionType[];
  selectedSyncOperation?: SyncOperationType;
}
