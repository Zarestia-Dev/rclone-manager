import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

/**
 * **RClone Backend Options Service**
 *
 * Manages RClone backend options stored in a separate file (backend.json)
 * This keeps RClone-specific runtime configurations separate from app settings
 */
@Injectable({
  providedIn: 'root',
})
export class RcloneBackendOptionsService {
  /**
   * Load all RClone backend options from the separate store
   */
  async loadOptions(): Promise<Record<string, Record<string, unknown>>> {
    try {
      const options = await invoke<Record<string, Record<string, unknown>>>(
        'load_rclone_backend_options'
      );
      return options;
    } catch (error) {
      console.error('Failed to load RClone backend options:', error);
      return {};
    }
  }

  /**
   * Save all RClone backend options to the separate store
   */
  async saveOptions(options: Record<string, Record<string, unknown>>): Promise<void> {
    try {
      await invoke('save_rclone_backend_options', { options });
    } catch (error) {
      console.error('Failed to save RClone backend options:', error);
      throw error;
    }
  }

  /**
   * Save a single RClone backend option (for immediate updates)
   *
   * @param block - The RClone block name (e.g., 'main', 'vfs', 'mount')
   * @param option - The option name in PascalCase (e.g., 'LogLevel', 'AskPassword')
   * @param value - The option value
   */
  async saveOption(block: string, option: string, value: unknown): Promise<void> {
    try {
      await invoke('save_rclone_backend_option', {
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
      await invoke('reset_rclone_backend_options');
    } catch (error) {
      console.error('Failed to reset RClone backend options:', error);
      throw error;
    }
  }

  /**
   * Get the path to the RClone backend options store file
   */
  async getStorePath(): Promise<string> {
    try {
      const path = await invoke<string>('get_rclone_backend_store_path');
      return path;
    } catch (error) {
      console.error('Failed to get RClone backend store path:', error);
      throw error;
    }
  }

  /**
   * Get a specific option value from a block
   *
   * @param block - The RClone block name
   * @param option - The option name
   * @param options - The loaded options object (optional, will load if not provided)
   */
  async getOption(
    block: string,
    option: string,
    options?: Record<string, Record<string, unknown>>
  ): Promise<unknown> {
    const opts = options || (await this.loadOptions());
    return opts[block]?.[option];
  }

  /**
   * Check if a specific option exists in the backend store
   *
   * @param block - The RClone block name
   * @param option - The option name
   * @param options - The loaded options object (optional, will load if not provided)
   */
  async hasOption(
    block: string,
    option: string,
    options?: Record<string, Record<string, unknown>>
  ): Promise<boolean> {
    const opts = options || (await this.loadOptions());
    return opts[block]?.[option] !== undefined;
  }
}
