import { GlobalStats, JobStatus } from './jobs';
import { Starter } from './starter';
import { MemoryStats, RcloneInfo, RcloneStatus } from './system';

import { WorkflowNodeExecutionState } from '../../flow/workflow/types/workflow.types';

export const RCLONE_ENGINE_STATUS_CHANGED = 'rclone_engine_status_changed' as const;
export const BACKEND_SWITCHED = 'backend_switched' as const;
export const REMOTE_CACHE_CHANGED = 'remote_cache_changed' as const;
export const RCLONE_OAUTH_URL = 'rclone_oauth_url' as const;
export const ALERT_FIRED = 'alert_fired' as const;
export const REMOTE_SETTINGS_CHANGED = 'remote_settings_changed' as const;
export const SYSTEM_SETTINGS_CHANGED = 'system_settings_changed' as const;
export const BANDWIDTH_LIMIT_CHANGED = 'bandwidth_limit_changed' as const;
export const RCLONE_CONFIG_UNLOCKED = 'rclone_config_unlocked' as const;
export const UPDATE_TRAY_MENU = 'tray_menu_updated' as const;
export const SYSTEM_THEME_CHANGED = 'system_theme_changed' as const;
export const JOB_CACHE_CHANGED = 'job_cache_changed' as const;
export const JOB_STATS_UPDATED = 'job_stats_updated' as const;
export const MOUNT_STATE_CHANGED = 'mount_state_changed' as const;
export const SERVE_STATE_CHANGED = 'serve_state_changed' as const;
export const SYSTEM_STATUS = 'system_status' as const;
export const MOUNT_PLUGIN_INSTALLED = 'mount_plugin_installed' as const;
export const PROVISION_PROGRESS = 'provision_progress' as const;
export const NETWORK_STATUS_CHANGED = 'network_status_changed' as const;
export const AUTOMATIONS_CACHE_CHANGED = 'automations_cache_changed' as const;
export const WORKFLOW_NODE_STATE_CHANGED = 'workflow_node_state_changed' as const;
export const WORKFLOW_EXECUTION_STATE_CHANGED = 'workflow_execution_state_changed' as const;
export const APP_EVENT = 'app_event' as const;
/** `status` values of updater app events; see `app_event_status` in events.rs. */
export const APP_EVENT_STATUS = {
  updateFound: 'update_found',
  rcloneUpdateFound: 'rclone_update_found',
  downloadProgress: 'download_progress',
} as const;
export const UPDATER_STATE_CHANGED = 'updater_state_changed' as const;
export const VAULT_STATE_CHANGED = 'vault_state_changed' as const;

export interface UpdaterStateChanged {
  target: 'app' | 'rclone';
}
export const APP_EXIT_REQUESTED = 'app_exit_requested' as const;
export const BROWSE = 'browse' as const;

/** Where a run is; `started` and `running` are live, the rest end the run. */
export type WorkflowExecutionState = 'started' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowRunProgress {
  total: number;
  completed: number;
  currentStepTitle: string;
}

/**
 * `runId` and `seq` order the events of a run: a snapshot of the run contains every event up
 * to its own `seq`, so a view that loaded one ignores the events at or below it.
 */
export interface WorkflowNodeStatePayload {
  workflowId: string;
  runId: string;
  seq: number;
  /** RFC 3339 */
  at: string;
  nodeId: string;
  state: WorkflowNodeExecutionState;
  errorMessage?: string;
  durationMs?: number;
  output?: unknown;
}

export interface WorkflowExecutionStatePayload {
  workflowId: string;
  runId: string;
  seq: number;
  /** RFC 3339 */
  at: string;
  state: WorkflowExecutionState;
  dryRun: boolean;
  progress?: WorkflowRunProgress;
  message?: string;
}

/** An event of a run as a snapshot keeps it for the log; node events come without their output. */
export type WorkflowRunEvent =
  | ({ kind: 'node' } & WorkflowNodeStatePayload)
  | ({ kind: 'execution' } & WorkflowExecutionStatePayload);

export interface WorkflowNodeSnapshot {
  state: WorkflowNodeExecutionState;
  errorMessage?: string;
  durationMs?: number;
  output?: unknown;
}

/** A run as it stands: live, or the last one that ended (`get_workflow_runs`). */
export interface WorkflowRunSnapshot {
  workflowId: string;
  runId: string;
  dryRun: boolean;
  /** RFC 3339 */
  startedAt: string;
  state: WorkflowExecutionState;
  /** The `seq` of the last event the snapshot contains. */
  seq: number;
  progress?: WorkflowRunProgress;
  /** The latest state of each node that has reported, by node id. */
  nodes: Record<string, WorkflowNodeSnapshot>;
  /** What the log of the run is made of, oldest first. */
  events: WorkflowRunEvent[];
}

export interface ActiveOperationsSummary {
  hasActiveOperations: boolean;
  activeJobsCount: number;
  activeMountsCount: number;
  activeServesCount: number;
}

export interface SettingsChangeEvent {
  category: string;
  key: string;
  value: unknown;
}

export interface VaultStatePayload {
  event: string;
  isLocked: boolean;
  isEnabled: boolean;
  lockTimeout?: number | null;
}

export interface OAuthUrlEvent {
  url: string;
}

export interface JobChangeEvent {
  jobId: string;
  backendName?: string;
  status: JobStatus;
  remote?: string;
  source?: string;
  sources?: string[];
  destination?: string;
  starter?: Starter;
}

export interface JobStatsUpdatedEvent {
  jobId: number;
  backendName: string;
  executeId?: string | null;
  statsRevision?: number;
  stats: GlobalStats;
}

export interface SystemStatusPayload {
  rcloneInfo: RcloneInfo | null;
  pid: number | null;
  stats: GlobalStats;
  memory: MemoryStats | null;
  status: RcloneStatus;
  hasActiveJobs: boolean;
}

export type EngineStatus =
  | { status: 'ready' }
  | { status: 'error'; payload: { message: string } }
  | { status: 'passwordError' }
  | { status: 'authError'; payload: { message: string } }
  | { status: 'pathError' }
  | { status: 'versionError'; payload: { version: string; required: string } }
  | { status: 'portError'; payload: { port: number; message: string } }
  | { status: 'updating' }
  | { status: 'restarted'; payload: { reason: string } };

export type EngineErrorType = 'password' | 'path' | 'version' | 'auth' | 'port' | 'generic' | null;
