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
import { isLocalPath } from '../remote/utils/remote-config.utils';
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
} from '@app/types';

@Injectable({ providedIn: 'root' })
export class RemoteFacadeService extends TauriBaseService {
  private jobService = inject(JobManagementService);
  private mountService = inject(MountManagementService);
  private serveService = inject(ServeManagementService);
  private remoteService = inject(RemoteManagementService);
  private remoteOpsService = inject(RemoteFileOperationsService);
  private metadataService = inject(RemoteMetadataService);
  private appSettingsService = inject(AppSettingsService);
  private eventListeners = inject(EventListenersService);
  private destroyRef = inject(DestroyRef);

  readonly jobs = this.jobService.jobs;
  readonly mountedRemotes = this.mountService.mountedRemotes;
  readonly runningServes = this.serveService.runningServes;

  private remoteNames = signal<string[]>([]);
  private remoteSettings = signal<Record<string, RemoteSettings>>({});
  private isLoading = signal(false);
  private backgroundLoadGeneration = 0;

  private remoteBaseSignals = new Map<
    string,
    WritableSignal<Omit<Remote, 'status' | 'features'>>
  >();
  private diskUsageSignals = new Map<string, WritableSignal<DiskUsage>>();
  private featuresSignals = new Map<string, WritableSignal<RemoteFeatures>>();
  private actionSignals = new Map<string, WritableSignal<ActionState[]>>();
  private enrichedSignals = new Map<string, Signal<Remote>>();
  private actionKeysVersion = signal(0);

  private jobsByRemote = computed(() => this.groupBy(this.jobs(), j => j.remote_name));
  private mountsByRemote = computed(() =>
    this.groupBy(this.mountedRemotes(), m => m.fs.split(':')[0])
  );
  private servesByRemote = computed(() =>
    this.groupBy(this.runningServes(), s => s.params?.fs?.split(':')[0] ?? '')
  );

  readonly loading = this.isLoading.asReadonly();

  readonly actionInProgress = computed(() => {
    this.actionKeysVersion();
    const map: Record<string, ActionState[]> = {};
    for (const [name, sig] of this.actionSignals) map[name] = sig();
    return map;
  });

  readonly activeRemotes = computed(() =>
    this.remoteNames()
      .map(name => this.enrichedSignals.get(name)?.())
      .filter((r): r is Remote => !!r)
  );

  constructor() {
    super();
    this.eventListeners
      .listenToRcloneEngineReady()
      .pipe(
        takeUntilDestroyed(),
        tap({
          next: () => this.refreshAll(),
        })
      )
      .subscribe();
    merge(
      this.eventListeners.listenToRemoteCacheUpdated(),
      this.eventListeners.listenToRemoteSettingsChanged()
    )
      .pipe(
        takeUntilDestroyed(),
        tap({
          next: () => this.loadRemotes(),
        })
      )
      .subscribe();
  }

  // --- Settings ---

  getRemoteSettings(remoteName: string): RemoteSettings {
    return this.remoteSettings()[remoteName] ?? {};
  }

  // --- Disk Usage ---

  updateDiskUsage(remoteName: string, usage: DiskUsage): void {
    this.diskUsageSignal(remoteName).update(cur => ({ ...cur, ...usage }));
  }

