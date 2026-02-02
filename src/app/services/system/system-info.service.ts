import { Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { RcloneInfo, MemoryStats, GlobalStats, BandwidthLimitResponse } from '@app/types';

/**
 * Service for system information and rclone engine management
 * Handles system stats, process management, and rclone info
 */
@Injectable({
  providedIn: 'root',
})
export class SystemInfoService extends TauriBaseService {
  /**
   * Get the build type (flatpak, deb, rpm, arch) or null for source builds
   */
  async getBuildType(): Promise<string | null> {
    return this.invokeCommand<string | null>('get_build_type');
  }

  /**
   * Check if updates are disabled for this build
   */
  async areUpdatesDisabled(): Promise<boolean> {
    return this.invokeCommand<boolean>('are_updates_disabled');
  }
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
   * Get memory statistics
   */
  async getMemoryStats(): Promise<MemoryStats> {
    return this.invokeCommand<MemoryStats>('get_memory_stats');
  }

  /**
   * Get core statistics
   */
  async getCoreStats(): Promise<GlobalStats> {
    return this.invokeCommand('get_core_stats');
  }

  /**
   * Get bandwidth limit
   */
  async getBandwidthLimit(): Promise<BandwidthLimitResponse> {
    return this.invokeCommand('get_bandwidth_limit');
  }

  /**
   * Set bandwidth limit
   */
  async setBandwidthLimit(rate?: string): Promise<BandwidthLimitResponse> {
    return this.invokeCommand('set_bandwidth_limit', { rate });
  }

  /**
   * Check if rclone is available on given path (default is empty string for system path)
   */
  async isRcloneAvailable(path = ''): Promise<boolean> {
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
}
