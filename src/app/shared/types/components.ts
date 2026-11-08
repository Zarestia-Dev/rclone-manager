import type {
  GlobalStats,
  JobInfo,
  JobReportCounts,
  JobStatus,
  TransferFile,
  CompletedTransfer,
} from './jobs';
import type { JobActionType, PrimaryActionType, RemoteAction } from './operations';
import { OPERATION_REGISTRY } from './operation-registry';

// ── Shared color tokens used across operation UI ───────────────────────────
export type OperationColor = 'primary' | 'accent' | 'yellow' | 'orange' | 'purple' | 'warn';

// ── Settings Panel ──────────────────────────────────────────────────────────
export interface SettingsSection {
  key: string;
  title: string;
  icon: string;
}

export interface SettingsPanelConfig {
  section: SettingsSection;
  settings: Record<string, unknown>;
  buttonLabel?: string;
}

export interface SettingEntry {
  key: string;
  display: string;
  tooltip: string;
  isSensitive?: boolean;
}

export interface GroupedSettings {
  category: string;
  entries: SettingEntry[];
}

// ── Path Display ────────────────────────────────────────────────────────────
export interface PathDisplayConfig {
  source: string | string[];
  destination: string;
  sourceLabel?: string;
  destinationLabel?: string;
  showOpenButtons?: boolean;
  isDestinationActive?: boolean;
  actionInProgress?: RemoteAction;
  hasSource?: boolean;
  hasDestination?: boolean;
  hideDestination?: boolean;
}

// ── Jobs Panel ──────────────────────────────────────────────────────────────
export interface JobsPanelConfig {
  jobs: JobInfo[];
}

// ── Operation Control ───────────────────────────────────────────────────────
export interface OperationControlConfig {
  operationType: PrimaryActionType;
  isActive: boolean;
  isError?: boolean;
  isLoading: boolean;
  cssClass: string;
  pathConfig: PathDisplayConfig;
  primaryButtonLabel: string;
  primaryIcon: string;
  secondaryButtonLabel: string;
  secondaryIcon: string;
  actionInProgress?: RemoteAction;
  operationDescription?: string;
  profileName?: string;
}

// ── Transfer Activity Panel ─────────────────────────────────────────────────
export interface TransferActivityPanelConfig {
  activeTransfers: TransferFile[];
  activeChecks?: string[];
  completedTransfers: CompletedTransfer[];
  remoteName: string;
  showHistory: boolean;
  jobType?: JobActionType;
  /** The finished job whose reports the panel offers as tabs, when it kept any. */
  report?: {
    jobId: number;
    counts: JobReportCounts;
    /** The two paths of a bisync job, which its conflicts are resolved on. */
    path1?: string;
    path2?: string;
    /** Nothing was changed by a dry run, so there is nothing to resolve. */
    dryRun?: boolean;
  };
}

// ── Job Monitor ─────────────────────────────────────────────────────────────
/** Everything the job monitor shows for one job: its header, its figures and its file activity. */
export interface JobMonitorConfig {
  jobType: JobActionType;
  /** Already translated, e.g. "Sync". */
  title: string;
  icon: string;
  jobId?: number;
  status?: JobStatus;
  /** Whether work is going on right now; this is what makes figures live. */
  running: boolean;
  dryRun?: boolean;
  /** Why the job failed, as rclone or the backend reported it; shown translated above the figures. */
  error?: string;
  startTime?: Date | string;
  endTime?: Date | string;
  /** Already formatted. */
  duration?: string;
  stats: GlobalStats;
  activity: TransferActivityPanelConfig;
}

// ── Installation wizard ─────────────────────────────────────────────────────
export type LocationType = 'default' | 'custom' | 'existing';
export type BinaryStatus = 'untested' | 'testing' | 'valid' | 'invalid';

export interface InstallationOptionsData {
  installLocation: LocationType;
  customPath: string;
  existingBinaryPath: string;
  binaryTestResult: BinaryStatus;
}

export interface InstallationTabOption {
  key: LocationType;
  label: string;
  icon: string;
}

// ── Remote card display ─────────────────────────────────────────────────────
export type RemoteCardVariant = 'active' | 'inactive' | 'error';
export type CardDisplayMode = 'compact' | 'detailed';

/**
 * Global mapping of operation types to their corresponding animation classes.
 * These classes are defined in src/animations.scss.
 */
export const ACTION_ANIMATION_CLASS = Object.freeze(
  Object.fromEntries(
    OPERATION_REGISTRY.filter(op => op.isPrimary).map(op => [op.key, op.animationClass])
  )
) as Readonly<Record<PrimaryActionType, string>>;

/**
 * Mapping of operation colors to their corresponding CSS variable names.
 */
export const OPERATION_COLOR_VAR: Readonly<Record<OperationColor, string>> = Object.freeze({
  primary: 'var(--primary-color)',
  accent: 'var(--accent-color)',
  yellow: 'var(--yellow)',
  orange: 'var(--orange)',
  purple: 'var(--purple)',
  warn: 'var(--warn-color)',
});
