// Operation type hierarchy:
//
//   SyncOperationType ('sync' | 'copy' | 'move' | 'bisync')  ┐
//   'mount'                                                    ├──▶ PrimaryActionType
//   'serve'                                                    ┘
//
// Note: 'sync' appears in both SyncOperationType and PrimaryActionType.
// As a PrimaryActionType it means "enter the sync tab"; the active sub-operation
// (copy / move / bisync) is tracked separately via SyncOperationType.
// They share the string 'sync' intentionally so tab routing and dispatch align.

// ── Core operation discriminants ────────────────────────────────────────────

export type SyncOperationType = 'sync' | 'copy' | 'move' | 'bisync';

export type PrimaryActionType = SyncOperationType | 'mount' | 'serve';

// ── Job-level types ─────────────────────────────────────────────────────────

export type JobType = 'sync' | 'copy' | 'move' | 'bisync' | 'check' | 'serve';

export type RemoteAction =
  | 'mount'
  | 'unmount'
  | 'sync'
  | 'copy'
  | 'move'
  | 'bisync'
  | 'serve'
  | 'stop'
  | 'open'
  | 'delete'
  | null;

export type FileOperationType =
  | 'delete'
  | 'rename'
  | 'upload'
  | 'copy_url'
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

// ── Static operation metadata ───────────────────────────────────────────────
// No runtime state here — use SyncOperationViewModel when you need isActive.

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
