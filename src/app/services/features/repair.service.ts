import { Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { RepairData } from '../../shared/components/types';

/**
 * Service for handling repair operations
 * Manages various system repair tasks including rclone installation,
 * plugin installation, config restoration, and API engine restart
 */
@Injectable({
  providedIn: 'root'
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
      default:
        throw new Error(`Unknown repair type: ${repairData.type}`);
    }
  }

  /**
   * Get repair progress text based on repair type
   * @param repairType The type of repair being performed
   */
  getRepairProgressText(repairType: string): string {
    switch (repairType) {
      case 'rclone_path':
        return 'Installing rclone...';
      case 'mount_plugin':
        return 'Installing plugin...';
      case 'config_corrupt':
        return 'Restoring backup...';
      case 'backend_unreachable':
        return 'Restarting engine...';
      default:
        return 'Repairing...';
    }
  }

  /**
   * Get repair button text based on repair type
   * @param repairType The type of repair to be performed
   */
  getRepairButtonText(repairType: string): string {
    switch (repairType) {
      case 'rclone_path':
        return 'Install Rclone';
      case 'mount_plugin':
        return 'Install Plugin';
      case 'config_corrupt':
        return 'Restore Backup';
      case 'backend_unreachable':
        return 'Restart Engine';
      default:
        return 'Repair';
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
        return 'arrow-rotate-left';
      case 'backend_unreachable':
        return 'refresh';
      default:
        return 'wrench';
    }
  }

  /**
   * Get repair details for display
   * @param repairType The type of repair
   */
  getRepairDetails(repairType: string): Array<{icon: string, label: string, value: string}> | null {
    switch (repairType) {
      case 'rclone_path':
        return [
          { icon: 'circle-info', label: 'Issue', value: 'Rclone binary not found' },
          { icon: 'download', label: 'Action', value: 'Download and install rclone' }
        ];
      case 'mount_plugin':
        return [
          { icon: 'circle-info', label: 'Issue', value: 'Mount plugin missing' },
          { icon: 'puzzle-piece', label: 'Action', value: 'Install mount support plugin' }
        ];
      case 'config_corrupt':
        return [
          { icon: 'circle-info', label: 'Issue', value: 'Configuration file corrupted' },
          { icon: 'arrow-rotate-left', label: 'Action', value: 'Restore from backup' }
        ];
      case 'backend_unreachable':
        return [
          { icon: 'circle-info', label: 'Issue', value: 'API backend not responding' },
          { icon: 'refresh', label: 'Action', value: 'Restart API engine' }
        ];
      default:
        return null;
    }
  }
}
