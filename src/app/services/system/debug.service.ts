import { Injectable, inject } from '@angular/core';
import { ApiClientService } from '../core/api-client.service';
import { NotificationService } from '../ui/notification.service';
import { NautilusService } from '../ui/nautilus.service';

/**
 * Debug information returned from backend
 */
export interface DebugInfo {
  logsDir: string;
  configDir: string;
  cacheDir: string;
  mode: string;
  appVersion: string;
  platform: string;
  arch: string;
}

/**
 * Service for debugging and troubleshooting tools
 */
@Injectable({
  providedIn: 'root',
})
export class DebugService {
  private readonly apiClient = inject(ApiClientService);
  private readonly notificationService = inject(NotificationService);
  private readonly nautilusService = inject(NautilusService);

  /**
   * Get debug information (paths, versions, build info)
   */
  async getDebugInfo(): Promise<DebugInfo> {
    return this.apiClient.invoke<DebugInfo>('get_debug_info');
  }

  /**
   * Open a folder in the system file manager
   * @param folderType - Type of folder: 'logs', 'config', or 'cache'
   */
  async openFolder(folderType: 'logs' | 'config' | 'cache'): Promise<void> {
    try {
      // First get the debug info to get the actual paths
      const debugInfo = await this.getDebugInfo();
      let path: string;

      switch (folderType) {
        case 'logs':
          path = debugInfo.logsDir;
          break;
        case 'config':
          path = debugInfo.configDir;
          break;
        case 'cache':
          path = debugInfo.cacheDir;
          break;
      }

      // Use the existing open_in_files command
      if (this.apiClient.isHeadless()) {
        // In headless mode, use the in-app Nautilus file browser
        this.nautilusService.openPath(path);
      } else {
        // In desktop mode, use the system file explorer
        await this.apiClient.invoke<string>('open_in_files', { path });
      }
    } catch (error) {
      console.error('Failed to open folder:', error);
      this.notificationService.openSnackBar(`Failed to open ${folderType} folder`, 'Close');
      throw error;
    }
  }

  /**
   * Open developer tools
   * - Desktop (Tauri): Opens WebView DevTools via backend command
   * - Headless (Browser): Shows instruction to use F12 (can't programmatically open browser DevTools)
   */
  async openDevTools(): Promise<void> {
    if (this.apiClient.isHeadless()) {
      // Browser mode - can't programmatically open DevTools, show instruction
      this.notificationService.openSnackBar(
        'Press F12 or right-click → Inspect to open browser DevTools',
        'OK',
        5000
      );
      return;
    }

    // Tauri desktop mode - call backend to open WebView DevTools
    try {
      await this.apiClient.invoke<string>('open_devtools');
    } catch (error) {
      console.error('Failed to open DevTools:', error);
      this.notificationService.openSnackBar('Failed to open DevTools', 'Close');
      throw error;
    }
  }

  /**
   * Copy all debug information to clipboard as formatted text
   */
  async copyDebugInfoToClipboard(): Promise<void> {
    try {
      const info = await this.getDebugInfo();
      const text = this.formatDebugInfo(info);
      await navigator.clipboard.writeText(text);
      this.notificationService.openSnackBar('Debug info copied to clipboard', 'Close');
    } catch (error) {
      console.error('Failed to copy debug info:', error);
      this.notificationService.openSnackBar('Failed to copy debug info', 'Close');
    }
  }

  /**
   * Format debug info as a readable string
   */
  private formatDebugInfo(info: DebugInfo): string {
    return `
=== Rclone Manager Debug Info ===
App Version: ${info.appVersion}
Mode: ${info.mode}
Platform: ${info.platform}
Architecture: ${info.arch}

=== Paths ===
Logs: ${info.logsDir}
Config: ${info.configDir}
Cache: ${info.cacheDir}
`.trim();
  }
}
