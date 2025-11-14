import { Injectable } from '@angular/core';
import { RcConfigOption } from '@app/types';
import { TauriBaseService } from '../core/tauri-base.service';

type RCloneOptionsInfo = Record<string, RcConfigOption[]>;

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
  async getOptionBlocks(): Promise<string[]> {
    try {
      const response = await this.invokeCommand<{ options: string[] }>('get_option_blocks');
      return response.options;
    } catch (error) {
      console.error('Failed to get RClone option blocks:', error);
      return [];
    }
  }

  async getAllOptionsInfo(): Promise<RCloneOptionsInfo> {
    try {
      const response = await this.invokeCommand<RCloneOptionsInfo>('get_all_options_info');
      return response;
    } catch (error) {
      console.error('Failed to get all RClone options info:', error);
      return {};
    }
  }

  async setRCloneOption(block: string, option: string, value: unknown): Promise<void> {
    try {
      await this.invokeCommand('set_rclone_option', {
        blockName: block,
        optionName: option,
        value,
      });
    } catch (error) {
      console.error(`Failed to set RClone option ${block}.${option}:`, error);
      throw error;
    }
  }

  /**
   * Load the current RClone config file path
   * This is used to ensure backend options are tied to the correct config
   */
  async loadRcloneConfigFile(): Promise<string> {
    try {
      const path = await this.invokeCommand<string>('get_rclone_config_file');
      return path;
    } catch (error) {
      console.error('Failed to get RClone config file:', error);
      throw error;
    }
  }

  /**
   * Load all RClone backend options from the separate store
   */
  async loadOptions(): Promise<Record<string, Record<string, unknown>>> {
    try {
      const options = await this.invokeCommand<Record<string, Record<string, unknown>>>(
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
      await this.invokeCommand('save_rclone_backend_options', { options });
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

  /**
   * Get the path to the RClone backend options store file
   */
  async getStorePath(): Promise<string> {
    try {
      const path = await this.invokeCommand<string>('get_rclone_backend_store_path');
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

  async removeOption(service: string, option: string): Promise<void> {
    await this.invokeCommand('remove_rclone_backend_option', { block: service, option });
  }
}
