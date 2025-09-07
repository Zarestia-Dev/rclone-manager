import { Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';

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
    return this.invokeCommand<string>('provision_rclone', { path });
  }

  /**
   * Check if mount plugin is installed
   * @param retryCount Number of times to retry the check (for post-installation verification)
   */
  async isMountPluginInstalled(retryCount = 0): Promise<boolean> {
    try {
      const result = await this.invokeCommand<boolean>('check_mount_plugin_installed');

      // If we got false but this is a retry (indicating we just installed),
      // wait a bit and try again
      if (!result && retryCount > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.invokeCommand<boolean>('check_mount_plugin_installed');
      }

      return result;
    } catch (error) {
      console.error('Error checking mount plugin installation:', error);

      // If this is a retry attempt, don't retry again
      if (retryCount > 0) {
        throw error;
      }

      // For first attempt, assume not installed on error
      return false;
    }
  }

  /**
   * Install the mount plugin
   */
  async installMountPlugin(): Promise<string> {
    return this.invokeCommand<string>('install_mount_plugin');
  }
}
