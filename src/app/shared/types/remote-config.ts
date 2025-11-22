export type FlagType = 'mount' | 'bisync' | 'move' | 'copy' | 'sync' | 'filter' | 'vfs' | 'backend';
export const FLAG_TYPES: FlagType[] = [
  'mount',
  'copy',
  'sync',
  'bisync',
  'move',
  'filter',
  'vfs',
  'backend',
];
export type EditTarget = FlagType | 'remote' | 'serve' | null;
export const INTERACTIVE_REMOTES = ['iclouddrive', 'onedrive'];

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

export interface RemoteType {
  value: string;
  label: string;
}

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
  cronEnabled?: boolean;
  source: string;
  dest: string;
  createEmptySrcDirs?: boolean;
  cronExpression?: string | null;
  options?: any;
  [key: string]: any;
}

export interface SyncConfig {
  autoStart: boolean;
  cronEnabled?: boolean;
  source: string;
  dest: string;
  createEmptySrcDirs?: boolean;
  cronExpression?: string | null;
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

export interface MoveConfig {
  autoStart: boolean;
  cronEnabled?: boolean;
  source: string;
  dest: string;
  createEmptySrcDirs?: boolean;
  deleteEmptySrcDirs?: boolean;
  cronExpression?: string | null;
  options?: any;
  [key: string]: any;
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
  [key: string]: any;
}

// A single remote's settings broken into sections used by the UI
export interface RemoteConfigSections {
  [remoteName: string]: any; // keep permissive for now; UI accesses dynamic keys
  mountConfig: MountConfig;
  copyConfig: CopyConfig;
  syncConfig: SyncConfig;
  moveConfig: MoveConfig;
  bisyncConfig: BisyncConfig;
  filterConfig: FilterConfig;
  backendConfig: BackendConfig;
  vfsConfig: VfsConfig;
  showOnTray: boolean;
}

export const REMOTE_NAME_REGEX = /^[A-Za-z0-9_\-.+@ ]+$/;

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
  ID: string;
  IsDir: boolean;
  MimeType: string;
  ModTime: string;
  Name: string;
  Path: string;
  Size: number;
}

export interface LocalDrive {
  name: string;
  label: string;
}
