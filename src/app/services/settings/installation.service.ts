import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
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
   * Test if a given rclone path is valid and working
   * @param rclonePath Path to the rclone executable to test
   */
  async testRclonePath(rclonePath: string): Promise<boolean> {
    return this.invokeCommand<boolean>('test_rclone_path', { rclonePath });
  }

  /**
   * Set a custom rclone path and save it to settings
   * @param rclonePath Path to the rclone executable
   */
  async setRclonePath(rclonePath: string): Promise<string> {
    return this.invokeCommand<string>('set_rclone_path', { rclonePath });
  }

  /**
   * Get the default rclone config path
   */
  async getDefaultRcloneConfigPath(): Promise<string> {
    return this.invokeCommand<string>('get_default_rclone_config_path');
  }

  /**
   * Set rclone config path and save it to settings
   * @param configPath Path to the rclone config file
   */
  async setRcloneConfigPath(configPath: string): Promise<string> {
    return this.invokeCommand<string>('set_rclone_config_path', { configPath });
  }

  /**
   * Check if mount plugin is installed
   */
  async isMountPluginInstalled(): Promise<boolean> {
    return this.invokeCommand<boolean>('check_mount_plugin_installed');
  }

  /**
   * Install the mount plugin
   */
  async installMountPlugin(): Promise<string> {
    return this.invokeCommand<string>('install_mount_plugin');
  }

  /**
   * Listen to mount plugin installation events
   */
  listenToMountPluginInstalled(): Observable<unknown> {
    return this.listenToEvent<unknown>('mount_plugin_installed');
  }
}
