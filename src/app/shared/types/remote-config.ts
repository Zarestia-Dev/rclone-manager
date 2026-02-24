export type FlagType =
  | 'mount'
  | 'bisync'
  | 'move'
  | 'copy'
  | 'sync'
  | 'filter'
  | 'vfs'
  | 'backend'
  | 'serve';
export const FLAG_TYPES: FlagType[] = [
  'mount',
  'serve',
  'sync',
  'bisync',
  'move',
  'copy',
  'filter',
  'vfs',
  'backend',
];
export const DEFAULT_PROFILE_NAME = 'default';

export type EditTarget = FlagType | 'remote' | null;

export const INTERACTIVE_REMOTES = ['iclouddrive', 'onedrive'];

export interface LoadingState {
  saving: boolean;
  authDisabled: boolean;
  cancelled: boolean;
  [key: string]: boolean | undefined;
}

export interface RemoteType {
  value: string;
  label: string;
}

// Base interface for operation configs (shared by copy, sync, move)
interface BaseOperationConfig {
  autoStart: boolean;
  cronEnabled?: boolean;
  source: string;
  dest: string;
  cronExpression?: string | null;
  options?: any;
  name?: string;
  filterProfile?: string;
  backendProfile?: string;
  [key: string]: any;
}

export interface MountConfig {
  autoStart: boolean;
  dest: string;
  source: string;
  type: string;
  options?: any;
  vfsProfile?: string;
  filterProfile?: string;
  backendProfile?: string;
  [key: string]: any;
}

export interface CopyConfig extends BaseOperationConfig {
  createEmptySrcDirs?: boolean;
}

export interface SyncConfig extends BaseOperationConfig {
  createEmptySrcDirs?: boolean;
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

export interface MoveConfig extends BaseOperationConfig {
  createEmptySrcDirs?: boolean;
  deleteEmptySrcDirs?: boolean;
}

export interface BisyncConfig {
  autoStart: boolean;
  cronEnabled?: boolean;
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
  cronExpression?: string | null;
  options?: any;
  name?: string;
  filterProfile?: string;
  backendProfile?: string;
  [key: string]: any;
}

export interface ServeConfig {
  autoStart: boolean;
  type: string;
  source: string; // or object, but usually string in the config object
  options?: any;

  name?: string;
  vfsProfile?: string;
  filterProfile?: string;
  backendProfile?: string;
  [key: string]: any;
}

// A single remote's settings broken into sections used by the UI
export interface RemoteConfigSections {
  [remoteName: string]: any; // keep permissive for now; UI accesses dynamic keys

  // Multiple configs per type (profiles) - keyed by profile name
  mountConfigs?: Record<string, MountConfig>;
  copyConfigs?: Record<string, CopyConfig>;
  syncConfigs?: Record<string, SyncConfig>;
  moveConfigs?: Record<string, MoveConfig>;
  bisyncConfigs?: Record<string, BisyncConfig>;
  serveConfigs?: Record<string, ServeConfig>;

  // Multiple configs for shared types - keyed by profile name
  filterConfigs?: Record<string, FilterConfig>;
  backendConfigs?: Record<string, BackendConfig>;
  vfsConfigs?: Record<string, VfsConfig>;

  showOnTray: boolean;
}

export const REMOTE_NAME_REGEX = /^[A-Za-z0-9_\-.+@ ]+$/;

export interface RcConfigExample {
  Value: string;
  Help: string;
  Provider?: string;
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

export interface RcConfigQuestionResponse {
  State: string;
  Option: RcConfigOption | null;
  Error: string;
  Result?: string;
}

export interface InteractiveFlowState {
  isActive: boolean;
  question: RcConfigQuestionResponse | null;
  answer: string | boolean | number | null;
  isProcessing: boolean;
}

export interface Entry {
  IsBucket?: boolean;
  ID: string;
  IsDir: boolean;
  MimeType: string;
  ModTime: string;
  Name: string;
  Path: string;
  Size: number;
}

export interface LocalDrive {
  name: string; // "C:" or "/" or "/home/user"
  label: string; // "Local Disk" or "File System"
  show_name: boolean;
}

export interface ExplorerRoot {
  name: string;
  label: string;
  type: string; // Icon name
  isLocal: boolean;
  showName?: boolean;
}
