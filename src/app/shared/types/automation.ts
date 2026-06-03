/**
 * Type of automation
 */
export type AutomationType = 'copy' | 'sync' | 'move' | 'bisync';

/**
 * Status of an automation
 */
export type AutomationStatus = 'enabled' | 'disabled' | 'running' | 'failed' | 'stopping';

/**
 * Arguments for an automation
 */
export interface AutomationArgs {
  /** All source paths from the profile. */
  srcPaths: string[];
  /** All destination paths from the profile. */
  dstPaths: string[];
  /** Core parameters for the profile operation */
  remoteName: string;
  profileName: string;
  /** Origin of the operation */
  source?: string;
  /** Whether to use cache */
  noCache?: boolean;
}

/**
 * Represents an automation with cron configuration or realtime watching
 */
export interface Automation {
  /** Unique identifier for the automation */
  id: string;

  /** Type of rclone operation */
  automationType: AutomationType;

  /** Remote name this automation is associated with */
  remoteName: string;

  /** Profile name within the remote */
  profileName: string;

  /** Cron expression (e.g., "0 0 * * *" for daily at midnight) */
  cronExpression?: string;

  /** Current status */
  status: AutomationStatus;

  /** Backend name this automation is associated with */
  backendName: string;

  /** Automation arguments (source, destination, options, etc.) */
  args: AutomationArgs;

  /** When the automation was created */
  createdAt: string;

  /** Last time the automation ran */
  lastRun?: string;

  /** Next scheduled run time */
  nextRun?: string;

  /** Last error message if automation failed */
  lastError?: string;

  /** Current job ID if automation is running */
  currentJobId?: string;

  /** Total number of times this automation has run */
  runCount: number;

  /** Number of successful runs */
  successCount: number;

  /** Number of failed runs */
  failureCount: number;

  /** Number of stopped runs */
  stoppedCount: number;

  /** Enable real-time filesystem monitoring */
  watchEnabled?: boolean;

  /** Delay in seconds to debounce file changes before running the sync */
  watchDelay?: number;
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
 * Statistics for automations
 */
export interface AutomationStats {
  totalAutomations: number;
  enabledAutomations: number;
  runningAutomations: number;
  failedAutomations: number;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  stoppedRuns: number;
}
