/**
 * Type of scheduled task
 */
export type TaskType = 'copy' | 'sync' | 'move' | 'delete' | 'purge' | 'bisync';

/**
 * Status of a scheduled task
 */
export type TaskStatus = 'enabled' | 'disabled' | 'running' | 'failed' | 'stopping';

/**
 * Represents a scheduled task with cron configuration
 */
export interface ScheduledTask {
  /** Unique identifier for the task */
  id: string;

  /** Human-readable name for the task */
  name: string;

  /** Type of rclone operation */
  taskType: TaskType;

  /** Cron expression (e.g., "0 0 * * *" for daily at midnight) */
  cronExpression: string;

  /** Current status */
  status: TaskStatus;

  /** Task arguments (source, destination, options, etc.) */
  args: Record<string, unknown>;

  /** When the task was created */
  createdAt: string;

  /** Last time the task ran */
  lastRun?: string;

  /** Next scheduled run time */
  nextRun?: string;

  /** Last error message if task failed */
  lastError?: string;

  /** Current job ID if task is running */
  currentJobId?: number;

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
