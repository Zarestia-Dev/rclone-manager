import { Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';

/**
 * Service for managing rclone logs
 * Handles log retrieval and cleanup operations
 */
@Injectable({
  providedIn: 'root'
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

  /**
   * Get all logs (if such functionality exists)
   */
  async getAllLogs(): Promise<Record<string, string[]>> {
    // This would need to be implemented in the backend if needed
    throw new Error('getAllLogs not implemented yet');
  }

  /**
   * Export logs to file
   */
  async exportLogs(remoteName: string, filePath: string): Promise<void> {
    // This would need to be implemented in the backend if needed
    throw new Error('exportLogs not implemented yet');
  }
}
