import { Injectable } from '@angular/core';
import { FLAG_TYPES, FlagType, RcConfigOption } from '@app/types';
import { TauriBaseService } from '../core/tauri-base.service';
import { staticFlagDefinitions } from './flag-definitions';

// Define the shape of the grouped data returned by our new Rust command
type GroupedRCloneOptions = Record<string, Record<string, RcConfigOption[]>>;

/**
 * **Rclone Configuration Service**
 *
 * This service manages Rclone backend options and command flags.
 */
@Injectable({
  providedIn: 'root',
})
export class FlagConfigService extends TauriBaseService {
  // A cache for our master data object to prevent redundant backend calls.

  /**
   * Fetches the master data object: all options, with live values, pre-grouped by the backend.
   */
  async getGroupedOptions(): Promise<GroupedRCloneOptions> {
    const response = await this.invokeCommand<GroupedRCloneOptions>(
      'get_grouped_options_with_values'
    );
    console.log('Fetched and cached grouped RClone options:', response);
    return response;
  }

  /**
   * Fetches the simple list of available option blocks (e.g., "main", "vfs").
   */
  async getOptionBlocks(): Promise<string[]> {
    try {
      // The Rust command returns `{ "options": [...] }` so we need to unpack it.
      const response = await this.invokeCommand<{ options: string[] }>('get_option_blocks');
      return response.options;
    } catch (error) {
      console.error('Failed to get RClone option blocks:', error);
      return [];
    }
  }

  async saveOption(block: string, fullFieldName: string, value: unknown): Promise<void> {
    try {
      await this.invokeCommand('set_rclone_option', {
        blockName: block,
        optionName: fullFieldName,
        value,
      });
    } catch (error) {
      console.error(`Failed to set RClone option ${block}.${fullFieldName}:`, error);
      throw error;
    }
  }

  /**
   * Loads all flag fields for all defined flag types.
   */
  async loadAllFlagFields(): Promise<Record<FlagType, RcConfigOption[]>> {
    const result: Partial<Record<FlagType, RcConfigOption[]>> = {};

    const commandTypeMap: Record<FlagType, FlagType> = {
      mount: 'mount',
      copy: 'copy',
      sync: 'sync',
      filter: 'filter',
      vfs: 'vfs',
      backend: 'backend',
      bisync: 'bisync',
      move: 'move',
    };

    await Promise.all(
      FLAG_TYPES.map(async type => {
        const cmdType = commandTypeMap[type] || type;
        const dynamicFlags = await this.loadFlagFields(cmdType);
        const staticFlags = staticFlagDefinitions[type] || [];
        result[type] = [...staticFlags, ...dynamicFlags];
      })
    );
    return result as Record<FlagType, RcConfigOption[]>;
  }

  private async loadFlagFields(type: FlagType): Promise<RcConfigOption[]> {
    try {
      const command = `get_${type}_flags`;
      const flags = await this.invokeCommand<RcConfigOption[]>(command);
      return flags ?? [];
    } catch (error) {
      console.error(`Error loading ${type} flags:`, error);
      return [];
    }
  }
}
