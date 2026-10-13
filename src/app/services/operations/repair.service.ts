import { inject, Injectable } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { InstallationService } from '../settings/installation.service';
import { BackendService } from '../infrastructure/system/backend.service';
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
  private readonly installationService = inject(InstallationService);
  private readonly backendService = inject(BackendService);

  readonly rcloneProgress = this.installationService.rcloneProgress;
  readonly mountPluginProgress = this.installationService.mountPluginProgress;
  private readonly repairUi = {
    rclone_binary: {
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
    rclone_version: {
      titleKey: 'repairSheet.titles.versionTooOld',
      messageKey: 'repairSheet.messages.versionTooOld',
      progressKey: 'repairSheet.progress.installingRclone',
      buttonTextKey: 'repairSheet.actions.installRclone',
      icon: 'download',
      details: [
        {
          icon: 'circle-info',
          labelKey: 'repairSheet.details.issueLabel',
          valueKey: 'repairSheet.details.rcloneVersion.issue',
        },
        {
          icon: 'download',
          labelKey: 'repairSheet.details.actionLabel',
          valueKey: 'repairSheet.details.rcloneVersion.action',
        },
      ],
    },
    mount_plugin: {
      titleKey: 'repairSheet.titles.missingMountPlugin',
      messageKey: 'repairSheet.messages.missingMountPlugin',
      progressKey: 'repairSheet.progress.installingPlugin',
      buttonTextKey: 'repairSheet.actions.installPlugin',
      icon: 'core',
      details: [
        {
          icon: 'circle-info',
          labelKey: 'repairSheet.details.issueLabel',
          valueKey: 'repairSheet.details.mountPlugin.issue',
        },
        {
          icon: 'core',
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
      icon: 'rotate-right',
      details: [
        {
          icon: 'circle-info',
          labelKey: 'repairSheet.details.issueLabel',
          valueKey: 'repairSheet.details.configCorrupt.issue',
        },
        {
          icon: 'rotate-right',
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
    rclone_auth: {
      titleKey: 'repairSheet.titles.authRequired',
      messageKey: 'repairSheet.messages.authRequired',
      progressKey: 'repairSheet.progress.restartingEngine',
      buttonTextKey: 'repairSheet.actions.restartEngine',
      icon: 'skull',
      details: [
        {
          icon: 'circle-info',
          labelKey: 'repairSheet.details.issueLabel',
          valueKey: 'repairSheet.details.rcloneAuth.issue',
        },
        {
          icon: 'skull',
          labelKey: 'repairSheet.details.actionLabel',
          valueKey: 'repairSheet.details.rcloneAuth.action',
        },
      ],
    },
    rclone_auth_remote: {
      titleKey: 'repairSheet.titles.authRequired',
      messageKey: 'repairSheet.messages.remoteAuthRequired',
      progressKey: 'repairSheet.progress.restartingEngine',
      buttonTextKey: 'repairSheet.actions.configureBackend',
      icon: 'lock',
      details: [
        {
          icon: 'circle-info',
          labelKey: 'repairSheet.details.issueLabel',
          valueKey: 'repairSheet.details.rcloneAuthRemote.issue',
        },
        {
          icon: 'lock',
          labelKey: 'repairSheet.details.actionLabel',
          valueKey: 'repairSheet.details.rcloneAuthRemote.action',
        },
      ],
    },
    rclone_port: {
      titleKey: 'repairSheet.titles.portInUse',
      messageKey: 'repairSheet.messages.portInUse',
      progressKey: 'repairSheet.progress.restartingEngine',
      buttonTextKey: 'repairSheet.actions.changePort',
      icon: 'server',
      details: [
        {
          icon: 'circle-info',
          labelKey: 'repairSheet.details.issueLabel',
          valueKey: 'repairSheet.details.rclonePort.issue',
        },
        {
          icon: 'rotate-right',
          labelKey: 'repairSheet.details.actionLabel',
          valueKey: 'repairSheet.details.rclonePort.action',
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
    return this.installationService.installRclone(path);
  }

  /**
   * Cancel in-progress rclone provisioning
   */
  async cancelRcloneRepair(): Promise<void> {
    return this.installationService.cancelRcloneInstall();
  }

  /**
   * Install the mount plugin
   */
  async repairMountPlugin(): Promise<string> {
    return this.installationService.installMountPlugin();
  }

  /**
   * Check if an error represents a user-initiated download cancellation
   */
  isCancellationError(error: unknown): boolean {
    return this.installationService.isCancellationError(error);
  }

  /**
   * Cancel in-progress mount plugin installation
   */
  async cancelMountPluginRepair(): Promise<void> {
    return this.installationService.cancelMountPluginInstall();
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
   * Clear the engine's auth-failed state so the poller can retry.
   *
   * This doesn't fix the underlying credentials — the user must open the
   * backend settings and correct them. We just clear the `FailedAuth`
   * phase so the engine isn't stuck; once the user saves updated
   * credentials, the engine will auto-restart on the next poll cycle.
   */
  async repairRcloneAuth(): Promise<void> {
    return this.invokeCommand('clear_engine_auth_error');
  }

  /**
   * Suggest the next available local TCP port.
   */
  async findNextAvailablePort(startPort?: number): Promise<number> {
    if (!this.isTauri) {
      return (startPort ?? 51900) + 1;
    }
    return this.invokeCommand<number>('find_available_port', { startPort });
  }

  /**
   * Check if a local TCP port is currently free/available.
   */
  async checkPortAvailable(port: number): Promise<boolean> {
    if (!this.isTauri) {
      return true;
    }
    return this.invokeCommand<boolean>('check_port_available', { port });
  }

  /**
   * Update the local backend port and restart the engine.
   */
  async repairRclonePort(newPort: number): Promise<void> {
    return this.backendService.updateLocalBackendPort(newPort);
  }

  /**
   * Execute repair based on repair data type
   * @param repairData The repair data containing type and other info
   * @note For repairs requiring additional parameters (e.g., custom installation path),
   *       call the specific repair method directly (e.g., repairRclonePath(customPath))
   */
  async executeRepair(repairData: RepairData): Promise<string | void> {
    switch (repairData.type) {
      case 'rclone_binary':
      case 'rclone_version':
        return this.repairRclonePath();
      case 'mount_plugin':
        return this.repairMountPlugin();
      case 'config_corrupt':
        return this.repairConfigCorrupt();
      case 'backend_unreachable':
        return this.repairBackendUnreachable();
      case 'rclone_auth':
        return this.repairRcloneAuth();
      case 'rclone_port':
        if (repairData.port) {
          return this.repairRclonePort(repairData.port);
        }
        return Promise.resolve();
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
   * @param isRemote Whether the active backend is a remote backend
   */
  getRepairTitleKey(repairType: RepairData['type'], isRemote?: boolean): string {
    return this.getRepairUi(repairType, isRemote).titleKey;
  }

  /**
   * Get repair message key based on repair type
   * @param repairType The type of repair
   * @param isRemote Whether the active backend is a remote backend
   */
  getRepairMessageKey(repairType: RepairData['type'], isRemote?: boolean): string {
    return this.getRepairUi(repairType, isRemote).messageKey;
  }

  /**
   * Get repair progress text based on repair type
   * @param repairType The type of repair being performed
   * @param isRemote Whether the active backend is a remote backend
   */
  getRepairProgressTextKey(repairType: RepairData['type'], isRemote?: boolean): string {
    return this.getRepairUi(repairType, isRemote).progressKey;
  }

  /**
   * Get repair button text based on repair type
   * @param repairType The type of repair to be performed
   * @param isRemote Whether the active backend is a remote backend
   */
  getRepairButtonTextKey(repairType: RepairData['type'], isRemote?: boolean): string {
    return this.getRepairUi(repairType, isRemote).buttonTextKey;
  }

  /**
   * Get repair button icon based on repair type
   * @param repairType The type of repair to be performed
   * @param isRemote Whether the active backend is a remote backend
   */
  getRepairButtonIcon(repairType: RepairData['type'], isRemote?: boolean): string {
    return this.getRepairUi(repairType, isRemote).icon;
  }

  /**
   * Get repair details for display
   * @param repairType The type of repair
   * @param isRemote Whether the active backend is a remote backend
   */
  getRepairDetails(
    repairType: RepairData['type'],
    isRemote?: boolean
  ): readonly RepairDetailItem[] | null {
    return this.getRepairUi(repairType, isRemote).details;
  }

  private getRepairUi(
    repairType: RepairData['type'],
    isRemote?: boolean
  ): {
    titleKey: string;
    messageKey: string;
    progressKey: string;
    buttonTextKey: string;
    icon: string;
    details: readonly RepairDetailItem[] | null;
  } {
    if (repairType === 'rclone_auth' && isRemote) {
      return this.repairUi.rclone_auth_remote;
    }
    return this.repairUi[repairType] ?? this.defaultRepairUi;
  }
}
