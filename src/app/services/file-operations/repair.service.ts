import { Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { RepairData } from '@app/types';

/**
 * Service for handling repair operations
 * Manages various system repair tasks including rclone installation,
 * plugin installation, config restoration, and API engine restart
 */
@Injectable({
  providedIn: 'root',
})
export class RepairService extends TauriBaseService {
  /**
   * Install or provision rclone binary
   * @param path Optional custom installation path. If null, uses default location
   */
  async repairRclonePath(path?: string | null): Promise<string> {
    return this.invokeCommand<string>('provision_rclone', { path });
  }

  /**
   * Install the mount plugin
   */
  async repairMountPlugin(): Promise<string> {
    return this.invokeCommand<string>('install_mount_plugin');
  }

  /**
   * Restore configuration from backup
   */
  async repairConfigCorrupt(): Promise<void> {
    return this.invokeCommand('restore_backup_config');
  }

  /**
   * Restart the API engine
   */
  async repairBackendUnreachable(): Promise<void> {
    return this.invokeCommand('restart_api_engine');
  }

  /**
   * Execute repair based on repair data type
   * @param repairData The repair data containing type and other info
   */
  async executeRepair(repairData: RepairData): Promise<string | void> {
    switch (repairData.type) {
      case 'rclone_path':
        return this.repairRclonePath();
      case 'mount_plugin':
        return this.repairMountPlugin();
      case 'config_corrupt':
        return this.repairConfigCorrupt();
      case 'backend_unreachable':
        return this.repairBackendUnreachable();
      case 'rclone_password':
        // Password handling is done in the component, this is a no-op
        return Promise.resolve();
      default:
        throw new Error(`Unknown repair type: ${repairData.type}`);
    }
  }

  /**
   * Get repair title key based on repair type
   * @param repairType The type of repair
   */
  getRepairTitleKey(repairType: string): string {
    switch (repairType) {
      case 'rclone_path':
        return 'repairSheet.titles.missingRclone';
      case 'mount_plugin':
        return 'repairSheet.titles.missingMountPlugin';
      case 'config_corrupt':
        return 'repairSheet.titles.corruptConfig';
      case 'backend_unreachable':
        return 'repairSheet.titles.backendError';
      case 'rclone_password':
        return 'repairSheet.titles.passwordRequired';
      default:
        return 'repairSheet.titles.systemIssue';
    }
  }

  /**
   * Get repair message key based on repair type
   * @param repairType The type of repair
   */
  getRepairMessageKey(repairType: string): string {
    switch (repairType) {
      case 'rclone_path':
        return 'repairSheet.messages.missingRclone';
      case 'mount_plugin':
        return 'repairSheet.messages.missingMountPlugin';
      case 'config_corrupt':
        return 'repairSheet.messages.corruptConfig';
      case 'backend_unreachable':
        return 'repairSheet.messages.backendError';
      case 'rclone_password':
        return 'repairSheet.messages.passwordRequired';
      default:
        return 'repairSheet.messages.defaultParams';
    }
  }

  /**
   * Get repair progress text based on repair type
   * @param repairType The type of repair being performed
   */
  getRepairProgressTextKey(repairType: string): string {
    switch (repairType) {
      case 'rclone_path':
        return 'repairSheet.progress.installingRclone';
      case 'mount_plugin':
        return 'repairSheet.progress.installingPlugin';
      case 'config_corrupt':
        return 'repairSheet.progress.restoringBackup';
      case 'backend_unreachable':
        return 'repairSheet.progress.restartingEngine';
      case 'rclone_password':
        return 'repairSheet.progress.applyingPassword';
      default:
        return 'repairSheet.progress.repairing';
    }
  }

  /**
   * Get repair button text based on repair type
   * @param repairType The type of repair to be performed
   */
  getRepairButtonTextKey(repairType: string): string {
    switch (repairType) {
      case 'rclone_path':
        return 'repairSheet.actions.installRclone';
      case 'mount_plugin':
        return 'repairSheet.actions.installPlugin';
      case 'config_corrupt':
        return 'repairSheet.actions.restoreBackup';
      case 'backend_unreachable':
        return 'repairSheet.actions.restartEngine';
      case 'rclone_password':
        return 'repairSheet.actions.submitPassword';
      default:
        return 'repairSheet.actions.repair';
    }
  }

  /**
   * Get repair button icon based on repair type
   * @param repairType The type of repair to be performed
   */
  getRepairButtonIcon(repairType: string): string {
    switch (repairType) {
      case 'rclone_path':
        return 'download';
      case 'mount_plugin':
        return 'puzzle-piece';
      case 'config_corrupt':
        return 'rotate-left';
      case 'backend_unreachable':
        return 'refresh';
      case 'rclone_password':
        return 'key';
      default:
        return 'wrench';
    }
  }

  /**
   * Get repair details for display
   * @param repairType The type of repair
   */
  getRepairDetails(
    repairType: string
  ): { icon: string; labelKey: string; valueKey: string }[] | null {
    switch (repairType) {
      case 'rclone_path':
        return [
          {
            icon: 'circle-info',
            labelKey: 'repairSheet.details.issueLabel',
            valueKey: 'repairSheet.details.rclonePath.issue',
          },
          {
            icon: 'download',
            labelKey: 'repairSheet.details.actionLabel',
            valueKey: 'repairSheet.details.rclonePath.action',
          },
        ];
      case 'mount_plugin':
        return [
          {
            icon: 'circle-info',
            labelKey: 'repairSheet.details.issueLabel',
            valueKey: 'repairSheet.details.mountPlugin.issue',
          },
          {
            icon: 'puzzle-piece',
            labelKey: 'repairSheet.details.actionLabel',
            valueKey: 'repairSheet.details.mountPlugin.action',
          },
        ];
      case 'config_corrupt':
        return [
          {
            icon: 'circle-info',
            labelKey: 'repairSheet.details.issueLabel',
            valueKey: 'repairSheet.details.configCorrupt.issue',
          },
          {
            icon: 'rotate-left',
            labelKey: 'repairSheet.details.actionLabel',
            valueKey: 'repairSheet.details.configCorrupt.action',
          },
        ];
      case 'backend_unreachable':
        return [
          {
            icon: 'circle-info',
            labelKey: 'repairSheet.details.issueLabel',
            valueKey: 'repairSheet.details.backendUnreachable.issue',
          },
          {
            icon: 'refresh',
            labelKey: 'repairSheet.details.actionLabel',
            valueKey: 'repairSheet.details.backendUnreachable.action',
          },
        ];
      case 'rclone_password':
        return [
          {
            icon: 'circle-info',
            labelKey: 'repairSheet.details.issueLabel',
            valueKey: 'repairSheet.details.rclonePassword.issue',
          },
          {
            icon: 'key',
            labelKey: 'repairSheet.details.actionLabel',
            valueKey: 'repairSheet.details.rclonePassword.action',
          },
        ];
      default:
        return null;
    }
  }
}
