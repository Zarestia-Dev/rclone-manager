import { Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { Observable } from 'rxjs';

/**
 * Service for handling installations of rclone and plugins
 * Manages the provisioning and setup of required components
 */
@Injectable({
  providedIn: 'root'
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
  listenToMountPluginInstalled(): Observable<any> {
    return this.listenToEvent<any>('mount_plugin_installed');
  }
}
