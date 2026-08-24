import { InstallationOptionsData, InstallationTabOption } from './components';

export interface RepairData {
  type:
    | 'rclone_binary'
    | 'rclone_version'
    | 'mount_plugin'
    | 'config_corrupt'
    | 'backend_unreachable'
    | 'rclone_password'
    | 'rclone_auth';
  title?: string;
  message?: string;
  requiresPassword?: boolean;
  showStoreOption?: boolean;
  passwordDescription?: string;
  authError?: string;
}

export type RepairMode = 'standard' | 'install' | 'config';

export type ProvisionComponent = 'rclone' | 'mountPlugin';

export type ProvisionStage =
  'downloading' | 'verifying' | 'extracting' | 'installing' | 'completed' | 'cancelled' | 'error';

export interface ProvisionProgressPayload {
  component: ProvisionComponent;
  stage: ProvisionStage;
  downloadedBytes: number;
  totalBytes?: number | null;
  error?: string | null;
}

export interface ProvisionStatus {
  rclone?: ProvisionProgressPayload | null;
  mountPlugin?: ProvisionProgressPayload | null;
}

export const CONFIG_TAB_OPTIONS: readonly InstallationTabOption[] = Object.freeze([
  { key: 'default', label: 'repairSheet.configTabs.default', icon: 'bolt' },
  { key: 'custom', label: 'repairSheet.configTabs.custom', icon: 'file' },
]);

export const RCLONE_INSTALL_TAB_OPTIONS: readonly InstallationTabOption[] = Object.freeze([
  { key: 'default', label: 'onboarding.options.recommended', icon: 'star' },
  { key: 'custom', label: 'onboarding.options.custom', icon: 'folder' },
  { key: 'existing', label: 'onboarding.options.existing', icon: 'file' },
]);

export const ONBOARDING_CONFIG_TAB_OPTIONS: readonly InstallationTabOption[] = Object.freeze([
  { key: 'default', label: 'onboarding.options.default', icon: 'file' },
  { key: 'custom', label: 'onboarding.options.custom', icon: 'folder' },
]);

export const DEFAULT_INSTALLATION_DATA: Readonly<InstallationOptionsData> = Object.freeze({
  installLocation: 'default',
  customPath: '',
  existingBinaryPath: '',
  binaryTestResult: 'untested',
});
