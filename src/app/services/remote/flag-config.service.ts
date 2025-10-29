import { Injectable } from '@angular/core';
import { FLAG_TYPES, FlagType, RcConfigOption } from '@app/types';
import { invoke } from '@tauri-apps/api/core';

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
export class FlagConfigService {
  // A cache for our master data object to prevent redundant backend calls.

  /**
   * Fetches the master data object: all options, with live values, pre-grouped by the backend.
   */
  async getGroupedOptions(): Promise<GroupedRCloneOptions> {
    const response = await invoke<GroupedRCloneOptions>('get_grouped_options_with_values');
    console.log('Fetched and cached grouped RClone options:', response);
    return response;
  }

  /**
   * Fetches the simple list of available option blocks (e.g., "main", "vfs").
   */
  async getOptionBlocks(): Promise<string[]> {
    try {
      // The Rust command returns `{ "options": [...] }` so we need to unpack it.
      const response = await invoke<{ options: string[] }>('get_option_blocks');
      return response.options;
    } catch (error) {
      console.error('Failed to get RClone option blocks:', error);
      return [];
    }
  }

  // --- Data Mutation ---

  async saveOption(block: string, fullFieldName: string, value: unknown): Promise<void> {
    try {
      await invoke('set_rclone_option', {
        blockName: block,
        optionName: fullFieldName,
        value,
      });
    } catch (error) {
      console.error(`Failed to set RClone option ${block}.${fullFieldName}:`, error);
      throw error;
    }
  }

  // --- Flag Fetching for Specific Commands ---

  /**
   * Loads all flag fields for all defined flag types.
   */
  async loadAllFlagFields(): Promise<Record<FlagType, RcConfigOption[]>> {
    const result: Partial<Record<FlagType, RcConfigOption[]>> = {};

    // Some flag types (bisync, move) don't have dedicated backend commands.
    // Reuse the 'copy' flags for those since their options largely overlap.
    const commandTypeMap: Record<FlagType, FlagType> = {
      mount: 'mount',
      copy: 'copy',
      sync: 'sync',
      filter: 'filter',
      vfs: 'vfs',
      backend: 'backend',
      bisync: 'copy',
      move: 'copy',
    };

    await Promise.all(
      FLAG_TYPES.map(async type => {
        const cmdType = commandTypeMap[type] || type;
        result[type] = await this.loadFlagFields(cmdType);
      })
    );
    return result as Record<FlagType, RcConfigOption[]>;
  }

  private async loadFlagFields(type: FlagType): Promise<RcConfigOption[]> {
    try {
      const command = `get_${type}_flags`;
      const flags = await invoke<RcConfigOption[]>(command);
      return flags ?? [];
    } catch (error) {
      console.error(`Error loading ${type} flags:`, error);
      return [];
    }
  }
}
