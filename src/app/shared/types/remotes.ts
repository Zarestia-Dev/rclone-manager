// ============================================================================
// OPERATIONS & ACTIONS
// ============================================================================
export type JobType = 'sync' | 'copy' | 'move' | 'bisync' | 'check';
export type RemoteAction =
  | 'mount'
  | 'unmount'
  | 'sync'
  | 'copy'
  | 'move'
  | 'bisync'
  | 'stop'
  | 'open'
  | 'delete'
  | null;
export type SyncOperationType = 'sync' | 'copy' | 'move' | 'bisync';
export type PrimaryActionType = SyncOperationType | 'mount';
export type FlagType = 'mount' | 'bisync' | 'move' | 'copy' | 'sync' | 'filter' | 'vfs' | 'backend';
export type EditTarget = FlagType | 'remote' | null;
export type FieldType =
  | 'bool'
  | 'int'
  | 'Duration'
  | 'string'
  | 'stringArray'
  | 'CommaSeparatedList'
  | 'SizeSuffix'
  | 'int64'
  | 'uint32'
  | 'float'
  | 'password'
  | 'hidden'
  | 'option'
  | 'time'
  | 'date'
  | 'object'
  | 'json'
  | string;

export interface SyncOperation {
  type: SyncOperationType;
  label: string;
  icon: string;
  cssClass: string;
  description: string;
}

export interface QuickActionButton {
  id: string;
  icon: string;
  tooltip: string;
  isLoading?: boolean;
  isDisabled?: boolean;
  cssClass?: string;
}

export type RemoteActionProgress = Record<string, RemoteAction>;

// ============================================================================
// REMOTE CONFIGURATION & SPECS
// ============================================================================
export interface RemoteSpecs {
  name: string;
  type: string;
  [key: string]: any;
}

export interface RemoteType {
  value: string;
  label: string;
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

// ============================================================================
// CONFIG INTERFACES
// ============================================================================
export interface MountConfig {
  autoStart: boolean;
  dest: string;
  source: string;
  type: string;
  options?: any;
  [key: string]: any;
}

export interface CopyConfig {
  autoStart: boolean;
  source: string;
  dest: string;
  createEmptySrcDirs?: boolean;
  options?: any;
  [key: string]: any;
}

export interface SyncConfig {
  autoStart: boolean;
  source: string;
  dest: string;
  createEmptySrcDirs?: boolean;
  options?: any;
  [key: string]: any;
}

export interface MoveConfig {
  autoStart: boolean;
  source: string;
  dest: string;
  createEmptySrcDirs?: boolean;
  deleteEmptySrcDirs?: boolean;
  options?: any;
  [key: string]: any;
}

export interface BisyncConfig {
  autoStart: boolean;
  source: string;
  dest: string;
  dryRun?: boolean;
  resync?: boolean;
  checkAccess?: boolean;
  checkFilename?: string;
  maxDelete?: number;
  force?: boolean;
  checkSync?: boolean | 'only';
  createEmptySrcDirs?: boolean;
  removeEmptyDirs?: boolean;
  filtersFile?: string;
  ignoreListingChecksum?: boolean;
  resilient?: boolean;
  workdir?: string;
  backupdir1?: string;
  backupdir2?: string;
  noCleanup?: boolean;
  options?: any;
  [key: string]: any;
}

export interface FilterConfig {
  options?: any;
  [key: string]: any;
}

export interface VfsConfig {
  options?: any;
  [key: string]: any;
}

export interface BackendConfig {
  options?: any;
  [key: string]: any;
}

export interface RemoteConfigSections {
  [remoteName: string]: any;
  mountConfig: MountConfig;
  copyConfig: CopyConfig;
  syncConfig: SyncConfig;
  moveConfig: MoveConfig;
  bisyncConfig: BisyncConfig;
  filterConfig: FilterConfig;
  vfsConfig: VfsConfig;
  showOnTray: boolean;
}

// ============================================================================
// CONFIGURATION OPTIONS & FIELDS
// ============================================================================
export interface RcConfigExample {
  Value: string;
  Help: string;
}

export interface RcConfigOption {
  Name: string;
  FieldName: string;
  Help: string;
  Provider?: string;
  Groups?: string;
  Default?: any;
  Value?: any;
  Examples?: RcConfigExample[];
  Hide?: number;
  Required?: boolean;
  IsPassword?: boolean;
  NoPrefix?: boolean;
  Advanced?: boolean;
  Exclusive?: boolean;
  Sensitive?: boolean;
  DefaultStr: string;
  ValueStr?: string;
  Type: string;
}

export interface FlagField {
  ValueStr: string;
  Value: any;
  name: string;
  default: any;
  help: string;
  type: string;
  required: boolean;
  examples: any[];
}

export interface RcConfigQuestionResponse {
  State: string;
  Option: RcConfigOption | null;
  Error: string;
  Result?: string;
}

// ============================================================================
// UI STATE & FORMS
// ============================================================================
export interface LoadingState {
  remoteConfig?: boolean;
  mountConfig?: boolean;
  copyConfig?: boolean;
  syncConfig?: boolean;
  saving: boolean;
  authDisabled: boolean;
  cancelled: boolean;
  [key: string]: boolean | undefined;
}

export interface QuickAddForm {
  remoteName: string;
  remoteType: string;
  useInteractiveMode: boolean;
  mountPath: string;
  autoMount: boolean;
  syncDest: string;
  autoSync: boolean;
  copyDest: string;
  autoCopy: boolean;
  bisyncSource: string;
  bisyncDest: string;
  autoBisync: boolean;
  moveSource: string;
  moveDest: string;
  autoMove: boolean;
}

// ============================================================================
// FILESYSTEM & PATHS
// ============================================================================
export interface Entry {
  ID: string;
  IsDir: boolean;
  MimeType: string;
  ModTime: string;
  Name: string;
  Path: string;
  Size: number;
}

// ============================================================================
// CONSTANTS & VALIDATION
// ============================================================================
export const REMOTE_NAME_REGEX = /^[A-Za-z0-9_\-.+@ ]+$/;
