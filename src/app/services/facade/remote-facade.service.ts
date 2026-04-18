import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
  Signal,
  WritableSignal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { merge, tap, concatMap, from, of } from 'rxjs';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { JobManagementService } from '../operations/job-management.service';
import { MountManagementService } from '../operations/mount-management.service';
import { ServeManagementService } from '../operations/serve-management.service';
import { RemoteManagementService } from '../remote/remote-management.service';
import { RemoteFileOperationsService } from '../remote/remote-file-operations.service';
import { RemoteMetadataService } from '../remote/remote-metadata.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { FileSystemService } from '../operations/file-system.service';
import { NautilusService } from '../ui/nautilus.service';
import { BackendService } from '../infrastructure/system/backend.service';
import { UiStateService } from '../ui/state/ui-state.service';
import { isLocalPath, getRemoteNameFromFs } from '../remote/utils/remote-config.utils';
import {
  Remote,
  JobInfo,
  MountedRemote,
  ServeListItem,
  RemoteSettings,
  SyncOperationType,
  ActionState,
  RemoteAction,
  DiskUsage,
  Origin,
  RemoteOperationState,
  RemoteFeatures,
  RemoteConfig,
  ConfigRecord,
  PrimaryActionType,
  REMOTE_CONFIG_KEYS,
  BackendsRemotesLayout,
  RemotesLayout,
} from '@app/types';

type ProfileConfigMap = Record<string, Record<string, unknown>>;

interface RemoteState {
  base: WritableSignal<Omit<Remote, 'status' | 'features'>>;
  disk: WritableSignal<DiskUsage>;
  enriched: Signal<Remote>;
}

