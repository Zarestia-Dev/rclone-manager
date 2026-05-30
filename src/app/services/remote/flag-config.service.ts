import { Injectable, signal } from '@angular/core';
import { FLAG_TYPES, FlagType, RcConfigOption } from '@app/types';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { staticFlagDefinitions } from './flag-definitions';

type GroupedRCloneOptions = Record<string, Record<string, RcConfigOption[]>>;

@Injectable({
  providedIn: 'root',
})
export class FlagConfigService extends TauriBaseService {
  private readonly _allFlagFields = signal<Record<FlagType, RcConfigOption[]> | null>(null);
  readonly allFlagFields = this._allFlagFields.asReadonly();

  private readonly _groupedOptions = signal<GroupedRCloneOptions | null>(null);
  readonly groupedOptions = this._groupedOptions.asReadonly();

  private readonly _serveFlagsMap = signal<Map<string, RcConfigOption[]>>(new Map());
  readonly serveFlagsMap = this._serveFlagsMap.asReadonly();

  private allFlagFieldsPromise: Promise<Record<FlagType, RcConfigOption[]>> | null = null;
  private groupedOptionsPromise: Promise<GroupedRCloneOptions> | null = null;
  private readonly serveFlagsPromises = new Map<string, Promise<RcConfigOption[]>>();

  /**
   * Fetches the master data object: all options, with live values, pre-grouped by the backend.
   */
  async getGroupedOptions(): Promise<GroupedRCloneOptions> {
    const current = this._groupedOptions();
    if (current) return current;
    if (this.groupedOptionsPromise) return this.groupedOptionsPromise;

    this.groupedOptionsPromise = (async () => {
      try {
        const options = await this.invokeCommand<GroupedRCloneOptions>(
          'get_grouped_options_with_values'
        );
        this._groupedOptions.set(options);
        return options;
      } finally {
        this.groupedOptionsPromise = null;
      }
    })();

    return this.groupedOptionsPromise;
  }

  /**
   * Fetches the simple list of available option blocks (e.g., "main", "vfs").
   */
  async getOptionBlocks(): Promise<string[]> {
    try {
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
    const current = this._allFlagFields();
    if (current) return current;
    if (this.allFlagFieldsPromise) return this.allFlagFieldsPromise;

    this.allFlagFieldsPromise = (async () => {
      try {
        const result: Partial<Record<FlagType, RcConfigOption[]>> = {};

        await Promise.all(
          FLAG_TYPES.map(async type => {
            const dynamicFlags = await this.loadFlagFields(type);
            const staticFlags = staticFlagDefinitions[type] || [];
            result[type] = [...staticFlags, ...dynamicFlags];
          })
        );
        const finalResult = result as Record<FlagType, RcConfigOption[]>;
        this._allFlagFields.set(finalResult);
        return finalResult;
      } finally {
        this.allFlagFieldsPromise = null;
      }
    })();

    return this.allFlagFieldsPromise;
  }

  async loadFlagFields(type: FlagType): Promise<RcConfigOption[]> {
    try {
      const command = `get_${type}_flags`;
      const flags = await this.invokeCommand<RcConfigOption[]>(command);
      return flags ?? [];
    } catch (error) {
      console.error(`Error loading ${type} flags:`, error);
      return [];
    }
  }

  /**
   * Loads serve flags for a specific serve type (http, webdav, sftp, etc.)
   * Serve is unique because each serve type has different flags.
   */
  async loadServeFlagFields(serveType: string): Promise<RcConfigOption[]> {
    const currentMap = this._serveFlagsMap();
    if (currentMap.has(serveType)) return currentMap.get(serveType)!;

    const existing = this.serveFlagsPromises.get(serveType);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const flags = await this.invokeCommand<RcConfigOption[]>('get_serve_flags', {
          serveType,
        });
        const staticFlags = staticFlagDefinitions['serve'] || [];
        const finalFlags = [...staticFlags, ...(flags ?? [])];

        this._serveFlagsMap.update(map => {
          const next = new Map(map);
          next.set(serveType, finalFlags);
          return next;
        });

        return finalFlags;
      } catch (error) {
        console.error(`Error loading serve flags for ${serveType}:`, error);
        return [];
      } finally {
        this.serveFlagsPromises.delete(serveType);
      }
    })();

    this.serveFlagsPromises.set(serveType, promise);
    return promise;
  }
}
