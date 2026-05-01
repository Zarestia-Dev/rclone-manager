/**
 * Type of scheduled task
 */
export type TaskType = 'copy' | 'sync' | 'move' | 'delete' | 'purge' | 'bisync';

/**
 * Status of a scheduled task
 */
export type TaskStatus = 'enabled' | 'disabled' | 'running' | 'failed' | 'stopping';

/**
 * Arguments for a scheduled task
 */
export interface ScheduledTaskArgs {
  /** All source paths from the profile. Always an array after Rust serialization,
   *  but accept string too for robustness against cached/legacy state. */
  srcPaths: string | string[];
  /** All destination paths from the profile. Same note as srcPaths. */
  dstPaths: string | string[];
  /** Core parameters for the profile operation */
  remoteName: string;
  profileName: string;
  /** Origin of the operation */
  source?: string;
  /** Whether to use cache */
  noCache?: boolean;
}

/**
 * Represents a scheduled task with cron configuration
 */
export interface ScheduledTask {
  /** Unique identifier for the task */
  id: string;

  /** Type of rclone operation */
  taskType: TaskType;

  /** Remote name this task is associated with */
  remoteName: string;

  /** Profile name within the remote */
  profileName: string;

  /** Cron expression (e.g., "0 0 * * *" for daily at midnight) */
  cronExpression: string;

  /** Current status */
  status: TaskStatus;

  /** Backend name this task is associated with */
  backendName: string;

  /** Task arguments (source, destination, options, etc.) */
  args: ScheduledTaskArgs;

  /** When the task was created */
  createdAt: string;

  /** Last time the task ran */
  lastRun?: string;

  /** Next scheduled run time */
  nextRun?: string;

  /** Last error message if task failed */
  lastError?: string;

  /** Current job ID if task is running */
  currentJobId?: string;

  /** Total number of times this task has run */
  runCount: number;

  /** Number of successful runs */
  successCount: number;

  /** Number of failed runs */
  failureCount: number;
}

/**
 * Response for cron validation
 */
export interface CronValidationResponse {
  isValid: boolean;
  errorMessage?: string;
  nextRun?: string;
  humanReadable?: string;
}

/**
 * Statistics for scheduled tasks
 */
export interface ScheduledTaskStats {
  totalTasks: number;
  enabledTasks: number;
  runningTasks: number;
  failedTasks: number;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
}

/**
 * Event payload when a scheduled task completes
 */
export interface ScheduledTaskCompletedEvent {
  taskId: string;
}

/**
 * Event payload when a scheduled task encounters an error
 */
export interface ScheduledTaskErrorEvent {
  taskId: string;
  error: string;
}

/**
 * Event payload when a scheduled task is manually stopped
 */
export interface ScheduledTaskStoppedEvent {
  taskId: string;
  jobId: number;
}
