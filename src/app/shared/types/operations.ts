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

export type RemoteActionProgress = Record<string, RemoteAction>;

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
