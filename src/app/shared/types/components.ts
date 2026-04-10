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
  buttonColor?: OperationColor;
  buttonLabel?: string;
}

// ── Status Badge ────────────────────────────────────────────────────────────
export interface StatusBadgeConfig {
  isActive: boolean;
  isError?: boolean;
  isLoading?: boolean;
  activeLabel: string;
  inactiveLabel: string;
  errorLabel?: string;
  loadingLabel?: string;
  badgeClass?: string;
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
  operationClass?: string;
  operationColor?: OperationColor;
}

// ── Path Display ────────────────────────────────────────────────────────────
export interface PathDisplayConfig {
  source: string;
  destination: string;
  sourceLabel?: string;
  destinationLabel?: string;
  showOpenButtons?: boolean;
  operationColor?: OperationColor;
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
  operationClass: string;
  operationColor: OperationColor;
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
