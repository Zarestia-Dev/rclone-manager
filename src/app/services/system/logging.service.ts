import { Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';

/**
 * Service for managing rclone logs
 * Handles log retrieval and cleanup operations
 */
@Injectable({
  providedIn: 'root',
})
export class LoggingService extends TauriBaseService {
  /**
   * Get logs for a specific remote
   */
  async getRemoteLogs(remoteName: string): Promise<string[]> {
    return this.invokeCommand<string[]>('get_remote_logs', { remoteName });
  }

  /**
   * Clear logs for a specific remote
   */
  async clearRemoteLogs(remoteName: string): Promise<void> {
    await this.invokeCommand('clear_logs_for_remote', { remoteName });
    console.log(`Logs for ${remoteName} cleared successfully.`);
  }
}
