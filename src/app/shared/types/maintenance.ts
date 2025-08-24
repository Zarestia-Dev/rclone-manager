export interface RepairData {
  type:
    | 'rclone_path'
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
