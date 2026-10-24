import { Injectable } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';

/**
 * **RClone Backend Options Service**
 *
 * Manages RClone backend options stored in a separate file (backend.json)
 * This keeps RClone-specific runtime configurations separate from app settings
 */
@Injectable({
  providedIn: 'root',
})
export class RcloneBackendOptionsService extends TauriBaseService {
  /**
   * Persist a single RClone option override. Live values are applied separately.
   *
   * @param block - The RClone block name (e.g., 'main', 'vfs', 'mount')
   * @param option - The option name in PascalCase (e.g., 'LogLevel', 'AskPassword')
   * @param value - The option value
   */
  async saveOption(block: string, option: string, value: unknown): Promise<void> {
    try {
      await this.invokeCommand('save_rclone_backend_option', {
        block,
        option,
        value,
      });
    } catch (error) {
      console.error(`Failed to save RClone option ${block}.${option}:`, error);
      throw error;
    }
  }

  /**
   * Reset all RClone backend options to defaults (empty)
   */
  async resetOptions(): Promise<void> {
    try {
      await this.invokeCommand('reset_rclone_backend_options');
    } catch (error) {
      console.error('Failed to reset RClone backend options:', error);
      throw error;
    }
  }

  async removeOption(service: string, option: string): Promise<void> {
    await this.invokeCommand('remove_rclone_backend_option', { block: service, option });
  }
}
