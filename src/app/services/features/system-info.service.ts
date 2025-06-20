import { Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { Observable } from 'rxjs';
import { RcloneInfo } from '../../shared/components/types';

/**
 * Service for system information and rclone engine management
 * Handles system stats, process management, and rclone info
 */
@Injectable({
  providedIn: 'root'
})
export class SystemInfoService extends TauriBaseService {

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
    return this.invokeCommand('kill_process', { pid });
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
   * Listen to rclone API ready events
   */
  listenToRcloneApiReady(): Observable<any> {
    return this.listenToEvent<any>('rclone_api_ready');
  }

  /**
   * Listen to rclone engine failure events
   */
  listenToRcloneEngineFailed(): Observable<any> {
    return this.listenToEvent<any>('rclone_engine_failed');
  }

  /**
   * Listen to rclone path invalid events
   */
  listenToRclonePathInvalid(): Observable<any> {
    return this.listenToEvent<any>('rclone_path_invalid');
  }
}
