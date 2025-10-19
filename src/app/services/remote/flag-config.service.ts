import { Injectable } from '@angular/core';
import { FieldType, FlagField, FlagType, RcConfigOption } from '@app/types';
import { invoke } from '@tauri-apps/api/core';
import { getDefaultValueForType } from 'src/app/shared/remote-config/remote-config-types';

// Define the shape of the grouped data returned by our new Rust command
type GroupedRCloneOptions = Record<string, Record<string, RcConfigOption[]>>;

/**
 * **Rclone Configuration Service**
 *
 * This is the single, authoritative service for managing all global Rclone backend options and flags.
 * It communicates directly with our optimized Rust backend.
 */
@Injectable({
  providedIn: 'root',
})
export class FlagConfigService {
  // A cache for our master data object to prevent redundant backend calls.
  private groupedOptionsCache: GroupedRCloneOptions | null = null;

  public readonly FLAG_TYPES: FlagType[] = [
    'mount',
    'copy',
    'sync',
    'filter',
    'vfs',
    'backend',
    'move',
  ];

  // --- Primary Data Fetching ---

  /**
   * Fetches the master data object: all options, with live values, pre-grouped by the backend.
   * This is the main entry point for loading configuration data.
   */
  async getGroupedOptions(): Promise<GroupedRCloneOptions> {
    if (this.groupedOptionsCache) {
      return this.groupedOptionsCache;
    }
    const response = await invoke<GroupedRCloneOptions>('get_grouped_options_with_values');
    console.log('Fetched and cached grouped RClone options:', response);
    this.groupedOptionsCache = response;
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

  /**
   * Saves a single Rclone option. The backend handles building the nested JSON.
   * @param block The top-level block (e.g., "rc").
   * @param fullFieldName The full, dotted FieldName (e.g., "HTTP.TLSCert").
   * @param value The new value to set.
   */
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

  /**
   * Clears the internal cache, forcing a full refresh on the next data request.
   */
  clearCache(): void {
    this.groupedOptionsCache = null;
  }

  // --- Flag Fetching for Specific Commands (from flag-config.service.ts) ---

  /**
   * Loads all flag fields for all defined flag types.
   */
  async loadAllFlagFields(): Promise<Record<FlagType, FlagField[]>> {
    const result: Record<FlagType, FlagField[]> = {} as any;
    await Promise.all(
      this.FLAG_TYPES.map(async type => {
        result[type] = await this.loadFlagFields(type);
      })
    );
    return result;
  }

  /**
   * Loads and maps flags for a single type (e.g., 'copy', 'sync') by calling the specific Rust command.
   */
  private async loadFlagFields(type: FlagType): Promise<FlagField[]> {
    try {
      // Dynamically create the command name (e.g., 'get_copy_flags')
      const command = `get_${type}_flags`;
      const flags = await invoke<any[]>(command);
      return this.mapFlagFields(flags);
    } catch (error) {
      console.error(`Error loading ${type} flags:`, error);
      return [];
    }
  }

  // --- Helper and Utility Functions (from flag-config.service.ts) ---
  // These are still very useful and are kept here.

  private mapFlagFields(fields: any[]): FlagField[] {
    return fields.map(field => ({
      ValueStr: field.ValueStr ?? '',
      Value: field.Value ?? null,
      name: field.FieldName || field.Name,
      default: field.Default || null,
      help: field.Help || 'No description available',
      type: field.Type || 'string',
      required: field.Required || false,
      examples: field.Examples || [],
    }));
  }

  toggleOption(
    selectedOptions: Record<string, any>,
    fields: FlagField[],
    fieldName: string
  ): Record<string, any> {
    const newOptions = { ...selectedOptions };
    const field = fields.find(f => f.name === fieldName);

    if (!field) {
      return newOptions;
    }
    if (newOptions[fieldName] !== undefined) {
      delete newOptions[fieldName];
    } else {
      newOptions[fieldName] = this.getFlagValue(field);
    }

    return newOptions;
  }

  private getFlagValue(field: FlagField): any {
    let value =
      field.Value !== null
        ? field.Value
        : field.ValueStr !== undefined
          ? field.ValueStr
          : field.default !== null
            ? field.default
            : getDefaultValueForType(field.type as FieldType);

    if (field.type === 'Tristate') {
      value = false;
    }

    return this.coerceValueToType(value, field.type as FieldType);
  }

  validateFlagOptions(
    jsonString: string,
    fields: FlagField[]
  ): { valid: boolean; cleanedOptions?: Record<string, any> } {
    try {
      const parsedValue = jsonString ? JSON.parse(jsonString) : {};
      const cleanedValue: Record<string, any> = {};

      for (const [key, value] of Object.entries(parsedValue)) {
        const field = fields.find(f => f.name === key);
        if (field) {
          cleanedValue[key] = this.coerceValueToType(value, field.type as FieldType);
        }
      }

      return { valid: true, cleanedOptions: cleanedValue };
    } catch (error) {
      console.error('Invalid JSON format:', error);
      return { valid: false };
    }
  }

  private capitalizeFirstLetter(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  coerceValueToType(value: any, type: FieldType): any {
    if (value === null || value === undefined || value === '') {
      return getDefaultValueForType(type);
    }
    try {
      switch (type) {
        case 'bool':
          return String(value).trim().toLowerCase() === 'true';
        case 'int':
        case 'int64':
        case 'uint32':
        case 'SizeSuffix': {
          const intValue = parseInt(value, 10);
          return isNaN(intValue) ? getDefaultValueForType(type) : intValue;
        }
        case 'stringArray':
          if (Array.isArray(value)) return value;
          if (typeof value === 'string')
            return value
              .split(',')
              .map(item => item.trim())
              .filter(Boolean);
          return [String(value)];
        case 'Tristate':
          if (String(value).toLowerCase() === 'true') return true;
          if (String(value).toLowerCase() === 'false') return false;
          return value; // Keep 'unset' or other values as is
        default:
          return value;
      }
    } catch (error) {
      console.warn(`Failed to coerce value '${value}' to type '${type}'`, error);
      return getDefaultValueForType(type);
    }
  }
}
