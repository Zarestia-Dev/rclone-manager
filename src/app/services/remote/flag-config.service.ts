import { isAbortError } from 'src/app/shared/utils/abortable-request.util';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import {
  FLAG_TYPES,
  FlagType,
  RcConfigOption,
  GroupedRCloneOptions,
  OPERATION_REGISTRY,
} from '@app/types';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { MountManagementService } from '../operations/mount-management.service';
import { ServeManagementService } from '../operations/serve-management.service';
import { staticFlagDefinitions } from './flag-definitions';
import { MemoizedLoader, memoizedLoader } from './utils/memoized-loader.util';

const SYNC_FLAG_TYPES: ReadonlySet<string> = new Set(
  OPERATION_REGISTRY.filter(op => op.isSyncType).map(op => op.key)
);

@Injectable({
  providedIn: 'root',
})
export class FlagConfigService extends TauriBaseService {
  private readonly mountManagementService = inject(MountManagementService);
  private readonly serveManagementService = inject(ServeManagementService);

  private readonly mountTypesLoader: MemoizedLoader<string[]> = memoizedLoader(() =>
    this.mountManagementService.getMountTypes()
  );
  readonly mountTypes = this.mountTypesLoader.signal;

  private readonly serveTypesLoader: MemoizedLoader<string[]> = memoizedLoader(() =>
    this.serveManagementService.getServeTypes()
  );
  readonly availableServeTypes = this.serveTypesLoader.signal;

  private readonly fieldLoaders = new Map<FlagType, MemoizedLoader<RcConfigOption[]>>();
  private readonly allFlagFieldsLoader: MemoizedLoader<Record<FlagType, RcConfigOption[]>> =
    memoizedLoader(
      async () => this.loadConfigFields(FLAG_TYPES) as Promise<Record<FlagType, RcConfigOption[]>>
    );
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

  constructor() {
    super();
    const events = inject(EventListenersService);
    events
      .listenToBackendSwitched()
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.invalidate());
    events
      .listenToVaultState()
      .pipe(takeUntilDestroyed())
      .subscribe(state => {
        if (state.isLocked) this.invalidate();
      });
    inject(DestroyRef).onDestroy(() => this.invalidate());
  }

  private invalidate(): void {
    this.mountTypesLoader.invalidate();
    this.serveTypesLoader.invalidate();
    this.allFlagFieldsLoader.invalidate();
    this.groupedOptionsLoader.invalidate();
    for (const loader of this.serveFlagsLoaders().values()) loader.invalidate();
    for (const loader of this.fieldLoaders.values()) loader.invalidate();
  }

  private getOrCreateServeFlagsLoader(serveType: string): MemoizedLoader<RcConfigOption[]> {
    const existing = this.serveFlagsLoaders().get(serveType);
    if (existing) return existing;

    const loader = memoizedLoader(async () => {
      try {
        const [flags, serveTypes] = await Promise.all([
          this.invokeCommand<RcConfigOption[]>('get_serve_flags', { serveType }),
          this.serveTypesLoader.load(),
        ]);
        const staticFlags = (staticFlagDefinitions['serve'] || []).map(option => ({ ...option }));
        const combined = [...staticFlags, ...(flags ?? [])];
        this.decorateServeTypeOption(combined, serveTypes);
        return combined;
      } catch (error) {
        if (!isAbortError(error))
          console.error(`Error loading serve flags for ${serveType}:`, error);
        throw error;
      }
    });

    const next = new Map(this.serveFlagsLoaders());
    next.set(serveType, loader);
    this.serveFlagsLoaders.set(next);
    return loader;
  }

  async getMountTypes(): Promise<string[]> {
    return this.mountTypesLoader.load();
  }

  async getServeTypes(): Promise<string[]> {
    return this.serveTypesLoader.load();
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

  /** Loads only requested sections, sharing the same cache with full configuration editors. */
  async loadConfigFields(
    types: readonly FlagType[]
  ): Promise<Partial<Record<FlagType, RcConfigOption[]>>> {
    const entries = await Promise.all(
      [...new Set(types)].map(async type => {
        if (type === 'serve') return [type, await this.loadServeFlagFields('http')] as const;
        let loader = this.fieldLoaders.get(type);
        if (!loader) {
          loader = memoizedLoader(async () => {
            const [dynamic, mountTypes] = await Promise.all([
              this.loadFlagFields(type),
              type === 'mount' ? this.mountTypesLoader.load() : Promise.resolve([]),
            ]);
            const fields = [
              ...(staticFlagDefinitions[type] ?? []).map(field => ({ ...field })),
              ...dynamic,
            ];
            const mount = fields.find(
              field => field.Name === 'mountType' || field.FieldName === 'mountType'
            );
            if (mount && mountTypes.length) {
              mount.Examples = mountTypes.map(value => ({
                Value: value,
                Help: this.translate.instant(`mount_type_${value}.title`),
              }));
            }
            return fields;
          });
          this.fieldLoaders.set(type, loader);
        }
        return [type, await loader.load()] as const;
      })
    );
    return Object.fromEntries(entries);
  }

  private decorateServeTypeOption(options: RcConfigOption[], serveTypes: string[]): void {
    const sOpt = options.find(f => f.Name === 'type' || f.FieldName === 'type');
    if (sOpt && serveTypes.length) {
      sOpt.Examples = serveTypes.map(t => ({
        Value: t,
        Help: this.translate.instant(`serve_type_${t}.title`) || t,
      }));
    }
  }
}
