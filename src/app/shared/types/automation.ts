import type { Origin } from './origin';
import type { PrimaryActionType } from './operations';

/**
 * Type of automation. Derived from `PrimaryActionType` by excluding the
 * non-automatable operations (`mount` and `serve`).
 */
export type AutomationType = Exclude<PrimaryActionType, 'mount' | 'serve'>;

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
  /** All destination paths from the profile; none for a workflow. */
  dstPaths: string[];
  /** What defined the automation: a remote profile, a Quick Run or a workflow. */
  source: Origin;
}

/**
 * Represents an automation with cron configuration or realtime watching
 */
export interface Automation {
  /** Unique identifier for the automation */
  id: string;

  /** Type of rclone operation; null for a workflow, which is no single operation. */
  automationType: AutomationType | null;

  /** Remote name this automation is associated with; empty for a workflow. */
  remoteName: string;

  /** Profile name within the remote */
  profileName: string;

  /** Cron expression (e.g., "0 0 * * *" for daily at midnight) */
  cronExpression: string | null;

  /** Current status */
  status: AutomationStatus;

  /** Backend name this automation is associated with */
  backendName: string;

  /** Automation arguments (source, destination, options, etc.) */
  args: AutomationArgs;

  /** Last time the automation ran */
  lastRun: string | null;

  /** Next scheduled run time */
  nextRun: string | null;

  /** Last error message if automation failed */
  lastError: string | null;

  /** Current job ID if automation is running */
  currentJobId: string | null;

  /** Total number of times this automation has run */
  runCount: number;

  /** Number of successful runs */
  successCount: number;

  /** Number of failed runs */
  failureCount: number;

  /** Number of stopped runs */
  stoppedCount: number;

  /** Enable real-time filesystem monitoring */
  watchEnabled: boolean;

  /** Delay in seconds to debounce file changes before running the sync */
  watchDelay: number;

  /** Only synchronize directories containing changed files when triggered by file watcher */
  watchChangedOnly: boolean;
}

/**
 * Response for cron validation
 */
export interface CronValidationResponse {
  isValid: boolean;
  errorMessage?: string;
  nextRun?: string;
  /** UTC offset schedules fire in (the machine running the app), e.g. `+03:00`. */
  utcOffset?: string;
}
