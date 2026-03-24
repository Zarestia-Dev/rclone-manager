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

export type EditTarget = FlagType | 'remote' | 'runtimeRemote' | null;

export const INTERACTIVE_REMOTES: ReadonlySet<string> = new Set(['onedrive', 'iclouddrive']);

// ─── Command Option types ───────────────────────────────────────────────────

export interface CommandOption {
  key: string;
  value: boolean | string | number | string[];
  label?: string;
  description?: string;
}

export const PREDEFINED_OPTIONS: CommandOption[] = [
  {
    key: 'obscure',
    label: 'wizards.remoteConfig.predefinedOptions.obscure.label',
    description: 'wizards.remoteConfig.predefinedOptions.obscure.description',
    value: true,
  },
  {
    key: 'noObscure',
    label: 'wizards.remoteConfig.predefinedOptions.noObscure.label',
    description: 'wizards.remoteConfig.predefinedOptions.noObscure.description',
    value: true,
  },
  {
    key: 'nonInteractive',
    label: 'wizards.remoteConfig.predefinedOptions.nonInteractive.label',
    description: 'wizards.remoteConfig.predefinedOptions.nonInteractive.description',
    value: true,
  },
  {
    key: 'all',
    label: 'wizards.remoteConfig.predefinedOptions.all.label',
    description: 'wizards.remoteConfig.predefinedOptions.all.description',
    value: true,
  },
  {
    key: 'noOutput',
    label: 'wizards.remoteConfig.predefinedOptions.noOutput.label',
    description: 'wizards.remoteConfig.predefinedOptions.noOutput.description',
    value: true,
  },
];

export const REMOTE_CONFIG_KEYS = {
  mount: 'mountConfigs',
  sync: 'syncConfigs',
  copy: 'copyConfigs',
  bisync: 'bisyncConfigs',
  move: 'moveConfigs',
  serve: 'serveConfigs',
  filter: 'filterConfigs',
  vfs: 'vfsConfigs',
  backend: 'backendConfigs',
  runtimeRemote: 'runtimeRemoteConfigs',
} as const;

export type RemoteConfigKeyType = (typeof REMOTE_CONFIG_KEYS)[keyof typeof REMOTE_CONFIG_KEYS];

export interface UIOperationMetadata {
  label: string;
  icon: string;
  cssClass: string;
  description?: string;
  typeLabel?: string;
  supportsVfs?: boolean;
  supportsProfiles?: boolean;
}

export const OPERATION_METADATA: Record<string, UIOperationMetadata> = {
  sync: {
    label: 'dashboard.appDetail.syncSettings',
    icon: 'refresh',
    cssClass: 'primary',
    description: 'dashboard.appDetail.syncDesc',
    typeLabel: 'dashboard.appDetail.sync',
    supportsProfiles: true,
  },
  bisync: {
    label: 'dashboard.appDetail.bisyncSettings',
    icon: 'right-left',
    cssClass: 'purple',
    description: 'dashboard.appDetail.bisyncDesc',
    typeLabel: 'dashboard.appDetail.bisync',
    supportsProfiles: true,
  },
  move: {
    label: 'dashboard.appDetail.moveSettings',
    icon: 'move',
    cssClass: 'orange',
    description: 'dashboard.appDetail.moveDesc',
    typeLabel: 'dashboard.appDetail.move',
    supportsProfiles: true,
  },
  copy: {
    label: 'dashboard.appDetail.copySettings',
    icon: 'copy',
    cssClass: 'yellow',
    description: 'dashboard.appDetail.copyDesc',
    typeLabel: 'dashboard.appDetail.copy',
    supportsProfiles: true,
  },
  mount: {
    label: 'dashboard.appDetail.mountSettings',
    icon: 'mount',
    cssClass: 'accent',
    description: 'dashboard.appDetail.mountBehave',
    supportsVfs: true,
    supportsProfiles: true,
  },
  serve: {
    label: 'dashboard.appDetail.serveSettings',
    icon: 'satellite-dish',
    cssClass: 'accent',
    description: 'dashboard.appDetail.serveBehave',
    supportsVfs: true,
    supportsProfiles: true,
  },
  vfs: {
    label: 'dashboard.appDetail.vfsOptions',
    icon: 'vfs',
    cssClass: 'accent',
    supportsProfiles: true,
  },
  filter: {
    label: 'dashboard.appDetail.filterOptions',
    icon: 'filter',
    cssClass: 'accent',
    supportsProfiles: true,
  },
  backend: {
    label: 'dashboard.appDetail.backendConfig',
    icon: 'server',
    cssClass: 'accent',
    supportsProfiles: true,
  },
  runtimeRemote: {
    label: 'dashboard.appDetail.runtimeRemoteOptions',
    icon: 'gear',
    cssClass: 'accent',
    supportsProfiles: true,
  },
};

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

export interface RemoteConfigStepVisibility {
  type?: boolean;
  name?: boolean;
  advanced?: boolean;
  interactive?: boolean;
  commands?: boolean;
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
  runtimeRemoteProfile?: string;
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
  runtimeRemoteProfile?: string;
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
  runtimeRemoteProfile?: string;
  [key: string]: any;
}

export interface RuntimeRemoteConfig {
  options?: Record<string, unknown>;
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
  runtimeRemoteProfile?: string;
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
  runtimeRemoteConfigs?: Record<string, RuntimeRemoteConfig>;

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
  Starred?: boolean;
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