  async getCachedOrFetchDiskUsage(
    remoteName: string,
    normalizedName?: string,
    source: Origin = 'dashboard',
    forceRefresh = false
  ): Promise<DiskUsage | null> {
    const features = await this.metadataService.getFeatures(remoteName, source);
    const cached = this.diskUsageSignal(remoteName)();

    if (!forceRefresh) {
      if (!features.hasAbout) {
        this.updateDiskUsage(remoteName, { notSupported: true, loading: false, error: false });
        return null;
      }
      if (cached.total_space !== undefined && !cached.loading && !cached.error) return cached;
    }

    const fsName = normalizedName ?? `${remoteName}:`;
    this.updateDiskUsage(remoteName, { loading: true, error: false, total_space: undefined });

    try {
      if (!features.hasAbout) {
        this.updateDiskUsage(remoteName, { notSupported: true, loading: false, error: false });
        return null;
      }

      const usage = await this.remoteOpsService.getDiskUsage(fsName, undefined, source);
      const newUsage: DiskUsage = {
        total_space: usage.total ?? -1,
        used_space: usage.used ?? -1,
        free_space: usage.free ?? -1,
        loading: false,
        error: false,
        notSupported: false,
      };
      this.updateDiskUsage(remoteName, newUsage);
      return newUsage;
    } catch (error) {
      this.updateDiskUsage(remoteName, {
        loading: false,
        error: true,
        errorMessage: String(error),
      });
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
      const incomingSet = new Set(incomingNames);

      for (const name of this.remoteBaseSignals.keys()) {
        if (!incomingSet.has(name)) {
          this.remoteBaseSignals.delete(name);
          this.diskUsageSignals.delete(name);
          this.featuresSignals.delete(name);
          this.actionSignals.delete(name);
          this.enrichedSignals.delete(name);
        }
      }

      for (const name of incomingNames) {
        const config: RemoteConfig = {
          name,
          ...(configs[name] as Record<string, unknown>),
        } as RemoteConfig;
        const existing = this.remoteBaseSignals.get(name);

        if (existing) {
          existing.update(r => ({ ...r, config }));
        } else {
          const baseSig = signal<Omit<Remote, 'status' | 'features'>>({
            name,
            type: config.type,
            config,
            primaryActions:
              ((settings[name] as Record<string, unknown>)?.[
                'primaryActions'
              ] as PrimaryActionType[]) ?? [],
          });
          this.remoteBaseSignals.set(name, baseSig);
          this.enrichedSignals.set(name, this.createEnrichedSignal(name, baseSig));

          // Pre-fetch metadata/features
          this.metadataService.getFeatures(name).then(f => {
            this.featuresSignal(name).set(f);
          });
        }
      }

      this.remoteNames.set(incomingNames);
      this.remoteSettings.set(settings);
    } catch (error) {
      console.error('[RemoteFacadeService] Error loading remotes:', error);
    }
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
    return this.actionSignal(remoteName).asReadonly();
  }

  startAction(remoteName: string, action: RemoteAction, profileName?: string): void {
    this.actionSignal(remoteName).update(list => [...list, { type: action, profileName }]);
  }

  endAction(remoteName: string, action: RemoteAction, profileName?: string): void {
    this.actionSignal(remoteName).update(list =>
      list.filter(a => !(a.type === action && a.profileName === profileName))
    );
  }

  getActionState(remoteName: string): ActionState[] {
    return this.actionSignal(remoteName)();
  }

  isActionInProgress(remoteName: string, action: RemoteAction, profileName?: string): boolean {
    return this.actionSignal(remoteName)().some(
      a => a.type === action && a.profileName === profileName
    );
  }

