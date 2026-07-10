import { OPERATION_REGISTRY } from './operation-registry';
import { ConfigValue } from './system';

// Dynamic extraction of FlagTypes based on registry
export type FlagType =
  | Extract<(typeof OPERATION_REGISTRY)[number], { isFlagType: true }>['key']
  | 'filter'
  | 'vfs'
  | 'backend';

// List is frozen
export const FLAG_TYPES = Object.freeze([
  ...OPERATION_REGISTRY.filter(op => op.isFlagType).map(op => op.key),
  'filter',
  'vfs',
  'backend',
]) as readonly FlagType[];

export const DEFAULT_PROFILE_NAME = 'default';

export type EditTarget = FlagType | 'remote' | 'runtimeRemote' | null;
export type SharedProfileType = FlagType | 'runtimeRemote';

export const LINKED_PROFILE_TYPES: ReadonlySet<string> = new Set(
  OPERATION_REGISTRY.filter(op => op.hasLinkedProfiles).map(op => op.key)
);

export const PROFILE_ICONS: Readonly<Record<string, string>> = Object.freeze({
  mount: 'hard-drive',
  sync: 'refresh',
  copy: 'copy',
  move: 'move',
  bisync: 'right-left',
  serve: 'satellite-dish',
  check: 'search',
  delete: 'trash',
  copyurl: 'download',
  archivecreate: 'compress',
  cryptcheck: 'shield',
  vfs: 'vfs',
  filter: 'filter',
  backend: 'database',
  runtimeRemote: 'gear',
});

export const INTERACTIVE_REMOTES: ReadonlySet<string> = new Set([
  'onedrive',
  'iclouddrive',
  'jottacloud',
]);

// ─── Command Option types ───────────────────────────────────────────────────

export interface CommandOption {
  key: string;
  value: boolean | string | number | string[];
  label?: string;
  description?: string;
}

export const PREDEFINED_OPTIONS: readonly CommandOption[] = Object.freeze([
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
]);

export interface RemoteConfigKeysRecord {
  mount: 'mountConfigs';
  sync: 'syncConfigs';
  copy: 'copyConfigs';
  bisync: 'bisyncConfigs';
  move: 'moveConfigs';
  serve: 'serveConfigs';
  check: 'checkConfigs';
  delete: 'deleteConfigs';
  copyurl: 'copyurlConfigs';
  archivecreate: 'archivecreateConfigs';
  cryptcheck: 'cryptcheckConfigs';
  filter: 'filterConfigs';
  vfs: 'vfsConfigs';
  backend: 'backendConfigs';
  runtimeRemote: 'runtimeRemoteConfigs';
}

export const REMOTE_CONFIG_KEYS = Object.freeze({
  ...Object.fromEntries(
    OPERATION_REGISTRY.filter(op => op.configKey).map(op => [op.key, op.configKey])
  ),
  filter: 'filterConfigs',
  vfs: 'vfsConfigs',
  backend: 'backendConfigs',
  runtimeRemote: 'runtimeRemoteConfigs',
}) as unknown as Readonly<RemoteConfigKeysRecord>;

export type RemoteConfigKeyType = RemoteConfigKeysRecord[keyof RemoteConfigKeysRecord];

export interface UIOperationMetadata {
  label: string;
  icon: string;
  cssClass: string;
  description?: string;
  typeLabel?: string;
  supportsVfs?: boolean;
  supportsProfiles?: boolean;
}

export const OPERATION_METADATA: Readonly<Record<string, UIOperationMetadata>> = Object.freeze({
  ...Object.fromEntries(
    OPERATION_REGISTRY.map(op => [
      op.key,
      {
        label: op.settingsLabel,
        icon: op.icon,
        cssClass: op.cssClass,
        description: op.settingsDescription,
        typeLabel: op.typeLabel,
        supportsVfs: op.supportsVfs,
        supportsProfiles: op.supportsProfiles,
      },
    ])
  ),
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
});

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

export interface AppConfig {
  autoStart: boolean;
  cronEnabled?: boolean;
  cronExpression?: string | null;
  watchEnabled?: boolean;
  watchDelay?: number;
  vfsProfile?: string;
  filterProfile?: string;
  backendProfile?: string;
  runtimeRemoteProfile?: string;
}

export interface ProfileConfig {
  app?: AppConfig;
  rclone?: {
    srcFs?: string | string[];
    dstFs?: string;
    path1?: string;
    path2?: string;
    fs?: string;
    mountPoint?: string;
    type?: string;
    addr?: string;
    _config?: Record<string, ConfigValue>;
  };
}

export interface MountConfig {
  app: AppConfig;
  rclone: {
    fs?: string;
    mountPoint?: string;
    mountType?: string;
    mountOpt?: Record<string, ConfigValue>;
  };
}

export interface CopyConfig {
  app: AppConfig;
  rclone: {
    srcFs?: string | string[];
    dstFs?: string;
    createEmptySrcDirs?: boolean;
    _config?: Record<string, ConfigValue>;
  };
}

export interface SyncConfig {
  app: AppConfig;
  rclone: {
    srcFs?: string | string[];
    dstFs?: string;
    createEmptySrcDirs?: boolean;
    _config?: Record<string, ConfigValue>;
  };
}

