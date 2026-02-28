import { Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { merge } from 'rxjs';
import { TauriBaseService } from '../core/tauri-base.service';
import { JobManagementService } from '../file-operations/job-management.service';
import { MountManagementService } from '../file-operations/mount-management.service';
import { ServeManagementService } from '../file-operations/serve-management.service';
import { RemoteManagementService } from '../remote/remote-management.service';
import { AppSettingsService } from '../settings/app-settings.service';
import {
  Remote,
  RemoteConfig,
  JobInfo,
  MountedRemote,
  ServeListItem,
  RemoteSettings,
  SyncOperationType,
  PrimaryActionType,
  ActionState,
  RemoteAction,
  DiskUsage,
  Origin,
} from '@app/types';
import { EventListenersService } from '../system/event-listeners.service';

@Injectable({
  providedIn: 'root',
})
export class RemoteFacadeService extends TauriBaseService {
  private jobService = inject(JobManagementService);
  private mountService = inject(MountManagementService);
  private serveService = inject(ServeManagementService);
  private remoteService = inject(RemoteManagementService);
  private appSettingsService = inject(AppSettingsService);
  private eventListeners = inject(EventListenersService);

  // Reactive data sources from underlying services
  // Expose these as readonly signals for consumers who need raw lists (e.g. HomeComponent)
  readonly jobs = this.jobService.jobs;
  readonly mountedRemotes = this.mountService.mountedRemotes;
  readonly runningServes = this.serveService.runningServes;

  // Local state for non-streamed data
  private baseRemotes = signal<Remote[]>([]);
  private remoteSettings = signal<Record<string, RemoteSettings>>({});
  private isLoading = signal<boolean>(false);

  // Track actions in progress per remote
  // Map<RemoteName, ActionState[]>
  private actionProgressMap = signal<Record<string, ActionState[]>>({});
  readonly actionInProgress = this.actionProgressMap.asReadonly();

  /**
   * Computed signal that combines all data sources to produce fully enriched Remote objects.
   * This ensures a single source of truth for the UI.
   */
  readonly activeRemotes = computed(() => {
    const remotes = this.baseRemotes();
    const jobs = this.jobs();
    const mounts = this.mountedRemotes();
    const serves = this.runningServes();
    const settings = this.remoteSettings();

    return remotes.map(remote =>
      this.enrichRemote(remote, jobs, mounts, serves, settings[remote.remoteSpecs.name] || {})
    );
  });

  readonly loading = this.isLoading.asReadonly();

  getRemoteSettings(remoteName: string): RemoteSettings {
    return this.remoteSettings()[remoteName] || {};
  }

  updateDiskUsage(remoteName: string, usage: DiskUsage): void {
    this.baseRemotes.update(remotes =>
      remotes.map(r =>
        r.remoteSpecs.name === remoteName ? { ...r, diskUsage: { ...r.diskUsage, ...usage } } : r
      )
    );
  }

  /**
   * Get disk usage for a remote, using cached data if available.
   * Falls back to fetching from backend when cache is empty or stale.
   * @param remoteName - The display name of the remote (without colon)
   * @param normalizedName - The normalized name for API calls (with colon, e.g. "drive:")
   * @returns Disk usage data or null if not supported
   */
  async getCachedOrFetchDiskUsage(
    remoteName: string,
    normalizedName?: string,
    source: Origin = 'dashboard',
    forceRefresh = false
  ): Promise<DiskUsage | null> {
    // Check cache first
    if (!forceRefresh) {
      const cachedRemote = this.activeRemotes().find(r => r.remoteSpecs.name === remoteName);

      const cachedUsage = cachedRemote?.diskUsage;
      if (
        cachedUsage &&
        cachedUsage.total_space !== undefined &&
        !cachedUsage.notSupported &&
        !cachedUsage.loading &&
        !cachedUsage.error
      ) {
        return cachedUsage;
      }

      // If marked as not supported, return null
      if (cachedUsage?.notSupported) {
        return null;
      }
    }

    // Fetch from backend
    try {
      const fsName = normalizedName || `${remoteName}:`;

      // Set loading state before fetching - Reset usage data to clear UI
      this.updateDiskUsage(remoteName, {
        loading: true,
        error: false,
        errorMessage: undefined,
        total_space: undefined,
        used_space: undefined,
        free_space: undefined,
      });

      // First check if About feature is supported
      const fsInfo = await this.remoteService.getFsInfo(fsName, source);
      if (fsInfo.Features?.['About'] === false) {
        const notSupportedUsage: DiskUsage = {
          notSupported: true,
          loading: false,
          error: false,
        };
        this.updateDiskUsage(remoteName, notSupportedUsage);
        return null;
      }

      const usage = await this.remoteService.getDiskUsage(fsName, undefined, source);
      const diskUsage: DiskUsage = {
        total_space: usage.total || -1,
        used_space: usage.used || -1,
        free_space: usage.free || -1,
        loading: false,
        error: false,
        notSupported: false,
      };

      // Update the cache
      this.updateDiskUsage(remoteName, diskUsage);

      return diskUsage;
    } catch (error) {
      console.error(`Failed to fetch disk usage for ${remoteName}:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorUsage: DiskUsage = {
        loading: false,
        error: true,
        errorMessage,
      };
      this.updateDiskUsage(remoteName, errorUsage);
      return null;
    }
  }

  constructor() {
    super();
    // Auto-refresh all data when remote cache changes (e.g., backend switch)
    // or when settings change, or when engine becomes ready after restart
    merge(
      this.eventListeners.listenToRemoteCacheUpdated(),
      this.eventListeners.listenToRemoteSettingsChanged(),
      this.eventListeners.listenToRcloneEngineReady()
    )
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        // Use refreshAll to also refresh jobs, mounts, serves - not just remote configs
        this.refreshAll().catch(err =>
          console.error('[RemoteFacadeService] Failed to auto-refresh:', err)
        );
      });
  }

  /**
   * Load base remote configurations and settings.
   * Job/Mount/Serve data updates automatically via their respective services.
   */
  async loadRemotes(): Promise<void> {
    this.isLoading.set(true);
    try {
      const [configs, settings] = await Promise.all([
        this.remoteService.getAllRemoteConfigs(),
        this.appSettingsService.getRemoteSettings(),
      ]);

      const configArray = Object.keys(configs).map(name => ({
        name,
        ...(configs[name] as any),
      }));

      // Preserve existing diskUsage data when recreating remotes
      const existingRemotes = this.baseRemotes();
      const existingDiskUsageMap = new Map(
        existingRemotes.map(r => [r.remoteSpecs.name, r.diskUsage])
      );

      const newRemotes = this.createRemotesFromConfigs(configArray as RemoteConfig[]).map(
        remote => ({
          ...remote,
          diskUsage: existingDiskUsageMap.get(remote.remoteSpecs.name) || remote.diskUsage,
        })
      );

      this.baseRemotes.set(newRemotes);
      this.remoteSettings.set(settings);
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Refreshes all underlying data sources.
   * Useful for initial load or manual refresh.
   */
  async refreshAll(): Promise<void> {
    this.isLoading.set(true);
    try {
      await Promise.all([
        this.mountService.getMountedRemotes(),
        this.serveService.refreshServes(),
        this.jobService.refreshJobs(),
        this.loadRemotes(),
      ]);
      // Load disk usage for any remotes that need it (e.g., after backend switch)
      this.loadDiskUsageInBackground();
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Load disk usage for remotes in background.
   * Processes one at a time to avoid backend congestion.
   */
  loadDiskUsageInBackground(remotes?: Remote[]): void {
    const remotesToProcess = remotes ?? this.activeRemotes();
    const remotesToLoad = remotesToProcess.filter(
      r =>
        !r.diskUsage.error &&
        !r.diskUsage.notSupported &&
        (r.diskUsage.loading || r.diskUsage.total_space === undefined)
    );

    if (remotesToLoad.length === 0) return;

    // Process one by one with proper error handling
    (async (): Promise<void> => {
      for (const remote of remotesToLoad) {
        try {
          await this.getCachedOrFetchDiskUsage(remote.remoteSpecs.name);
        } catch (error) {
          console.error(`Failed to load disk usage for ${remote.remoteSpecs.name}:`, error);
        }
        // Small delay between requests
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    })().catch(error => {
      console.error('[RemoteFacadeService] Error in background disk usage loading:', error);
    });
  }

  // =========================================================================================
  // ACTION STATE MANAGEMENT
  // =========================================================================================

  startAction(remoteName: string, action: RemoteAction, profileName?: string): void {
    this.actionProgressMap.update(map => {
      const current = map[remoteName] || [];
      return {
        ...map,
        [remoteName]: [...current, { type: action, profileName }],
      };
    });
  }

  endAction(remoteName: string, action: RemoteAction, profileName?: string): void {
    this.actionProgressMap.update(map => {
      const current = map[remoteName] || [];
      return {
        ...map,
        [remoteName]: current.filter(a => !(a.type === action && a.profileName === profileName)),
      };
    });
  }

  getActionState(remoteName: string): ActionState[] {
    return this.actionProgressMap()[remoteName] || [];
  }

  isActionInProgress(remoteName: string, action: RemoteAction, profileName?: string): boolean {
    const actions = this.getActionState(remoteName);
    return actions.some(a => a.type === action && a.profileName === profileName);
  }

  /**
   * Helper to wrap an async operation with action state tracking
   */
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

  // =========================================================================================
  // ENRICHMENT LOGIC (Ported from HomeComponent)
  // =========================================================================================

  private createRemotesFromConfigs(configs: RemoteConfig[]): Remote[] {
    return configs.map(config => ({
      remoteSpecs: config as any,
      diskUsage: {
        loading: true,
        error: false,
      },
      mountState: {
        mounted: false,
        activeProfiles: {},
      },
      syncState: {},
      copyState: {},
      bisyncState: {},
      moveState: {},
      serveState: {
        isOnServe: false,
        serveCount: 0,
        serves: [],
      },
    }));
  }

  /**
   * Generic helper to build activeProfiles map from items with optional profile property.
   * Handles null-profile items by assigning them to first configured profile or 'default'.
   */
  private buildActiveProfiles<T, V>(
    items: T[],
    configuredProfileNames: string[],
    getProfile: (item: T) => string | null | undefined,
    getValue: (item: T) => V
  ): Record<string, V> {
    const activeProfiles: Record<string, V> = {};

    items.forEach(item => {
      const profile = getProfile(item);
      if (profile && configuredProfileNames.includes(profile)) {
        activeProfiles[profile] = getValue(item);
      } else if (!profile) {
        // Assign null-profile item to first configured profile or 'default'
        const targetProfile = configuredProfileNames[0] || 'default';
        if (!(targetProfile in activeProfiles)) {
          activeProfiles[targetProfile] = getValue(item);
        }
      }
    });

    return activeProfiles;
  }

  private enrichRemote(
    remote: Remote,
    jobs: JobInfo[],
    mounts: MountedRemote[],
    serves: ServeListItem[],
    settings: RemoteSettings
  ): Remote {
    const remoteName = remote.remoteSpecs.name;

    // Filter items for this remote
    const remoteJobs = jobs.filter(j => j.remote_name === remoteName);
    const remoteMounts = mounts.filter(m => m.fs.startsWith(`${remoteName}:`));
    const remoteServes = serves.filter(s => s.params?.fs?.split(':')[0] === remoteName);

    // Get profile configs
    const mountProfileNames = Object.keys(
      (settings['mountConfigs'] as Record<string, unknown>) || {}
    );
    const serveProfileNames = Object.keys(
      (settings['serveConfigs'] as Record<string, unknown>) || {}
    );

    // Build active profiles using helper
    const activeMountProfiles = this.buildActiveProfiles(
      remoteMounts,
      mountProfileNames,
      m => m.profile,
      m => m.mount_point
    );

    const activeServeProfiles = this.buildActiveProfiles(
      remoteServes,
      serveProfileNames,
      s => s.profile,
      s => s.id
    );

    return {
      ...remote,
      primaryActions: (settings['primaryActions'] as PrimaryActionType[]) || [],
      syncState: this.calculateOperationState('sync', remoteJobs, settings),
      copyState: this.calculateOperationState('copy', remoteJobs, settings),
      bisyncState: this.calculateOperationState('bisync', remoteJobs, settings),
      moveState: this.calculateOperationState('move', remoteJobs, settings),
      mountState: {
        ...remote.mountState,
        mounted: remoteMounts.length > 0,
        activeProfiles: activeMountProfiles,
      },
      serveState: {
        isOnServe: remoteServes.length > 0,
        serveCount: remoteServes.length,
        serves: remoteServes,
        activeProfiles: activeServeProfiles,
      },
    };
  }

  private calculateOperationState(
    type: SyncOperationType,
    jobs: JobInfo[],
    settings: RemoteSettings
  ): Record<string, unknown> {
    const runningJobs = jobs.filter(j => j.status === 'Running' && j.job_type === type);
    const configKey = `${type}Configs` as keyof RemoteSettings;
    const profiles = settings[configKey] as Record<string, unknown> | undefined;
    const activeProfiles: Record<string, number> = {};

    if (profiles) {
      const profileNames = Object.keys(profiles);

      runningJobs.forEach(job => {
        // If job has a profile, match it; otherwise assign to first profile or 'default'
        if (job.profile && profileNames.includes(job.profile)) {
          activeProfiles[job.profile] = job.jobid;
        } else if (!job.profile) {
          // Job without profile - assign to first profile or 'default'
          const targetProfile = profileNames[0] || 'default';
          if (!activeProfiles[targetProfile]) {
            activeProfiles[targetProfile] = job.jobid;
          }
        }
      });
    } else if (runningJobs.length > 0) {
      // No profiles configured, but we have running jobs - use 'default'
      activeProfiles['default'] = runningJobs[0].jobid;
    }

    const firstProfileKey = profiles ? Object.keys(profiles)[0] : undefined;
    const firstProfile = firstProfileKey ? (profiles as any)[firstProfileKey] : undefined;

    return {
      [`isOn${type.charAt(0).toUpperCase() + type.slice(1)}`]: runningJobs.length > 0,
      [`${type}JobID`]: runningJobs.length > 0 ? runningJobs[0].jobid : undefined,
      isLocal: this.isLocalPath(firstProfile?.dest || ''),
      activeProfiles,
    };
  }

  private isLocalPath(path: string): boolean {
    if (!path) return false;
    return path.startsWith('/') || /^[a-zA-Z]:\\/.test(path);
  }

  // =========================================================================================
  // LOGIC MOVED FROM HOME COMPONENT (Business Logic)
  // =========================================================================================

  async startJob(
    remoteName: string,
    operationType: SyncOperationType | 'mount' | 'serve',
    profileName?: string,
    source: Origin = 'dashboard',
    noCache?: boolean
  ): Promise<void> {
    const settings = this.getRemoteSettings(remoteName);
    const configKey = `${operationType}Configs` as keyof RemoteSettings;
    const profiles = settings[configKey] as Record<string, unknown> | undefined;

    // Get profile name - prefer provided profile, then "default", then first available
    let targetProfile = profileName;
    if (!targetProfile && profiles) {
      targetProfile = profiles['default'] ? 'default' : Object.keys(profiles)[0];
    }

    if (!targetProfile || !profiles?.[targetProfile]) {
      throw new Error(`Configuration for ${operationType} not found on ${remoteName}.`);
    }

    await this.executeAction(
      remoteName,
      operationType as RemoteAction, // RemoteAction includes mount/stop/open/etc, close enough
      async () => {
        switch (operationType) {
          case 'mount':
            if (targetProfile)
              await this.mountService.mountRemoteProfile(
                remoteName,
                targetProfile,
                source,
                noCache
              );
            break;
          case 'serve':
            if (targetProfile) await this.serveService.startServeProfile(remoteName, targetProfile);
            break;
          case 'sync':
            if (targetProfile)
              await this.jobService.startSyncProfile(remoteName, targetProfile, source, noCache);
            break;
          case 'copy':
            if (targetProfile)
              await this.jobService.startCopyProfile(remoteName, targetProfile, source, noCache);
            break;
          case 'bisync':
            if (targetProfile)
              await this.jobService.startBisyncProfile(remoteName, targetProfile, source, noCache);
            break;
          case 'move':
            if (targetProfile)
              await this.jobService.startMoveProfile(remoteName, targetProfile, source, noCache);
            break;
          default:
            throw new Error(`Unsupported operation type: ${operationType}`);
        }
      },
      profileName
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
          let idToStop = serveId;
          const remote = this.activeRemotes().find(r => r.remoteSpecs.name === remoteName);

          if (!idToStop && profileName && remote && remote.serveState?.serves) {
            const serve = remote.serveState.serves.find(s => s.profile === profileName);
            idToStop = serve?.id;
          } else if (
            !idToStop &&
            remote &&
            remote.serveState?.serves &&
            remote.serveState.serves.length > 0
          ) {
            // Fallback: any serve for this remote
            const serve = remote.serveState.serves[0];
            idToStop = serve?.id;
          }

          if (!idToStop) throw new Error('Serve ID required to stop serve');
          await this.serveService.stopServe(idToStop, remoteName);
        } else if (type === 'mount') {
          const remote = this.activeRemotes().find(r => r.remoteSpecs.name === remoteName);
          let mountPoint: string | undefined;

          if (profileName && remote?.mountState?.activeProfiles) {
            mountPoint = remote.mountState.activeProfiles[profileName];
          } else if (remote?.mountState?.activeProfiles) {
            // Fallback: first active profile or inferred mount
            const activeMounts = Object.values(remote.mountState.activeProfiles);
            if (activeMounts.length > 0) mountPoint = activeMounts[0];
            else {
              // Try to find raw mount
              const mount = this.mountedRemotes().find(m => m.fs.startsWith(`${remoteName}:`));
              mountPoint = mount?.mount_point;
            }
          }

          if (!mountPoint) throw new Error(`Active mount logic not found for ${remoteName}`);
          await this.mountService.unmountRemote(mountPoint, remoteName);
        } else {
          // Sync/Copy/Move/Bisync
          const groupName = profileName
            ? `${type}/${remoteName}/${profileName}`
            : `${type}/${remoteName}`;

          // Stop all jobs in this group
          await this.jobService.stopJobsByGroup(groupName);

          // Clear stats/history for this group immediately
          await this.jobService.deleteStatsGroup(groupName);
        }
      },
      profileName
    );
  }

  async unmountRemote(remoteName: string): Promise<void> {
    await this.executeAction(remoteName, 'unmount', async () => {
      // Find mount point
      const mount = this.mountedRemotes().find(m => m.fs.startsWith(`${remoteName}:`));
      if (!mount) throw new Error(`No mount point found for ${remoteName}`);
      await this.mountService.unmountRemote(mount.mount_point, remoteName);
    });
  }

  async deleteRemote(remoteName: string): Promise<void> {
    await this.executeAction(remoteName, 'delete', async () => {
      // Unmount if mounted
      if (this.mountedRemotes().some(m => m.fs.startsWith(`${remoteName}:`))) {
        await this.unmountRemote(remoteName);
      }
      await this.remoteService.deleteRemote(remoteName);
      // Trigger reload is handled by event listener usually, but we can force it
      await this.loadRemotes();
    });
  }

  async openRemoteInFiles(remoteName: string, pathOrOperation?: string): Promise<void> {
    // Resolve path if it's an operation type
    let path = pathOrOperation || '';
    const opHelper = ['mount', 'sync', 'copy', 'bisync', 'move', 'serve'];
    if (opHelper.includes(path)) {
      const settings = this.getRemoteSettings(remoteName);
      const configKey = `${path}Configs` as keyof RemoteSettings;
      const profiles = settings[configKey] as Record<string, unknown> | undefined;
      if (profiles) {
        const firstKey = Object.keys(profiles)[0];
        const profile = profiles[firstKey] as any;
        path = profile?.dest || '';
      } else {
        path = '';
      }
    }

    await this.executeAction(remoteName, 'open', async () => {
      await this.mountService.openInFiles(path);
    });
  }

  // Usage in HomeComponent: this.remoteFacade.cloneRemote(name)
  generateUniqueRemoteName(baseName: string): string {
    const existingNames = this.activeRemotes().map(r => r.remoteSpecs.name);
    let newName = baseName;
    let counter = 1;
    while (existingNames.includes(newName)) {
      newName = `${baseName}-${counter++}`;
    }
    return newName;
  }

  async cloneRemote(remoteName: string): Promise<RemoteSettings | null> {
    const remote = this.activeRemotes().find(r => r.remoteSpecs.name === remoteName);
    if (!remote) return null;

    const baseName = remote.remoteSpecs.name.replace(/-\d+$/, '');
    const newName = this.generateUniqueRemoteName(baseName);
    const clonedSpecs = { ...remote.remoteSpecs, name: newName };

    // Deep clone settings
    const settingsSource = this.getRemoteSettings(remoteName);
    const settings: RemoteSettings = settingsSource
      ? JSON.parse(JSON.stringify(settingsSource))
      : {};

    // Update source paths
    const configKeys = [
      'mountConfigs',
      'syncConfigs',
      'copyConfigs',
      'bisyncConfigs',
      'moveConfigs',
    ] as const;
    for (const key of configKeys) {
      const profiles = settings[key] as Record<string, Record<string, unknown>> | undefined;
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

    // Return the config object so the Component can open the modal with it
    return {
      remoteSpecs: clonedSpecs,
      ...settings,
    } as RemoteSettings;
  }

  // Private helper to safe-guard operation state access
  private getOperationState(remote: Remote | undefined, type: SyncOperationType): any {
    if (!remote) return undefined;
    const stateMap: Record<SyncOperationType, any> = {
      sync: remote.syncState,
      copy: remote.copyState,
      bisync: remote.bisyncState,
      move: remote.moveState,
    };
    return stateMap[type];
  }

  async deleteJob(jobId: number): Promise<void> {
    await this.jobService.deleteJob(jobId);
  }
}