  async executeAction<T>(
    remoteName: string,
    action: RemoteAction,
    operation: () => Promise<T>,
    profileName?: string
  ): Promise<T> {
    this.startAction(remoteName, action, profileName);
    try {
      return await operation();
    } finally {
      this.endAction(remoteName, action, profileName);
    }
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
    const profiles = settings[`${opType}Configs` as keyof RemoteSettings] as
      | Record<string, Record<string, unknown>>
      | undefined;
    const targetProfile =
      profileName ?? (profiles?.['default'] ? 'default' : Object.keys(profiles ?? {})[0]);

    if (!targetProfile || !profiles?.[targetProfile]) {
      throw new Error(`Configuration for ${opType} not found on ${remoteName}.`);
    }

    await this.executeAction(
      remoteName,
      opType as RemoteAction,
      async () => {
        const apiMap: Record<string, () => Promise<unknown>> = {
          mount: () =>
            this.mountService.mountRemoteProfile(remoteName, targetProfile, source, noCache),
          serve: () => this.serveService.startServeProfile(remoteName, targetProfile),
          sync: () => this.jobService.startSyncProfile(remoteName, targetProfile, source, noCache),
          copy: () => this.jobService.startCopyProfile(remoteName, targetProfile, source, noCache),
          bisync: () =>
            this.jobService.startBisyncProfile(remoteName, targetProfile, source, noCache),
          move: () => this.jobService.startMoveProfile(remoteName, targetProfile, source, noCache),
        };
        if (apiMap[opType]) await apiMap[opType]();
        else throw new Error(`Unsupported operation: ${opType}`);
      },
      targetProfile
    );
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
      async () => {
        if (type === 'serve') {
          const serves = this.runningServes().filter(s =>
            s.params?.fs?.startsWith(`${remoteName}:`)
          );
          const idToStop =
            serveId ?? serves.find(s => s.profile === profileName)?.id ?? serves[0]?.id;
          if (!idToStop) throw new Error('Serve ID required to stop serve');
          await this.serveService.stopServe(idToStop, remoteName);
        } else if (type === 'mount') {
          const mounts = this.mountedRemotes().filter(m => m.fs.startsWith(`${remoteName}:`));
          const mountPoint = profileName
            ? mounts.find(m => m.profile === profileName)?.mount_point
            : mounts[0]?.mount_point;
          if (!mountPoint) throw new Error(`Active mount not found for ${remoteName}`);
          await this.mountService.unmountRemote(mountPoint, remoteName);
        } else {
          const groupName = profileName
            ? `${type}/${remoteName}/${profileName}`
            : `${type}/${remoteName}`;
          await this.jobService.stopJobsByGroup(groupName);
          await this.jobService.deleteStatsGroup(groupName);
        }
      },
      profileName
    );
  }

  async unmountRemote(remoteName: string): Promise<void> {
    await this.executeAction(remoteName, 'unmount', async () => {
      const mount = this.mountedRemotes().find(m => m.fs.startsWith(`${remoteName}:`));
      if (!mount) throw new Error(`No mount point found for ${remoteName}`);
      await this.mountService.unmountRemote(mount.mount_point, remoteName);
    });
  }

  async deleteRemote(remoteName: string): Promise<void> {
    await this.executeAction(remoteName, 'delete', async () => {
      if (this.mountedRemotes().some(m => m.fs.startsWith(`${remoteName}:`))) {
        await this.unmountRemote(remoteName);
      }
      await this.remoteService.deleteRemote(remoteName);
      await this.refreshAll();
    });
  }

  async openRemoteInFiles(remoteName: string, pathOrOperation?: string): Promise<void> {
    let path = pathOrOperation ?? '';
    if (['mount', 'sync', 'copy', 'bisync', 'move', 'serve'].includes(path)) {
      const settings = this.getRemoteSettings(remoteName);
      const profiles = settings[`${path}Configs` as keyof RemoteSettings] as
        | Record<string, Record<string, unknown>>
        | undefined;
      const firstProfile = profiles ? Object.values(profiles)[0] : undefined;
      path = (firstProfile?.['dest'] as string) ?? '';
    }
    await this.executeAction(remoteName, 'open', () => this.mountService.openInFiles(path));
  }

  generateUniqueRemoteName(baseName: string): string {
    const existing = [...this.remoteBaseSignals.keys()];
    let name = baseName;
    let i = 1;
    while (existing.includes(name)) name = `${baseName}-${i++}`;
    return name;
  }

  async cloneRemote(remoteName: string): Promise<RemoteSettings | null> {
    const base = this.remoteBaseSignals.get(remoteName)?.() as
      | Omit<Remote, 'status' | 'features'>
      | undefined;
    if (!base) return null;

    const newName = this.generateUniqueRemoteName(base.name.replace(/-\d+$/, ''));
    const settings = structuredClone(this.getRemoteSettings(remoteName) ?? {}) as RemoteSettings;

    for (const remote_config_key of [
      'mountConfigs',
      'syncConfigs',
      'copyConfigs',
      'bisyncConfigs',
      'moveConfigs',
    ] as const) {
      const profiles = settings[remote_config_key as keyof RemoteSettings] as
        | Record<string, ConfigRecord>
        | undefined;
      if (profiles) {
        for (const profile of Object.values(profiles)) {
          if (
            typeof profile['source'] === 'string' &&
            profile['source'].startsWith(`${remoteName}:`)
          ) {
            profile['source'] = profile['source'].replace(`${remoteName}:`, `${newName}:`);
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
        (r.status.diskUsage.loading || r.status.diskUsage.total_space === undefined)
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

  // --- Private ---

  private createEnrichedSignal(
    name: string,
    baseSig: WritableSignal<Omit<Remote, 'status' | 'features'>>
  ): Signal<Remote> {
    const jobs = computed(() => this.jobsByRemote()[name] ?? []);
    const mounts = computed(() => this.mountsByRemote()[name] ?? []);
    const serves = computed(() => this.servesByRemote()[name] ?? []);
    const settings = computed(() => this.remoteSettings()[name] ?? {});
    const disk = this.diskUsageSignal(name);
    const features = this.featuresSignal(name);

    return computed(() => {
      const base = baseSig();
      const enriched = this.enrichRemote(base, jobs(), mounts(), serves(), settings());
      return {
        ...enriched,
        status: {
          ...enriched.status,
          diskUsage: disk(),
        },
        features: features(),
      } as Remote;
    });
  }

  public diskUsageSignal(name: string): WritableSignal<DiskUsage> {
    let sig = this.diskUsageSignals.get(name);
    if (!sig) {
      sig = signal<DiskUsage>({ loading: true, error: false });
      this.diskUsageSignals.set(name, sig);
    }
    return sig;
  }

  public featuresSignal(name: string): WritableSignal<RemoteFeatures> {
    let sig = this.featuresSignals.get(name);
    if (!sig) {
      sig = signal<RemoteFeatures>({
        isLocal: isLocalPath(name),
        hasAbout: true,
        hasBucket: false,
        hasCleanUp: false,
        hasPublicLink: false,
        changeNotify: false,
        hashes: [],
      });
      this.featuresSignals.set(name, sig);
    }
    return sig;
  }

  private actionSignal(name: string): WritableSignal<ActionState[]> {
    let sig = this.actionSignals.get(name);
    if (!sig) {
      sig = signal<ActionState[]>([]);
      this.actionSignals.set(name, sig);
      this.actionKeysVersion.update(v => v + 1);
    }
    return sig;
  }

  private enrichRemote(
    base: Omit<Remote, 'status' | 'features'>,
    jobs: JobInfo[],
    mounts: MountedRemote[],
    serves: ServeListItem[],
    settings: RemoteSettings
  ): Omit<Remote, 'features'> {
    const mountProfiles = Object.keys(
      (settings['mountConfigs'] ?? {}) as Record<string, Record<string, unknown>>
    );
    const serveProfiles = Object.keys(
      (settings['serveConfigs'] ?? {}) as Record<string, Record<string, unknown>>
    );
    const config = settings['config'] as RemoteConfig | undefined;

    return {
      ...base,
      config: config || base.config,
      primaryActions:
        ((settings as Record<string, unknown>)?.['primaryActions'] as
          | PrimaryActionType[]
          | undefined) ?? [],
      status: {
        diskUsage: { loading: true }, // Placeholder, updated by diskUsageSignal
        sync: this.calculateOperationState('sync', jobs, settings),
        copy: this.calculateOperationState('copy', jobs, settings),
        bisync: this.calculateOperationState('bisync', jobs, settings),
        move: this.calculateOperationState('move', jobs, settings),
        mount: {
          active: mounts.length > 0,
          activeProfiles: this.buildActiveProfiles(
            mounts,
            mountProfiles,
            m => m.profile,
            m => m.mount_point
          ),
        },
        serve: {
          active: serves.length > 0,
          count: serves.length,
          serves,
          activeProfiles: this.buildActiveProfiles(
            serves,
            serveProfiles,
            s => s.profile,
            s => s.id
          ),
        },
      },
    };
  }

  private buildActiveProfiles<T, V>(
    items: T[],
    profileNames: string[],
    getProfile: (i: T) => string | null | undefined,
    getValue: (i: T) => V
  ): Record<string, V> {
    const result: Record<string, V> = {};
    const fallback = profileNames[0] ?? 'default';
    for (const item of items) {
      const p = getProfile(item);
      const target = p && profileNames.includes(p) ? p : fallback;
      if (!(target in result)) result[target] = getValue(item);
    }
    return result;
  }

  private calculateOperationState(
    type: SyncOperationType,
    jobs: JobInfo[],
    settings: RemoteSettings
  ): RemoteOperationState {
    const running = jobs.filter(j => j.status === 'Running' && j.job_type === type);
    const profiles =
      (settings[`${type}Configs` as keyof RemoteSettings] as Record<
        string,
        Record<string, unknown>
      >) ?? {};
    const profileNames = Object.keys(profiles);

    return {
      active: running.length > 0,
      jobId: running[0]?.jobid,
      activeProfiles: this.buildActiveProfiles(
        running,
        profileNames,
        j => j.profile,
        j => j.jobid
      ),
    };
  }

  private groupBy<T, K extends PropertyKey>(array: T[], keyGetter: (item: T) => K): Record<K, T[]> {
    return array.reduce(
      (acc, item) => {
        const key = keyGetter(item);
        (acc[key] ??= []).push(item);
        return acc;
      },
      {} as Record<K, T[]>
    );
  }
}
