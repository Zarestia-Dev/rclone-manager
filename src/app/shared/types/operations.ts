import { OPERATION_REGISTRY } from './operation-registry';

// ── Types inferred directly from the registry! ──────────────────────────────
export type OperationDefinitionItem = (typeof OPERATION_REGISTRY)[number];

export type SyncOperationType = Extract<OperationDefinitionItem, { isSyncType: true }>['key'];
export type PrimaryActionType = Extract<OperationDefinitionItem, { isPrimary: true }>['key'];

// ── Job-level types ─────────────────────────────────────────────────────────
export type JobType = Extract<OperationDefinitionItem, { isJobType: true }>['key'];

export type RemoteAction = PrimaryActionType | 'unmount' | 'stop' | 'open' | null;

export type FileOperationType =
  | 'delete'
  | 'rename'
  | 'upload'
  | 'copyurl'
  | 'cleanup'
  | 'rmdirs'
  | 'list'
  | 'info'
  | 'about'
  | 'size'
  | 'stat'
  | 'hash'
  | 'archivecreate'
  | 'archiveextract';

/** Single source of truth for `JobInfo.job_type`. */
export type JobActionType = PrimaryActionType | FileOperationType;

// ── Runtime action state ────────────────────────────────────────────────────
export interface ActionState {
  type: RemoteAction;
  profileName?: string;
  operationType?: PrimaryActionType;
}

export type RemoteActionProgress = Record<string, ActionState[]>;

export interface StartJobEvent {
  type: PrimaryActionType;
  remoteName: string;
  profileName: string;
}

export interface StopJobEvent {
  type: PrimaryActionType;
  remoteName: string;
  serveId?: string;
  profileName?: string;
}

// ── Static operation metadata ───────────────────────────────────────────────
export interface SyncOperationConfig {
  type: SyncOperationType;
  /** i18n key for the full label. */
  label: string;
  /** i18n key for the short label on toggle buttons. */
  typeLabel?: string;
  /** i18n key for a descriptive tooltip. */
  description?: string;
  icon: string;
  cssClass: string;
}

// ── View model ──────────────────────────────────────────────────────────────
export interface SyncOperationViewModel extends SyncOperationConfig {
  /** True when this specific operation is currently running on the remote. */
  isActive: boolean;
}

// ── Misc UI helpers ─────────────────────────────────────────────────────────
export interface QuickActionButton {
  id: string;
  icon: string;
  tooltip: string;
  isLoading?: boolean;
  isDisabled?: boolean;
  cssClass?: string;
}

export const OPERATION_ICONS = Object.freeze(
  Object.fromEntries(OPERATION_REGISTRY.filter(op => op.isPrimary).map(op => [op.key, op.icon]))
) as Readonly<Record<PrimaryActionType, string>>;

export const SYNC_TYPES = OPERATION_REGISTRY.filter(op => op.isSyncType).map(
  op => op.key
) as SyncOperationType[];

export const BROWSABLE_OPS = OPERATION_REGISTRY.filter(op => op.isBrowsable).map(
  op => op.key
) as PrimaryActionType[];

export const ALL_PRIMARY_ACTIONS = OPERATION_REGISTRY.filter(op => op.isPrimary).map(
  op => op.key
) as PrimaryActionType[];

/**
 * Maps sync operation types to their capitalized labels used by the rclone API.
 */
export const BATCH_OP_LABELS = Object.freeze(
  Object.fromEntries(
    OPERATION_REGISTRY.filter(op => op.isSyncType).map(op => [op.key, op.apiLabel])
  )
) as Readonly<Record<SyncOperationType, string>>;

/**
 * Set of primary operation-type keys for efficient lookup.
 */
export const OPERATION_TYPE_KEYS: ReadonlySet<string> = new Set<string>(ALL_PRIMARY_ACTIONS);

// ── Operation Category Constants for unifying inline lists ──────────────────
export const CORE_SYNC_OPS = ['sync', 'copy', 'move'] as const;
export const WATCH_SUPPORTED_OPS = ['sync', 'copy', 'move', 'bisync', 'check'] as const;
export const CORE_COMMAND_OPS = ['archivecreate', 'cryptcheck'] as const;
export const MULTI_SOURCE_OPS = [
  'sync',
  'copy',
  'move',
  'delete',
  'copyurl',
  'check',
  'cryptcheck',
] as const;
export const FILE_SOURCE_OPS = ['copy', 'move', 'delete', 'archivecreate'] as const;
export const BACKEND_PROFILE_SUPPORTED_OPS = [
  'sync',
  'copy',
  'move',
  'check',
  'delete',
  'copyurl',
  'archivecreate',
] as const;
export const NON_JOB_OPS = ['mount', 'serve'] as const;
