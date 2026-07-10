import { Injectable, computed, signal } from '@angular/core';
import {
  FLAG_TYPES,
  FlagType,
  RcConfigOption,
  GroupedRCloneOptions,
  OPERATION_REGISTRY,
} from '@app/types';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { staticFlagDefinitions } from './flag-definitions';
import { MemoizedLoader, memoizedLoader } from './utils/memoized-loader.util';

@Injectable({
  providedIn: 'root',
})
export class FlagConfigService extends TauriBaseService {
  // ── Single-value memoized loaders ──────────────────────────────────────────
  // Each helper deduplicates concurrent loads (in-flight promise) and caches
  // the resolved value in a readonly signal.

  private readonly allFlagFieldsLoader: MemoizedLoader<Record<FlagType, RcConfigOption[]>> =
    memoizedLoader(async (): Promise<Record<FlagType, RcConfigOption[]>> => {
      const result: Partial<Record<FlagType, RcConfigOption[]>> = {};
      await Promise.all(
        FLAG_TYPES.map(async type => {
          const dynamicFlags = await this.loadFlagFields(type);
          const staticFlags = staticFlagDefinitions[type] || [];
          result[type] = [...staticFlags, ...dynamicFlags];
        })
      );
      return result as Record<FlagType, RcConfigOption[]>;
    });
  readonly allFlagFields = this.allFlagFieldsLoader.signal;

  private readonly groupedOptionsLoader: MemoizedLoader<GroupedRCloneOptions> = memoizedLoader(
    (): Promise<GroupedRCloneOptions> =>
      this.invokeCommand<GroupedRCloneOptions>('get_grouped_options_with_values')
  );
  readonly groupedOptions = this.groupedOptionsLoader.signal;

  // ── Keyed (per-serveType) memoized loader ───────────────────────────────────
  // serve flags are keyed by serveType (http, webdav, sftp, …), so we keep a
  // Map of independent loaders and aggregate their signals into a single
  // Map<string, RcConfigOption[]> for consumers.

  private readonly serveFlagsLoaders = new Map<string, MemoizedLoader<RcConfigOption[]>>();
  // Bumps when a new serveType loader is created so the aggregate computed
  // re-runs and picks up the new entry.
  private readonly serveFlagsLoaderVersion = signal(0);
  readonly serveFlagsMap = computed<Map<string, RcConfigOption[]>>(() => {
    this.serveFlagsLoaderVersion();
    const map = new Map<string, RcConfigOption[]>();
    for (const [serveType, loader] of this.serveFlagsLoaders) {
      const flags = loader.signal();
      if (flags) map.set(serveType, flags);
    }
    return map;
  });

  private getOrCreateServeFlagsLoader(serveType: string): MemoizedLoader<RcConfigOption[]> {
    let loader = this.serveFlagsLoaders.get(serveType);
    if (!loader) {
      loader = memoizedLoader(async (): Promise<RcConfigOption[]> => {
        try {
          const flags = await this.invokeCommand<RcConfigOption[]>('get_serve_flags', {
            serveType,
          });
          const staticFlags = staticFlagDefinitions['serve'] || [];
          return [...staticFlags, ...(flags ?? [])];
        } catch (error) {
          console.error(`Error loading serve flags for ${serveType}:`, error);
          return [];
        }
      });
      this.serveFlagsLoaders.set(serveType, loader);
      this.serveFlagsLoaderVersion.update(v => v + 1);
    }
    return loader;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Fetches the master data object: all options, with live values, pre-grouped by the backend.
   */
  async getGroupedOptions(): Promise<GroupedRCloneOptions> {
    return this.groupedOptionsLoader.load();
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
    return this.allFlagFieldsLoader.load();
  }

  async loadFlagFields(type: FlagType): Promise<RcConfigOption[]> {
    try {
      const isSyncOperation = OPERATION_REGISTRY.some(op => op.key === type && op.isSyncType);
      if (isSyncOperation) {
        const flags = await this.invokeCommand<RcConfigOption[]>('get_operation_flags', {
          operation: type,
        });
        return flags ?? [];
      }
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
    return this.getOrCreateServeFlagsLoader(serveType).load();
  }
}
