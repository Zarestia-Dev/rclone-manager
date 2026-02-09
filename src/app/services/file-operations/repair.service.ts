import { Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { RepairData } from '@app/types';

/** Detail item structure for repair UI */
interface RepairDetailItem {
  icon: string;
  labelKey: string;
  valueKey: string;
}

/**
 * Service for handling repair operations
 * Manages various system repair tasks including rclone installation,
 * plugin installation, config restoration, and API engine restart
 */
@Injectable({
  providedIn: 'root',
})
export class RepairService extends TauriBaseService {
  private readonly repairUi = {
    rclone_path: {
      titleKey: 'repairSheet.titles.missingRclone',
      messageKey: 'repairSheet.messages.missingRclone',
      progressKey: 'repairSheet.progress.installingRclone',
      buttonTextKey: 'repairSheet.actions.installRclone',
      icon: 'download',
      details: [
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
      ],
    },
    mount_plugin: {
      titleKey: 'repairSheet.titles.missingMountPlugin',
      messageKey: 'repairSheet.messages.missingMountPlugin',
      progressKey: 'repairSheet.progress.installingPlugin',
      buttonTextKey: 'repairSheet.actions.installPlugin',
      icon: 'puzzle-piece',
      details: [
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
      ],
    },
    config_corrupt: {
      titleKey: 'repairSheet.titles.corruptConfig',
      messageKey: 'repairSheet.messages.corruptConfig',
      progressKey: 'repairSheet.progress.restoringBackup',
      buttonTextKey: 'repairSheet.actions.restoreBackup',
      icon: 'rotate-left',
      details: [
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
      ],
    },
    backend_unreachable: {
      titleKey: 'repairSheet.titles.backendError',
      messageKey: 'repairSheet.messages.backendError',
      progressKey: 'repairSheet.progress.restartingEngine',
      buttonTextKey: 'repairSheet.actions.restartEngine',
      icon: 'refresh',
      details: [
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
      ],
    },
    rclone_password: {
      titleKey: 'repairSheet.titles.passwordRequired',
      messageKey: 'repairSheet.messages.passwordRequired',
      progressKey: 'repairSheet.progress.applyingPassword',
      buttonTextKey: 'repairSheet.actions.submitPassword',
      icon: 'key',
      details: [
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
      ],
    },
  } as const;

  private readonly defaultRepairUi = {
    titleKey: 'repairSheet.titles.systemIssue',
    messageKey: 'repairSheet.messages.defaultParams',
    progressKey: 'repairSheet.progress.repairing',
    buttonTextKey: 'repairSheet.actions.repair',
    icon: 'wrench',
    details: null,
  } as const;

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
   * @note For repairs requiring additional parameters (e.g., custom installation path),
   *       call the specific repair method directly (e.g., repairRclonePath(customPath))
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
  getRepairTitleKey(repairType: RepairData['type']): string {
    return this.getRepairUi(repairType).titleKey;
  }

  /**
   * Get repair message key based on repair type
   * @param repairType The type of repair
   */
  getRepairMessageKey(repairType: RepairData['type']): string {
    return this.getRepairUi(repairType).messageKey;
  }

  /**
   * Get repair progress text based on repair type
   * @param repairType The type of repair being performed
   */
  getRepairProgressTextKey(repairType: RepairData['type']): string {
    return this.getRepairUi(repairType).progressKey;
  }

  /**
   * Get repair button text based on repair type
   * @param repairType The type of repair to be performed
   */
  getRepairButtonTextKey(repairType: RepairData['type']): string {
    return this.getRepairUi(repairType).buttonTextKey;
  }

  /**
   * Get repair button icon based on repair type
   * @param repairType The type of repair to be performed
   */
  getRepairButtonIcon(repairType: RepairData['type']): string {
    return this.getRepairUi(repairType).icon;
  }

  /**
   * Get repair details for display
   * @param repairType The type of repair
   */
  getRepairDetails(repairType: RepairData['type']): readonly RepairDetailItem[] | null {
    return this.getRepairUi(repairType).details;
  }

  private getRepairUi(repairType: RepairData['type']): {
    titleKey: string;
    messageKey: string;
    progressKey: string;
    buttonTextKey: string;
    icon: string;
    details: readonly RepairDetailItem[] | null;
  } {
    return this.repairUi[repairType] ?? this.defaultRepairUi;
  }
}