@Injectable({ providedIn: 'root' })
export class RemoteFacadeService extends TauriBaseService {
  private readonly jobService = inject(JobManagementService);
  private readonly mountService = inject(MountManagementService);
  private readonly serveService = inject(ServeManagementService);
  private readonly remoteService = inject(RemoteManagementService);
  private readonly remoteOpsService = inject(RemoteFileOperationsService);
  private readonly metadataService = inject(RemoteMetadataService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly eventListeners = inject(EventListenersService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly nautilusService = inject(NautilusService);
  private readonly backendService = inject(BackendService);
  private readonly uiStateService = inject(UiStateService);
  private readonly destroyRef = inject(DestroyRef);

  readonly jobs = this.jobService.jobs;
  readonly mountedRemotes = this.mountService.mountedRemotes;
  readonly runningServes = this.serveService.runningServes;

  private readonly remoteNames = signal<string[]>([]);
  private readonly remoteSettings = signal<Record<string, RemoteSettings>>({});
  private readonly isLoading = signal(false);
  private backgroundLoadGeneration = 0;

  // Consolidated per-remote state
  private readonly remoteStates = new Map<string, RemoteState>();

  // Single signal for all action states — no Map-of-signals hack needed
  private readonly _actionInProgress = signal<Record<string, ActionState[]>>({});
  readonly actionInProgress = this._actionInProgress.asReadonly();

  readonly loading = this.isLoading.asReadonly();

  readonly activeRemotes = computed(() =>
    this.remoteNames()
      .map(name => this.remoteStates.get(name)?.enriched())
      .filter((r): r is Remote => !!r)
  );

  readonly selectedRemote = computed(() => {
    const name = this.uiStateService.selectedRemote()?.name;
    return this.activeRemotes().find(r => r.name === name);
  });

  // --- Layout ---
  private readonly _remoteLayout = signal<RemotesLayout>({ order: [], hidden: [] });

  private readonly hiddenSet = computed(() => new Set(this._remoteLayout().hidden));

  /** All remotes in saved order, hidden ones included */
  private readonly orderedRemotes = computed(() => {
    const { order } = this._remoteLayout();
    const activeMap = new Map(this.activeRemotes().map(r => [r.name, r]));
    const seen = new Set<string>();
    const result: Remote[] = [];

    for (const name of order) {
      const remote = activeMap.get(name);
      if (remote) {
        result.push(remote);
        seen.add(name);
      }
    }
    // Append remotes not yet in the saved layout
    for (const remote of this.activeRemotes()) {
      if (!seen.has(remote.name)) result.push(remote);
    }
    return result;
  });

  /** Ordered and filtered (visible only) remotes for general UI consumption */
  readonly orderedVisibleRemotes = computed(() =>
    this.orderedRemotes().filter(r => !this.hiddenSet().has(r.name))
  );

  /** All remotes in custom order, including hidden ones (for the layout editor) */
  readonly allRemotesForEditor = this.orderedRemotes;

  /** Names of remotes that are hidden in the current backend */
  readonly hiddenRemoteNames = computed(() => [...this.hiddenSet()]);

  constructor() {
    super();

    this.eventListeners
      .listenToRcloneEngineReady()
      .pipe(
        takeUntilDestroyed(),
        tap(() => this.refreshAll())
      )
      .subscribe();

    merge(
      this.eventListeners.listenToRemoteCacheUpdated(),
      this.eventListeners.listenToRemoteSettingsChanged()
    )
      .pipe(
        takeUntilDestroyed(),
        tap(() => this.loadRemotes())
      )
      .subscribe();

    // Reload layout when backend switches
    this.appSettingsService.options$.pipe(takeUntilDestroyed()).subscribe(() => {
      this.loadRemotesLayout(this.backendService.activeBackend());
    });
  }

  // --- Settings ---

  getRemoteSettings(remoteName: string): RemoteSettings {
    return (this.remoteSettings()[remoteName] ?? {}) as RemoteSettings;
  }

  async updateRemoteSettings(remoteName: string, updates: Partial<RemoteSettings>): Promise<void> {
    const current = this.getRemoteSettings(remoteName);
    const updated = { ...current, ...updates };
    await this.appSettingsService.saveRemoteSettings(remoteName, updated);
  }

  // --- Disk Usage ---

  updateDiskUsage(remoteName: string, usage: Partial<DiskUsage>): void {
    this.getOrCreateRemoteState(remoteName).disk.update(cur => ({ ...cur, ...usage }));
  }

  async getCachedOrFetchDiskUsage(
    remoteName: string,
    normalizedName?: string,
    source: Origin = 'dashboard',
    group?: string,
    forceRefresh = false
  ): Promise<DiskUsage | null> {
    const features = await this.metadataService.getFeatures(remoteName, source);
    const state = this.getOrCreateRemoteState(remoteName);

    if (features.error) {
      state.disk.update(cur => ({
        ...cur,
        loading: false,
        error: true,
        errorMessage: features.error,
      }));
      return null;
    }
    if (!features.hasAbout) {
      state.disk.update(cur => ({ ...cur, notSupported: true, loading: false, error: false }));
      return null;
    }

    const cached = state.disk();
    if (!forceRefresh && cached.total_space !== undefined && !cached.loading && !cached.error) {
      return cached;
    }

    const fsName = normalizedName ?? `${remoteName}:`;
    state.disk.update(cur => ({ ...cur, loading: true, error: false, total_space: undefined }));

    try {
      const usage = await this.remoteOpsService.getDiskUsage(fsName, undefined, source, group);
      const result: DiskUsage = {
        total_space: usage.total ?? -1,
        used_space: usage.used ?? -1,
        free_space: usage.free ?? -1,
        loading: false,
        error: false,
        notSupported: false,
      };
      state.disk.set(result);
      return result;
    } catch (error) {
      state.disk.update(cur => ({
        ...cur,
        loading: false,
        error: true,
        errorMessage: String(error),
      }));
      return null;
    }
  }

  // --- Data Loading ---

  async loadRemotes(): Promise<void> {
    try {
      const [configs, settings] = await Promise.all([
        this.remoteService.getAllRemoteConfigs(),
        this.appSettingsService.getRemoteSettings(),
      ]);

      const incomingNames = Object.keys(configs);
      const currentNames = Array.from(this.remoteStates.keys());

      // 1. Remove stale remotes
      for (const name of currentNames) {
        if (!configs[name]) {
          this.remoteStates.delete(name);
          this.metadataService.clearCache(name);
        }
      }

      let newAdded = false;

      // 2. Update or Create remotes
      for (const name of incomingNames) {
        const config = { name, ...(configs[name] as Record<string, unknown>) } as RemoteConfig;
        const state = this.remoteStates.get(name);

        if (state) {
          // If config changed, clear cache and reload features
          if (JSON.stringify(state.base().config) !== JSON.stringify(config)) {
            this.metadataService.clearCache(name);
            void this.metadataService.getFeatures(name);
          }
          state.base.update(b => ({ ...b, config }));
        } else {
          newAdded = true;
          this.getOrCreateRemoteState(name, config, settings[name] as RemoteSettings);
        }
      }

      this.remoteNames.set(incomingNames);
      this.remoteSettings.set(settings);
      this.loadRemotesLayout(this.backendService.activeBackend());

      if (newAdded) this.loadDiskUsageInBackground();
    } catch (error) {
      console.error('[RemoteFacadeService] Error loading remotes:', error);
    }
  }

  // --- Layout Operations ---

  private async loadRemotesLayout(backendName: string): Promise<void> {
    const allLayouts =
      (await this.appSettingsService.getSettingValue<BackendsRemotesLayout>(
        'runtime.remote_layouts'
      )) || {};

    let layout = allLayouts[backendName];

    // Migration/Default: If it's empty or the old array format, reset to new structure
    if (!layout || Array.isArray(layout)) {
      layout = { order: [], hidden: [] };
    }

    // Cleanup: Remove stale entries that don't exist in rclone config anymore
    const activeNames = new Set(this.remoteNames());
    layout.order = layout.order.filter(name => activeNames.has(name));
    layout.hidden = layout.hidden.filter(name => activeNames.has(name));

    this._remoteLayout.set(layout);
  }

  async saveCurrentLayout(backendName: string, newNames: string[]): Promise<void> {
    const allLayouts =
      (await this.appSettingsService.getSettingValue<BackendsRemotesLayout>(
        'runtime.remote_layouts'
      )) || {};

    const updatedLayout: RemotesLayout = {
      order: newNames,
      hidden: this._remoteLayout().hidden,
    };

    allLayouts[backendName] = updatedLayout;
    this._remoteLayout.set(updatedLayout);

    await this.appSettingsService.saveSetting('runtime', 'remote_layouts', allLayouts);
  }

  async toggleRemoteVisibility(backendName: string, remoteName: string): Promise<void> {
    const allLayouts =
      (await this.appSettingsService.getSettingValue<BackendsRemotesLayout>(
        'runtime.remote_layouts'
      )) || {};

    const currentLayout = this._remoteLayout();
    const currentOrder = this.orderedRemotes().map(r => r.name);
    const hiddenSet = new Set(currentLayout.hidden);

    if (hiddenSet.has(remoteName)) {
      hiddenSet.delete(remoteName);
    } else {
      hiddenSet.add(remoteName);
    }

    const updatedLayout: RemotesLayout = {
      order: currentOrder,
      hidden: Array.from(hiddenSet),
    };

    allLayouts[backendName] = updatedLayout;
    this._remoteLayout.set(updatedLayout);

    await this.appSettingsService.saveSetting('runtime', 'remote_layouts', allLayouts);
  }

  async refreshAll(): Promise<void> {
    this.isLoading.set(true);
    try {
      await Promise.all([
        this.mountService.getMountedRemotes(),
        this.serveService.refreshServes(),
        this.jobService.refreshJobs(),
        this.loadRemotes(),
      ]);
      this.loadDiskUsageInBackground();
    } finally {
      this.isLoading.set(false);
    }
  }

  // --- Action State ---

  getActionSignal(remoteName: string): Signal<ActionState[]> {
    return computed(() => this._actionInProgress()[remoteName] ?? []);
  }

  diskUsageSignal(remoteName: string): Signal<DiskUsage> {
    return this.getOrCreateRemoteState(remoteName).disk;
  }

  featuresSignal(remoteName: string): Signal<RemoteFeatures> {
    return this.metadataService.getFeaturesSignal(remoteName);
  }

  getActionState(remoteName: string): ActionState[] {
    return this._actionInProgress()[remoteName] ?? [];
  }

  isActionInProgress(remoteName: string, action: RemoteAction, profileName?: string): boolean {
    return this.getActionState(remoteName).some(
      a => a.type === action && a.profileName === profileName
    );
  }

  async executeAction<T>(
    remoteName: string,
    action: RemoteAction,
    operation: () => Promise<T>,
    profileName?: string,
    operationType?: PrimaryActionType
  ): Promise<T> {
    this.addAction(remoteName, { type: action, profileName, operationType });
    try {
      return await operation();
    } finally {
      this.removeAction(remoteName, action, profileName, operationType);
    }
  }

  private addAction(remoteName: string, entry: ActionState): void {
    this._actionInProgress.update(state => ({
      ...state,
      [remoteName]: [...(state[remoteName] ?? []), entry],
    }));
  }

  private removeAction(
    remoteName: string,
    action: RemoteAction,
    profileName?: string,
    operationType?: PrimaryActionType
  ): void {
    this._actionInProgress.update(state => ({
      ...state,
      [remoteName]: (state[remoteName] ?? []).filter(
        a =>
          !(
            a.type === action &&
            a.profileName === profileName &&
            (operationType === undefined || a.operationType === operationType)
          )
      ),
    }));
  }

  // --- Operations ---

  async startJob(
    remoteName: string,
    opType: SyncOperationType | 'mount' | 'serve',
    profileName?: string,
    source: Origin = 'dashboard',
    noCache?: boolean
  ): Promise<void> {
    const settings = this.getRemoteSettings(remoteName);
    const configKey = REMOTE_CONFIG_KEYS[
      opType as keyof typeof REMOTE_CONFIG_KEYS
    ] as keyof RemoteSettings;
    const profiles = settings[configKey] as Record<string, Record<string, unknown>> | undefined;
    const targetProfile =
      profileName ?? (profiles?.['default'] ? 'default' : Object.keys(profiles ?? {})[0]);

    if (!targetProfile || !profiles?.[targetProfile]) {
      throw new Error(`Configuration for ${opType} not found on ${remoteName}.`);
    }

    await this.executeAction(
      remoteName,
      opType as RemoteAction,
      () => this.dispatchJobStart(opType, remoteName, targetProfile, source, noCache),
      targetProfile,
      opType
    );
  }

  private dispatchJobStart(
    opType: SyncOperationType | 'mount' | 'serve',
    remoteName: string,
    profile: string,
    source: Origin,
    noCache?: boolean
  ): Promise<unknown> {
    switch (opType) {
      case 'mount':
        return this.mountService.mountRemoteProfile(remoteName, profile, source, noCache);
      case 'serve':
        return this.serveService.startServeProfile(remoteName, profile);
      case 'sync':
        return this.jobService.startSyncProfile(remoteName, profile, source, noCache);
      case 'copy':
        return this.jobService.startCopyProfile(remoteName, profile, source, noCache);
      case 'bisync':
        return this.jobService.startBisyncProfile(remoteName, profile, source, noCache);
      case 'move':
        return this.jobService.startMoveProfile(remoteName, profile, source, noCache);
      default:
        throw new Error(`Unsupported operation: ${opType}`);
    }
  }

  async stopJob(
    remoteName: string,
    type: SyncOperationType | 'mount' | 'serve',
    serveId?: string,
    profileName?: string
  ): Promise<void> {
    await this.executeAction(
      remoteName,
      'stop',
      () => this.dispatchJobStop(remoteName, type, serveId, profileName),
      profileName,
      type
    );
  }

  private async dispatchJobStop(
    remoteName: string,
    type: SyncOperationType | 'mount' | 'serve',
    serveId?: string,
    profileName?: string
  ): Promise<void> {
    if (type === 'serve') {
      const serves = this.runningServes().filter(
        s => getRemoteNameFromFs(s.params?.fs) === remoteName
      );
      const idToStop = serveId ?? serves.find(s => s.profile === profileName)?.id ?? serves[0]?.id;
      if (!idToStop) throw new Error('Serve ID required to stop serve');
      await this.serveService.stopServe(idToStop, remoteName);
      return;
    }

    if (type === 'mount') {
      const mounts = this.mountedRemotes().filter(m => getRemoteNameFromFs(m.fs) === remoteName);
      const mountPoint =
        mounts.find(m => (profileName ? m.profile === profileName : true))?.mount_point ??
        mounts[0]?.mount_point;
      if (!mountPoint) throw new Error(`Active mount not found for ${remoteName}`);
      await this.mountService.unmountRemote(mountPoint, remoteName);
      return;
    }

    const groupName = profileName
      ? `${type}/${remoteName}/${profileName}`
      : `${type}/${remoteName}`;
    await this.jobService.stopJobsByGroup(groupName);
  }

  async unmountRemote(remoteName: string): Promise<void> {
    await this.executeAction(remoteName, 'unmount', async () => {
      const mount = this.mountedRemotes().find(m => getRemoteNameFromFs(m.fs) === remoteName);
      if (!mount) throw new Error(`No mount point found for ${remoteName}`);
      await this.mountService.unmountRemote(mount.mount_point, remoteName);
    });
  }

  async deleteRemote(remoteName: string): Promise<void> {
    await this.executeAction(remoteName, 'delete', async () => {
      await this.remoteService.deleteRemote(remoteName);
      await this.refreshAll();
      this.notificationService.showSuccess(
        this.translate.instant('backendSuccess.remote.deleted', { name: remoteName })
      );
    });
  }

  async openRemoteInFiles(remoteName: string, pathOrOperation?: string): Promise<void> {
    let path = pathOrOperation ?? '';
    if (['mount', 'sync', 'copy', 'bisync', 'move', 'serve'].includes(path)) {
      const settings = this.getRemoteSettings(remoteName);
      const configKey = REMOTE_CONFIG_KEYS[path as keyof typeof REMOTE_CONFIG_KEYS];
      const profiles = settings[configKey as keyof RemoteSettings] as ProfileConfigMap | undefined;
      path = ((profiles ? Object.values(profiles)[0]?.['dest'] : undefined) as string) ?? '';
    }

    if (isLocalPath(path)) {
      await this.executeAction(remoteName, 'open', () => this.fileSystemService.openInFiles(path));
    } else {
      await this.executeAction(remoteName, 'open', async () => {
        const colonIdx = path.indexOf(':');
        const targetRemoteName = colonIdx > -1 ? path.substring(0, colonIdx) : remoteName;
        const relativePath =
          colonIdx > -1
            ? path.substring(colonIdx + 1).replace(/^\/+/, '')
            : path.replace(/^\/+/, '');

        await this.nautilusService.newNautilusWindow(targetRemoteName, relativePath);
      });
    }
  }

  generateUniqueRemoteName(baseName: string): string {
    const existing = Array.from(this.remoteStates.keys());
    let name = baseName;
    let i = 1;
    while (existing.includes(name)) name = `${baseName}-${i++}`;
    return name;
  }

  async cloneRemote(remoteName: string): Promise<RemoteSettings | null> {
    const base = this.remoteStates.get(remoteName)?.base() as
      | Omit<Remote, 'status' | 'features'>
      | undefined;
    if (!base) return null;

    const newName = this.generateUniqueRemoteName(base.name.replace(/-\d+$/, ''));
    const settings = structuredClone(this.getRemoteSettings(remoteName)) as RemoteSettings;

    for (const configKey of Object.values(REMOTE_CONFIG_KEYS)) {
      const profiles = settings[configKey as keyof RemoteSettings] as ProfileConfigMap | undefined;
      if (profiles) {
        for (const profile of Object.values(profiles)) {
          if (
            typeof profile['source'] === 'string' &&
            getRemoteNameFromFs(profile['source']) === remoteName
          ) {
            profile['source'] = (profile['source'] as string).replace(
              `${remoteName}:`,
              `${newName}:`
            );
          }
        }
      }
    }

    return {
      config: { ...(base.config as ConfigRecord), name: newName },
      name: newName,
      ...settings,
    } as RemoteSettings;
  }

  async deleteJob(jobId: number): Promise<void> {
    await this.jobService.deleteJob(jobId);
  }

  loadDiskUsageInBackground(remotes?: Remote[]): void {
    const generation = ++this.backgroundLoadGeneration;
    const targets = (remotes ?? this.activeRemotes()).filter(
      r =>
        !r.status.diskUsage.error &&
        !r.status.diskUsage.notSupported &&
        r.status.diskUsage.total_space === undefined
    );
    if (!targets.length) return;

    from(targets)
      .pipe(
        concatMap(remote => {
          if (generation !== this.backgroundLoadGeneration) return of(null);
          return from(this.getCachedOrFetchDiskUsage(remote.name));
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe({
        error: e => console.error('[RemoteFacadeService] Background loading error:', e),
      });
  }

  // --- Private Signal Accessors ---

  private getOrCreateRemoteState(
    name: string,
    config?: RemoteConfig,
    settings?: RemoteSettings
  ): RemoteState {
    let state = this.remoteStates.get(name);
    if (!state) {
      const baseSig = signal<Omit<Remote, 'status' | 'features'>>({
        name,
        type: config?.type ?? '',
        config: config ?? { name, type: '' },
        primaryActions: (settings?.['primaryActions'] as PrimaryActionType[]) ?? [],
      });

      state = {
        base: baseSig,
        disk: signal<DiskUsage>({ loading: true, error: false }),
        enriched: this.createEnrichedSignal(name, baseSig),
      };
      this.remoteStates.set(name, state);

      // Background load features if we just created it
      void this.metadataService.getFeatures(name);
    }
    return state;
  }

  // --- Enriched Remote Construction ---

  private createEnrichedSignal(
    name: string,
    baseSig: WritableSignal<Omit<Remote, 'status' | 'features'>>
  ): Signal<Remote> {
    return computed(() => {
      const state = this.remoteStates.get(name);
      if (!state) return { ...baseSig(), status: {} as any, features: {} as any };

      const enriched = this.enrichRemote(
        baseSig(),
        this.jobService.jobsByRemote()[name] ?? [],
        this.mountService.mountsByRemote()[name] ?? [],
        this.serveService.servesByRemote()[name] ?? [],
        (this.remoteSettings()[name] ?? {}) as RemoteSettings
      );

      return {
        ...enriched,
        status: { ...enriched.status, diskUsage: state.disk() },
        features: this.metadataService.getFeaturesSignal(name)(),
      };
    });
  }

  private enrichRemote(
    base: Omit<Remote, 'status' | 'features'>,
    jobs: JobInfo[],
    mounts: MountedRemote[],
    serves: ServeListItem[],
    settings: RemoteSettings
  ): Omit<Remote, 'features'> {
    const getProfiles = (key: keyof typeof REMOTE_CONFIG_KEYS) =>
      (settings[REMOTE_CONFIG_KEYS[key]] ?? {}) as ProfileConfigMap;

    const mountConfigs = getProfiles('mount');
    const serveConfigs = getProfiles('serve');

    return {
      ...base,
      config: (settings['config'] as RemoteConfig) || base.config,
      primaryActions: (settings['primaryActions'] as PrimaryActionType[]) ?? [],
      status: {
        diskUsage: { loading: true },
        sync: this.buildOperationState('sync', jobs, settings),
        copy: this.buildOperationState('copy', jobs, settings),
        bisync: this.buildOperationState('bisync', jobs, settings),
        move: this.buildOperationState('move', jobs, settings),
        mount: {
          ...buildStatusEntry(
            mounts,
            Object.keys(mountConfigs),
            mountConfigs,
            m => m.profile,
            m => m.mount_point
          ),
        },
        serve: {
          ...buildStatusEntry(
            serves,
            Object.keys(serveConfigs),
            serveConfigs,
            s => s.profile,
            s => s.id
          ),
          count: serves.length,
          serves,
        },
      },
    };
  }

  private buildOperationState(
    type: SyncOperationType,
    jobs: JobInfo[],
    settings: RemoteSettings
  ): RemoteOperationState {
    const typeJobs = jobs.filter(j => j.job_type === type);
    const running = typeJobs.filter(j => j.status === 'Running');
    const profiles = (settings[REMOTE_CONFIG_KEYS[type]] ?? {}) as ProfileConfigMap;
    const profileNames = Object.keys(profiles);

    const latest =
      typeJobs.length > 0 ? [...typeJobs].sort((a, b) => b.jobid - a.jobid)[0] : undefined;

    return {
      ...buildStatusEntry(
        running,
        profileNames,
        profiles,
        j => j.profile,
        j => j.jobid
      ),
      jobId: running[0]?.jobid ?? latest?.jobid,
      lastRunProfiles: buildActiveProfiles(
        typeJobs,
        profileNames,
        j => j.profile,
        j => j.jobid
      ),
    };
  }
}

// --- Module-level pure helpers (no `this` dependency) ---

function buildStatusEntry<T, V>(
  items: T[],
  profileNames: string[],
  profiles: ProfileConfigMap,
  getProfile: (i: T) => string | null | undefined,
  getValue: (i: T) => V
): {
  active: boolean;
  activeProfiles: Record<string, V>;
  configuredProfiles: string[];
  profileBrowsePaths: Record<string, string[]>;
} {
  return {
    active: items.length > 0,
    activeProfiles: buildActiveProfiles(items, profileNames, getProfile, getValue),
    configuredProfiles: profileNames,
    profileBrowsePaths: buildProfileBrowsePaths(profiles),
  };
}

function buildProfileBrowsePaths(profileMap: ProfileConfigMap): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [name, config] of Object.entries(profileMap)) {
    const paths = [config['dest'], config['path']].filter(
      v => typeof v === 'string' && v.length > 0
    ) as string[];

    if (paths.length > 0) {
      result[name] = Array.from(new Set(paths));
    }
  }
  return result;
}

function buildActiveProfiles<T, V>(
  items: T[],
  profileNames: string[],
  getProfile: (i: T) => string | null | undefined,
  getValue: (i: T) => V
): Record<string, V> {
  const result: Record<string, V> = {};
  const fallback = profileNames[0] ?? 'default';
  for (const item of items) {
    const profile = getProfile(item)?.trim();
    const target = profile && profile.length > 0 ? profile : fallback;
    if (!(target in result)) result[target] = getValue(item);
  }
  return result;
}
