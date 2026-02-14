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

export type SyncOperationType = 'sync' | 'copy' | 'move' | 'bisync';
export type PrimaryActionType = SyncOperationType | 'mount' | 'serve';
export type FileOperationType =
  | 'delete_file'
  | 'purge'
  | 'copy_file'
  | 'move_file'
  | 'copy_url'
  | 'cleanup'
  | 'rmdirs'
  | 'list'
  | 'info'
  | 'about'
  | 'size'
  | 'stat'
  | 'hash';
/** All possible job types — single source of truth for JobInfo.job_type */
export type JobActionType = PrimaryActionType | FileOperationType;

export interface ActionState {
  type: RemoteAction;
  profileName?: string;
}

export type RemoteActionProgress = Record<string, ActionState[]>;

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
