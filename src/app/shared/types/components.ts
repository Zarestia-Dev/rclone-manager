import type { JobInfo, TransferFile, CompletedTransfer } from './jobs';
import type { PrimaryActionType, RemoteAction } from './operations';
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
  dryRun?: boolean;
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
  completedTransfers: CompletedTransfer[];
  remoteName: string;
  showHistory: boolean;
  jobType?: string;
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
