import { Injectable, signal } from '@angular/core';
import { BandwidthLimitResponse, LocalDiskUsage, SystemStatusPayload } from '@app/types';
import { TauriBaseService } from '../platform/tauri-base.service';

/**
 * Service for system information and rclone engine management
 * Handles system stats, process management, and rclone info
 */
@Injectable({
  providedIn: 'root',
})
export class SystemInfoService extends TauriBaseService {
  readonly minRcloneVersion = signal<string>('1.70.0');

  /**
   * Check if running in librclone mode
   */
  async isLibrclone(): Promise<boolean> {
    return this.invokeCommand<boolean>('is_librclone');
  }

  /**
   * Check if network is metered
   */
  async isNetworkMetered(): Promise<boolean> {
    return this.invokeCommand<boolean>('is_network_metered');
  }

  /**
   * Quit rclone engine gracefully via API
   * Use for remote backends to avoid killing wrong local process
   */
  async quitRcloneEngine(): Promise<void> {
    return this.invokeCommand('quit_rclone_engine');
  }

  /**
   * Kill a process by PID
   * Safe to use for local backends, DO NOT use for remote backends
   */
  async killProcess(pid: number): Promise<void> {
    return this.invokeCommand('kill_process_by_pid', { pid });
  }

  /**
   * Stop rclone: if `pid` provided, kill that PID; otherwise request graceful quit via RC.
   */
  async stopRclone(pid?: number): Promise<void> {
    return this.invokeCommand('stop_rclone', { pid });
  }

  /**
   * Get consolidated system status snapshot.
   * Use this for deterministic state hydration before relying on event stream.
   */
  async getSystemStatusSnapshot(): Promise<SystemStatusPayload> {
    return this.invokeCommand<SystemStatusPayload>('get_system_status_snapshot');
  }

  /**
   * Get or set bandwidth limit.
   * Without a rate, this queries the current RC value.
   */
  async bandwidthLimit(rate?: string): Promise<BandwidthLimitResponse> {
    return this.invokeCommand('bandwidth_limit', { rate });
  }

  /**
   * Check if rclone is available on given path (default is empty string for system path)
   */
  async isRcloneAvailable(path = ''): Promise<boolean> {
    if (await this.isLibrclone()) {
      return true;
    }
    return this.invokeCommand<boolean>('check_rclone_available', { path });
  }

  /**
   * Run garbage collection
   */
  async runGarbageCollector(): Promise<void> {
    return this.invokeCommand('run_garbage_collector');
  }

  /**
   * Get the number of entries in the filesystem cache
   */
  async getFsCacheEntries(): Promise<number> {
    return this.invokeCommand<number>('get_fscache_entries');
  }

  /**
   * Clear the filesystem cache
   */
  async clearFsCache(): Promise<void> {
    return this.invokeCommand('clear_fscache');
  }

  /**
   * Get local disk usage for a directory using rclone's core/du endpoint
   * Returns Available, Free, and Total bytes for a local directory
   * Useful for checking space on mount points
   */
  async getLocalDiskUsage(dir?: string): Promise<LocalDiskUsage> {
    return this.invokeCommand<LocalDiskUsage>('get_local_disk_usage', { dir });
  }

  /**
   * Set the system poller visibility state
   */
  async setPollerVisibility(visible: boolean): Promise<void> {
    return this.invokeCommand('set_poller_visibility', { visible });
  }
}
