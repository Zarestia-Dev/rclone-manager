import { InstallationOptionsData, InstallationTabOption } from './components';

export interface RepairData {
  type:
    | 'rclone_binary'
    | 'rclone_version'
    | 'mount_plugin'
    | 'config_corrupt'
    | 'backend_unreachable'
    | 'rclone_password';
  title?: string;
  message?: string;
  requiresPassword?: boolean;
  showStoreOption?: boolean;
  passwordDescription?: string;
}

export type RepairMode = 'standard' | 'install' | 'config';

export const CONFIG_TAB_OPTIONS: InstallationTabOption[] = [
  { key: 'default', label: 'repairSheet.configTabs.default', icon: 'bolt' },
  { key: 'custom', label: 'repairSheet.configTabs.custom', icon: 'file' },
];

export const DEFAULT_INSTALLATION_DATA: InstallationOptionsData = {
  installLocation: 'default',
  customPath: '',
  existingBinaryPath: '',
  binaryTestResult: 'untested',
};
