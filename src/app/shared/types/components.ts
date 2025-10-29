import type { JobInfo, TransferFile } from './jobs';
import { PrimaryActionType } from './operations';

// Settings Panel
export interface SettingsSection {
  key: string;
  title: string;
  icon: string;
}

export interface SettingsPanelConfig {
  section: SettingsSection;
  settings: any;
  hasSettings: boolean;
  restrictMode: boolean;
  buttonColor?: string;
  buttonLabel?: string;
  sensitiveKeys?: string[];
}

// Status Badge
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

// Stats Panel
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
  operationColor?: string;
}

// Path Display
export interface PathDisplayConfig {
  source: string;
  destination: string;
  sourceLabel?: string;
  destinationLabel?: string;
  showOpenButtons?: boolean;
  operationColor?: string;
  isDestinationActive?: boolean;
  actionInProgress?: string;
}

// Jobs Panel
export interface JobsPanelConfig {
  jobs: JobInfo[];
  displayedColumns: string[];
}

// Job Info Panel
export interface JobInfoConfig {
  operationType: string;
  jobId?: number;
  startTime?: Date;
  lastOperationTime?: string;
}

// Operation Control
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
  actionInProgress?: string;
  operationDescription?: string;
}

// Disk Usage Panel
export interface DiskUsageConfig {
  mounted: boolean | string;
  diskUsage?: {
    total_space?: string;
    used_space?: string;
    free_space?: string;
    notSupported?: boolean;
    loading?: boolean;
  };
}

// Transfer Activity Panel
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
  operationColor: string;
  remoteName: string;
  showHistory: boolean;
}

// Installation Options component
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

// Remote card variants used across overview components
export type RemoteCardVariant = 'active' | 'inactive' | 'error';
