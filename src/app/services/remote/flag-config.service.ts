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

const SYNC_FLAG_TYPES: ReadonlySet<string> = new Set(
  OPERATION_REGISTRY.filter(op => op.isSyncType).map(op => op.key)
);

@Injectable({
  providedIn: 'root',
})
export class FlagConfigService extends TauriBaseService {
  private readonly allFlagFieldsLoader: MemoizedLoader<Record<FlagType, RcConfigOption[]>> =
    memoizedLoader(async () => {
      const result = {} as Record<FlagType, RcConfigOption[]>;
      await Promise.all(
        FLAG_TYPES.map(async type => {
          const dynamicFlags = await this.loadFlagFields(type);
          const staticFlags = staticFlagDefinitions[type] || [];
          result[type] = [...staticFlags, ...dynamicFlags];
        })
      );
      return result;
    });
  readonly allFlagFields = this.allFlagFieldsLoader.signal;

  private readonly groupedOptionsLoader: MemoizedLoader<GroupedRCloneOptions> = memoizedLoader(() =>
    this.invokeCommand<GroupedRCloneOptions>('get_grouped_options_with_values')
  );
  readonly groupedOptions = this.groupedOptionsLoader.signal;

  // Per-serveType loader map kept inside a signal so the aggregate computed
  // re-evaluates automatically when loaders are added — no synthetic version
  // bump needed.
  private readonly serveFlagsLoaders = signal<
    ReadonlyMap<string, MemoizedLoader<RcConfigOption[]>>
  >(new Map());
  readonly serveFlagsMap = computed<Map<string, RcConfigOption[]>>(() => {
    const map = new Map<string, RcConfigOption[]>();
    for (const [serveType, loader] of this.serveFlagsLoaders()) {
      const flags = loader.signal();
      if (flags) map.set(serveType, flags);
    }
    return map;
  });

  private getOrCreateServeFlagsLoader(serveType: string): MemoizedLoader<RcConfigOption[]> {
    const existing = this.serveFlagsLoaders().get(serveType);
    if (existing) return existing;

    const loader = memoizedLoader(async () => {
      try {
        const flags = await this.invokeCommand<RcConfigOption[]>('get_serve_flags', {
          serveType,
        });
        const staticFlags = staticFlagDefinitions['serve'] || [];
        return [...staticFlags, ...(flags ?? [])];
      } catch (error) {
        console.error(`Error loading serve flags for ${serveType}:`, error);
        throw error;
      }
    });

    const next = new Map(this.serveFlagsLoaders());
    next.set(serveType, loader);
    this.serveFlagsLoaders.set(next);
    return loader;
  }

  async getGroupedOptions(): Promise<GroupedRCloneOptions> {
    return this.groupedOptionsLoader.load();
  }

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

  async loadAllFlagFields(): Promise<Record<FlagType, RcConfigOption[]>> {
    return this.allFlagFieldsLoader.load();
  }

  async loadFlagFields(type: FlagType): Promise<RcConfigOption[]> {
    try {
      if (SYNC_FLAG_TYPES.has(type)) {
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
      throw error;
    }
  }

  async loadServeFlagFields(serveType: string): Promise<RcConfigOption[]> {
    return this.getOrCreateServeFlagsLoader(serveType).load();
  }
}
