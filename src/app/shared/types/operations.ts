// =============================================================================
// OPERATION TYPES
// =============================================================================
//
// Type hierarchy:
//
//    SyncOperationType ─────────────────────┐
//    ('sync' | 'copy' | 'move' | 'bisync')  │
//                                           ├──▶ PrimaryActionType
//   'mount'  ───────────────────────────────┤    (everything a remote can "do")
//   'serve'  ───────────────────────────────┘
//
// Note: 'sync' as a PrimaryActionType means "enter the sync family tab" —
// the specific sub-operation (copy / move / bisync) is tracked separately via
// SyncOperationType. They intentionally share the string value 'sync' so that
// tab routing and operation dispatch align without translation.
//
// =============================================================================

// ---------------------------------------------------------------------------
// Core operation discriminants
// ---------------------------------------------------------------------------

export type SyncOperationType = 'sync' | 'copy' | 'move' | 'bisync';

export type PrimaryActionType = SyncOperationType | 'mount' | 'serve';

// ---------------------------------------------------------------------------
// Job-level types (rclone job layer)
// ---------------------------------------------------------------------------

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
  | 'delete_file'
  | 'purge'
  | 'copy_file'
  | 'move_file'
  | 'rename_file'
  | 'rename_dir'
  | 'copy_url'
  | 'cleanup'
  | 'rmdirs'
  | 'list'
  | 'info'
  | 'about'
  | 'size'
  | 'stat'
  | 'hash';

/** Single source of truth for JobInfo.job_type */
export type JobActionType = PrimaryActionType | FileOperationType;

// ---------------------------------------------------------------------------
// Runtime action state
// ---------------------------------------------------------------------------

export interface ActionState {
  type: RemoteAction;
  profileName?: string;
}

export type RemoteActionProgress = Record<string, ActionState[]>;

// ---------------------------------------------------------------------------
// Operation metadata — STATIC config only, no runtime state
//
// Use SyncOperationViewModel (below) when you also need to carry isActive.
// ---------------------------------------------------------------------------

export interface SyncOperationConfig {
  type: SyncOperationType;
  /** i18n key */
  label: string;
  /** i18n key for short type label shown on toggle buttons */
  typeLabel?: string;
  /** i18n key for descriptive tooltip */
  description?: string;
  icon: string;
  cssClass: string;
}

// ---------------------------------------------------------------------------
// View model — static config + runtime state, used inside components
// ---------------------------------------------------------------------------

export interface SyncOperationViewModel extends SyncOperationConfig {
  /** True when this specific operation is currently running on the remote. */
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Misc UI helpers
// ---------------------------------------------------------------------------

export interface QuickActionButton {
  id: string;
  icon: string;
  tooltip: string;
  isLoading?: boolean;
  isDisabled?: boolean;
  cssClass?: string;
}
