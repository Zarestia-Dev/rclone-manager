import type { JobInfo, TransferFile } from './jobs';
import type { PrimaryActionType, RemoteAction } from './operations';

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

// ── Stats Panel ─────────────────────────────────────────────────────────────
export interface StatItem {
  value: string | number;
  label: string;
  isPrimary?: boolean;
  hasError?: boolean;
  progress?: number;
  tooltip?: string;
}

export interface StatsPanelConfig {
  title: string;
  icon: string;
  stats: StatItem[];
}

// ── Path Display ────────────────────────────────────────────────────────────
export interface PathDisplayConfig {
  source: string;
  destination: string;
  sourceLabel?: string;
  destinationLabel?: string;
  showOpenButtons?: boolean;
  isDestinationActive?: boolean;
  actionInProgress?: RemoteAction;
  hasSource?: boolean;
  hasDestination?: boolean;
}

// ── Jobs Panel ──────────────────────────────────────────────────────────────
export interface JobsPanelConfig {
  jobs: JobInfo[];
  displayedColumns: readonly string[];
}

// ── Profile selector ────────────────────────────────────────────────────────
export interface ProfileOption {
  name: string;
  label: string;
}

// ── Job Info Panel ──────────────────────────────────────────────────────────
export interface JobInfoConfig {
  operationType: string;
  jobId?: number;
  status?: string;
  startTime?: Date;
  endTime?: Date;
  duration?: string;
  profiles?: ProfileOption[];
  selectedProfile?: string;
  showProfileSelector?: boolean;
  errors?: string[];
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
export interface CompletedTransfer {
  name: string;
  size: number;
  bytes: number;
  checked: boolean;
  error: string;
  jobid: number;
  startedAt?: string;
  completedAt?: string;
  srcFs?: string;
  dstFs?: string;
  group?: string;
  status: 'completed' | 'checked' | 'failed' | 'partial';
}

export interface TransferActivityPanelConfig {
  activeTransfers: TransferFile[];
  completedTransfers: CompletedTransfer[];
  remoteName: string;
  showHistory: boolean;
}

// ── Installation wizard ─────────────────────────────────────────────────────
export interface InstallationOptionsData {
  installLocation: 'default' | 'custom' | 'existing';
  customPath: string;
  existingBinaryPath: string;
  binaryTestResult: 'untested' | 'testing' | 'valid' | 'invalid';
}

export interface InstallationTabOption {
  key: 'default' | 'custom' | 'existing';
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
export const ACTION_ANIMATION_CLASS: Record<PrimaryActionType, string> = {
  sync: 'animate-spin',
  copy: 'animate-copy',
  move: 'animate-move',
  bisync: 'animate-breathing',
  serve: 'animate-pulse-blue',
  mount: 'animate-breathing',
};

/**
 * Mapping of operation colors to their corresponding CSS variable names.
 */
export const OPERATION_COLOR_VAR: Record<OperationColor, string> = {
  primary: 'var(--primary-color)',
  accent: 'var(--accent-color)',
  yellow: 'var(--yellow)',
  orange: 'var(--orange)',
  purple: 'var(--purple)',
  warn: 'var(--warn-color)',
};
