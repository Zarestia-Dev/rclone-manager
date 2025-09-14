import { Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { RcloneInfo } from '@app/types';

/**
 * Service for system information and rclone engine management
 * Handles system stats, process management, and rclone info
 */
@Injectable({
  providedIn: 'root',
})
export class SystemInfoService extends TauriBaseService {
  /**
   * Check if network is metered
   */
  async isNetworkMetered(): Promise<boolean> {
    return this.invokeCommand<boolean>('is_network_metered');
  }
  /**
   * Get rclone information
   */
  async getRcloneInfo(): Promise<RcloneInfo | null> {
    return this.invokeCommand<RcloneInfo>('get_rclone_info');
  }

  /**
   * Get rclone process ID
   */
  async getRclonePID(): Promise<number | null> {
    return this.invokeCommand<number>('get_rclone_pid');
  }

  /**
   * Kill a process by PID
   */
  async killProcess(pid: number): Promise<void> {
    return this.invokeCommand('kill_process_by_pid', { pid });
  }

  /**
   * Get memory statistics
   */
  async getMemoryStats(): Promise<any> {
    return this.invokeCommand('get_memory_stats');
  }

  /**
   * Get core statistics
   */
  async getCoreStats(): Promise<any> {
    return this.invokeCommand('get_core_stats');
  }

  /**
   * Get bandwidth limit
   */
  async getBandwidthLimit(): Promise<any> {
    return this.invokeCommand('get_bandwidth_limit');
  }

  /**
   * Set bandwidth limit
   */
  async setBandwidthLimit(rate?: string): Promise<any> {
    return this.invokeCommand('set_bandwidth_limit', { rate });
  }

  /**
   * Check if rclone is available on given path (default is empty string for system path)
   */
  async isRcloneAvailable(path = ''): Promise<boolean> {
    return this.invokeCommand<boolean>('check_rclone_available', { path });
  }
}
