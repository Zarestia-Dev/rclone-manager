import { Injectable } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';

/**
 * Service for handling installations of rclone and plugins
 * Manages the provisioning and setup of required components
 */
@Injectable({
  providedIn: 'root',
})
export class InstallationService extends TauriBaseService {
  /**
   * Install rclone to the system
   * @param path Optional custom installation path. If null, uses default location
   */
  async installRclone(path?: string | null): Promise<string> {
    return this.invokeWithNotification<string>(
      'provision_rclone',
      { path },
      {
        errorKey: 'repairSheet.errors.rcloneInstallFailed',
        errorParams: { errorKey: 'repairSheet.errors.rcloneInstallFailed' },
      }
    );
  }

  /**
   * Check if mount plugin is installed
   */
  async isMountPluginInstalled(): Promise<boolean> {
    try {
      return await this.invokeCommand<boolean>('check_mount_plugin_installed');
    } catch (error) {
      console.error('Error checking mount plugin installation:', error);

      const translatedError = this.backendTranslation.translateBackendMessage(error);
      this.notificationService.showError(
        `${this.translate.instant('repairSheet.messages.mountPluginStatusError')}: ${translatedError}`
      );

      return false;
    }
  }

  /**
   * Install the mount plugin
   */
  async installMountPlugin(): Promise<string> {
    return this.invokeWithNotification<string>('install_mount_plugin', undefined, {
      successKey: 'backendSuccess.rclone.mountPluginInstalled',
      errorKey: 'backendErrors.rclone.mountPluginInstallFailed',
    });
  }
}
