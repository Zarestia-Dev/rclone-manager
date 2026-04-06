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
import { NautilusService } from '../ui/nautilus.service';
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
} from '@app/types';

type ProfileConfigMap = Record<string, Record<string, unknown>>;

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
  private readonly nautilusService = inject(NautilusService);
  private readonly destroyRef = inject(DestroyRef);

  readonly jobs = this.jobService.jobs;
  readonly mountedRemotes = this.mountService.mountedRemotes;
  readonly runningServes = this.serveService.runningServes;

  private readonly remoteNames = signal<string[]>([]);
  private readonly remoteSettings = signal<Record<string, RemoteSettings>>({});
  private readonly isLoading = signal(false);
  private backgroundLoadGeneration = 0;

  // Per-remote signals keyed by name
  private readonly remoteBaseSignals = new Map<
    string,
    WritableSignal<Omit<Remote, 'status' | 'features'>>
  >();
  private readonly diskUsageSignals = new Map<string, WritableSignal<DiskUsage>>();
  private readonly featuresSignals = new Map<string, WritableSignal<RemoteFeatures>>();
  private readonly enrichedSignals = new Map<string, Signal<Remote>>();

  // Single signal for all action states — no Map-of-signals hack needed
  private readonly _actionInProgress = signal<Record<string, ActionState[]>>({});
  readonly actionInProgress = this._actionInProgress.asReadonly();

  private readonly jobsByRemote = computed(() => groupBy(this.jobs(), j => j.remote_name));
  private readonly mountsByRemote = computed(() =>
    groupBy(this.mountedRemotes(), m => getRemoteNameFromFs(m.fs))
  );
  private readonly servesByRemote = computed(() =>
    groupBy(this.runningServes(), s => getRemoteNameFromFs(s.params?.fs))
  );

  readonly loading = this.isLoading.asReadonly();

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
  }

  // --- Settings ---

  getRemoteSettings(remoteName: string): RemoteSettings {
    return this.remoteSettings()[remoteName] ?? {};
  }

  // --- Disk Usage ---

  updateDiskUsage(remoteName: string, usage: Partial<DiskUsage>): void {
    this.getDiskUsageSignal(remoteName).update(cur => ({ ...cur, ...usage }));
  }

  async getCachedOrFetchDiskUsage(
    remoteName: string,
    normalizedName?: string,
    source: Origin = 'dashboard',
    forceRefresh = false
  ): Promise<DiskUsage | null> {
    const features = await this.metadataService.getFeatures(remoteName, source);

    if (features.error) {
      this.updateDiskUsage(remoteName, {
        loading: false,
        error: true,
        errorMessage: features.error,
      });
      return null;
    }
    if (!features.hasAbout) {
      this.updateDiskUsage(remoteName, { notSupported: true, loading: false, error: false });
      return null;
    }

    const cached = this.getDiskUsageSignal(remoteName)();
    if (!forceRefresh && cached.total_space !== undefined && !cached.loading && !cached.error) {
      return cached;
    }

    const fsName = normalizedName ?? `${remoteName}:`;
    this.updateDiskUsage(remoteName, { loading: true, error: false, total_space: undefined });

    try {
      const usage = await this.remoteOpsService.getDiskUsage(fsName, undefined, source);
      const result: DiskUsage = {
        total_space: usage.total ?? -1,
        used_space: usage.used ?? -1,
        free_space: usage.free ?? -1,
        loading: false,
        error: false,
        notSupported: false,
      };
      this.updateDiskUsage(remoteName, result);
      return result;
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

      // Remove stale remotes
      for (const name of this.remoteBaseSignals.keys()) {
        if (!incomingSet.has(name)) {
          this.remoteBaseSignals.delete(name);
          this.diskUsageSignals.delete(name);
          this.featuresSignals.delete(name);
          this.enrichedSignals.delete(name);
          this.metadataService.clearCache(name);
        }
      }

      let newRemotesAdded = false;

      for (const name of incomingNames) {
        const config: RemoteConfig = {
          name,
          ...(configs[name] as Record<string, unknown>),
        } as RemoteConfig;
        const existing = this.remoteBaseSignals.get(name);

        if (existing) {
          if (JSON.stringify(existing().config) !== JSON.stringify(config)) {
            this.metadataService.clearCache(name);
            void this.metadataService
              .getFeatures(name)
              .then(f => this.getFeaturesSignal(name).set(f));
          }
          existing.update(r => ({ ...r, config }));
        } else {
          newRemotesAdded = true;
          const primaryActions =
            ((settings[name] as Record<string, unknown>)?.[
              'primaryActions'
            ] as PrimaryActionType[]) ?? [];
          const baseSig = signal<Omit<Remote, 'status' | 'features'>>({
            name,
            type: config.type,
            config,
            primaryActions,
          });
          this.remoteBaseSignals.set(name, baseSig);
          this.enrichedSignals.set(name, this.createEnrichedSignal(name, baseSig));
          void this.metadataService
            .getFeatures(name)
            .then(f => this.getFeaturesSignal(name).set(f));
        }
      }

      this.remoteNames.set(incomingNames);
      this.remoteSettings.set(settings);

      if (newRemotesAdded) {
        this.loadDiskUsageInBackground();
      }
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
    return computed(() => this._actionInProgress()[remoteName] ?? []);
  }

  diskUsageSignal(remoteName: string): Signal<DiskUsage> {
    return this.getDiskUsageSignal(remoteName);
  }

  featuresSignal(remoteName: string): Signal<RemoteFeatures> {
    return this.getFeaturesSignal(remoteName);
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
      const mountPoint = profileName
        ? mounts.find(m => m.profile === profileName)?.mount_point
        : mounts[0]?.mount_point;
      if (!mountPoint) throw new Error(`Active mount not found for ${remoteName}`);
      await this.mountService.unmountRemote(mountPoint, remoteName);
      return;
    }

    const groupName = profileName
      ? `${type}/${remoteName}/${profileName}`
      : `${type}/${remoteName}`;
    await this.jobService.stopJobsByGroup(groupName);
    await this.jobService.deleteStatsGroup(groupName);
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
      const mounts = this.mountedRemotes().filter(m => getRemoteNameFromFs(m.fs) === remoteName);
      for (const m of mounts) await this.mountService.unmountRemote(m.mount_point, remoteName);

      const serves = this.serveService.getServesForRemoteProfile(remoteName);
      for (const s of serves) await this.serveService.stopServe(s.id, remoteName);

      const jobs = this.jobService.getActiveJobsForRemote(remoteName);
      for (const j of jobs) await this.jobService.stopJob(j.jobid, remoteName);

      await this.remoteService.deleteRemote(remoteName);
      await this.refreshAll();
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
      await this.executeAction(remoteName, 'open', () => this.mountService.openInFiles(path));
    } else {
      await this.executeAction(remoteName, 'open', async () => {
        const colonIdx = path.indexOf(':');
        const targetRemoteName = colonIdx > -1 ? path.substring(0, colonIdx) : remoteName;
        const relativePath =
          colonIdx > -1
            ? path.substring(colonIdx + 1).replace(/^\/+/, '')
            : path.replace(/^\/+/, '');

        await this.nautilusService.detachTab(targetRemoteName, relativePath);
      });
    }
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

  private getDiskUsageSignal(name: string): WritableSignal<DiskUsage> {
    let sig = this.diskUsageSignals.get(name);
    if (!sig) {
      sig = signal<DiskUsage>({ loading: true, error: false });
      this.diskUsageSignals.set(name, sig);
    }
    return sig;
  }

  private getFeaturesSignal(name: string): WritableSignal<RemoteFeatures> {
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

  // --- Enriched Remote Construction ---

  private createEnrichedSignal(
    name: string,
    baseSig: WritableSignal<Omit<Remote, 'status' | 'features'>>
  ): Signal<Remote> {
    const jobs = computed(() => this.jobsByRemote()[name] ?? []);
    const mounts = computed(() => this.mountsByRemote()[name] ?? []);
    const serves = computed(() => this.servesByRemote()[name] ?? []);
    const settings = computed(() => this.remoteSettings()[name] ?? {});
    const disk = this.getDiskUsageSignal(name);
    const features = this.getFeaturesSignal(name);

    return computed(() => {
      const enriched = this.enrichRemote(baseSig(), jobs(), mounts(), serves(), settings());
      return {
        ...enriched,
        status: { ...enriched.status, diskUsage: disk() },
        features: features(),
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
    const mountConfigMap = (settings[REMOTE_CONFIG_KEYS.mount] ?? {}) as ProfileConfigMap;
    const serveConfigMap = (settings[REMOTE_CONFIG_KEYS.serve] ?? {}) as ProfileConfigMap;
    const mountProfiles = Object.keys(mountConfigMap);
    const serveProfiles = Object.keys(serveConfigMap);

    return {
      ...base,
      config: (settings['config'] as RemoteConfig) || base.config,
      primaryActions:
        ((settings as Record<string, unknown>)?.['primaryActions'] as PrimaryActionType[]) ?? [],
      status: {
        diskUsage: { loading: true },
        sync: this.buildOperationState('sync', jobs, settings),
        copy: this.buildOperationState('copy', jobs, settings),
        bisync: this.buildOperationState('bisync', jobs, settings),
        move: this.buildOperationState('move', jobs, settings),
        mount: {
          active: mounts.length > 0,
          activeProfiles: buildActiveProfiles(
            mounts,
            mountProfiles,
            m => m.profile,
            m => m.mount_point
          ),
          configuredProfiles: mountProfiles,
          profileBrowsePaths: buildProfileBrowsePaths(mountConfigMap),
        },
        serve: {
          active: serves.length > 0,
          count: serves.length,
          serves,
          activeProfiles: buildActiveProfiles(
            serves,
            serveProfiles,
            s => s.profile,
            s => s.id
          ),
          configuredProfiles: serveProfiles,
          profileBrowsePaths: buildProfileBrowsePaths(serveConfigMap),
        },
      },
    };
  }

  private buildOperationState(
    type: SyncOperationType,
    jobs: JobInfo[],
    settings: RemoteSettings
  ): RemoteOperationState {
    const running = jobs.filter(j => j.status === 'Running' && j.job_type === type);
    const configKey = REMOTE_CONFIG_KEYS[
      type as keyof typeof REMOTE_CONFIG_KEYS
    ] as keyof RemoteSettings;
    const profiles = (settings[configKey] as ProfileConfigMap) ?? {};
    const profileNames = Object.keys(profiles);

    return {
      active: running.length > 0,
      jobId: running[0]?.jobid,
      activeProfiles: buildActiveProfiles(
        running,
        profileNames,
        j => j.profile,
        j => j.jobid
      ),
      configuredProfiles: profileNames,
      profileBrowsePaths: buildProfileBrowsePaths(profiles),
    };
  }
}

// --- Module-level pure helpers (no `this` dependency) ---

function groupBy<T, K extends PropertyKey>(array: T[], keyGetter: (item: T) => K): Record<K, T[]> {
  return array.reduce(
    (acc, item) => {
      const key = keyGetter(item);
      (acc[key] ??= []).push(item);
      return acc;
    },
    {} as Record<K, T[]>
  );
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
    const p = getProfile(item);
    const target = p && profileNames.includes(p) ? p : fallback;
    if (!(target in result)) result[target] = getValue(item);
  }
  return result;
}