// Replaced Record<string, any>
export type FilterConfig = Record<string, ConfigValue>;
export type VfsConfig = Record<string, ConfigValue>;
export type BackendConfig = Record<string, ConfigValue>;
export type RuntimeRemoteConfig = Record<string, ConfigValue>;

export interface MoveConfig {
  app: AppConfig;
  rclone: {
    srcFs?: string | string[];
    dstFs?: string;
    createEmptySrcDirs?: boolean;
    deleteEmptySrcDirs?: boolean;
    _config?: Record<string, ConfigValue>;
  };
}

export interface BisyncConfig {
  app: AppConfig;
  rclone: {
    path1?: string;
    path2?: string;
    dryRun?: boolean;
    resync?: boolean;
    resyncMode?: string;
    checkAccess?: boolean;
    checkFilename?: string;
    maxDelete?: number;
    force?: boolean;
    checkSync?: boolean | 'only';
    compare?: string;
    conflictLoser?: string;
    conflictResolve?: string;
    conflictSuffix?: string;
    createEmptySrcDirs?: boolean;
    removeEmptyDirs?: boolean;
    downloadHash?: boolean;
    filtersFile?: string;
    ignoreListingChecksum?: boolean;
    maxLock?: string;
    noSlowHash?: boolean;
    slowHashSyncOnly?: boolean;
    recover?: boolean;
    resilient?: boolean;
    workdir?: string;
    backupDir1?: string;
    backupDir2?: string;
    noCleanup?: boolean;
    _config?: Record<string, ConfigValue>;
  };
}

export interface ServeConfig {
  app: AppConfig;
  rclone: {
    fs?: string;
    type?: string;
    _config?: Record<string, ConfigValue>;
  };
}

export interface CheckConfig {
  app: AppConfig;
  rclone: {
    srcFs?: string | string[];
    dstFs?: string;
    download?: boolean;
    checkFileHash?: string;
    checkFileFs?: string;
    _config?: Record<string, ConfigValue>;
  };
}

export interface DeleteConfig {
  app: AppConfig;
  rclone: {
    srcFs?: string | string[];
    _config?: Record<string, ConfigValue>;
  };
}

export interface CopyurlConfig {
  app: AppConfig;
  rclone: {
    srcFs?: string | string[];
    dstFs?: string;
    autoFilename?: boolean;
    filenames?: string[];
    _config?: Record<string, ConfigValue>;
  };
}

export interface ArchivecreateConfig {
  app: AppConfig;
  rclone: {
    srcFs?: string | string[];
    dstFs?: string;
    format?: string;
    prefix?: string;
    fullPath?: boolean;
    _config?: Record<string, ConfigValue>;
  };
}

export interface CryptcheckConfig {
  app: AppConfig;
  rclone: {
    srcFs?: string | string[];
    dstFs?: string;
    _config?: Record<string, ConfigValue>;
  };
}

// A single remote's settings broken into sections used by the UI
export interface RemoteConfigSections {
  [remoteName: string]: unknown;

  mountConfigs?: Record<string, MountConfig>;
  copyConfigs?: Record<string, CopyConfig>;
  syncConfigs?: Record<string, SyncConfig>;
  moveConfigs?: Record<string, MoveConfig>;
  bisyncConfigs?: Record<string, BisyncConfig>;
  serveConfigs?: Record<string, ServeConfig>;
  checkConfigs?: Record<string, CheckConfig>;
  deleteConfigs?: Record<string, DeleteConfig>;
  copyurlConfigs?: Record<string, CopyurlConfig>;
  archivecreateConfigs?: Record<string, ArchivecreateConfig>;
  cryptcheckConfigs?: Record<string, CryptcheckConfig>;

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
  Default?: ConfigValue;
  Value?: ConfigValue;
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
  id: string;
  name: string; // The path used for rclone
  label: string;
  show_name: boolean;
  total_space: number;
  available_space: number;
  file_system: string;
  is_removable: boolean;
  mount_point: string;
}

export interface ExplorerRoot {
  name: string;
  label: string;
  type: string; // Icon name
  isLocal: boolean;
  showName?: boolean;
  totalSpace?: number;
  availableSpace?: number;
  fileSystem?: string;
  isRemovable?: boolean;
}

export const RCLONE_PATH_KEYS = [
  'dstFs',
  'path2',
  'mountPoint',
  'dest',
  'srcFs',
  'path1',
  'fs',
  'source',
  'path',
] as const;

export interface JobProfile {
  autoStart?: boolean;
  srcFs?: string | string[];
  dstFs?: string;
  path1?: string;
  path2?: string;
  fs?: string;
  mountPoint?: string;
}

export type JobMap = Record<string, JobProfile>;

export interface PendingRemoteData {
  name: string;
  type: string;
  [key: string]: unknown;
}

export type WizardStep = 'setup' | 'operations' | 'interactive';
export type OperationType =
  | 'mount'
  | 'sync'
  | 'copy'
  | 'bisync'
  | 'move'
  | 'serve'
  | 'check'
  | 'cryptcheck'
  | 'delete'
  | 'copyurl'
  | 'archivecreate';
