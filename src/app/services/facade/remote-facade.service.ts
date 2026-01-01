import { Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
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
  REMOTE_CACHE_CHANGED,
  REMOTE_SETTINGS_CHANGED,
  DiskUsage,
} from '@app/types';

@Injectable({
  providedIn: 'root',
})
export class RemoteFacadeService extends TauriBaseService {
  private jobService = inject(JobManagementService);
  private mountService = inject(MountManagementService);
  private serveService = inject(ServeManagementService);
  private remoteService = inject(RemoteManagementService);
  private appSettingsService = inject(AppSettingsService);

  // Reactive data sources from underlying services
  private jobs = toSignal(this.jobService.jobs$, { initialValue: [] as JobInfo[] });
  private mountedRemotes = toSignal(this.mountService.mountedRemotes$, {
    initialValue: [] as MountedRemote[],
  });
  private runningServes = toSignal(this.serveService.runningServes$, {
    initialValue: [] as ServeListItem[],
  });

  // Local state for non-streamed data
  private baseRemotes = signal<Remote[]>([]);
  private remoteSettings = signal<Record<string, RemoteSettings>>({});
  private isLoading = signal<boolean>(false);

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
    normalizedName?: string
  ): Promise<DiskUsage | null> {
    // Check cache first
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

    // Fetch from backend
    try {
      const fsName = normalizedName || `${remoteName}:`;

      // First check if About feature is supported
      const fsInfo = await this.remoteService.getFsInfo(fsName);
      if (fsInfo.Features?.['About'] === false) {
        const notSupportedUsage: DiskUsage = {
          notSupported: true,
          loading: false,
          error: false,
        };
        this.updateDiskUsage(remoteName, notSupportedUsage);
        return null;
      }

      const usage = await this.remoteService.getDiskUsage(fsName);
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
      const errorUsage: DiskUsage = {
        loading: false,
        error: true,
      };
      this.updateDiskUsage(remoteName, errorUsage);
      return null;
    }
  }

  constructor() {
    super();
    // Auto-refresh when remote cache or settings updates
    merge(
      this.listenToEvent<unknown>(REMOTE_CACHE_CHANGED),
      this.listenToEvent<unknown>(REMOTE_SETTINGS_CHANGED)
    ).subscribe(() => {
      this.loadRemotes().catch(err =>
        console.error('[RemoteFacadeService] Failed to auto-reload remotes:', err)
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

      this.baseRemotes.set(this.createRemotesFromConfigs(configArray as RemoteConfig[]));
      this.remoteSettings.set(settings);
    } catch (error) {
      console.error('[RemoteFacadeService] Failed to load remotes:', error);
      throw error;
    } finally {
      this.isLoading.set(false);
    }
  }

  // =========================================================================================
  // ENRICHMENT LOGIC (Ported from HomeComponent)
  // =========================================================================================

  private createRemotesFromConfigs(configs: RemoteConfig[]): Remote[] {
    return configs.map(config => ({
      remoteSpecs: config as any,
      diskUsage: {
        loading: false,
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

  private enrichRemote(
    remote: Remote,
    jobs: JobInfo[],
    mounts: MountedRemote[],
    serves: ServeListItem[],
    settings: RemoteSettings
  ): Remote {
    // 1. Enrich with Jobs
    const remoteJobs = jobs.filter(j => j.remote_name === remote.remoteSpecs.name);

    const enrichedWithJobs = {
      ...remote,
      primaryActions: settings['primaryActions'] || [],
      syncState: this.calculateOperationState('sync', remoteJobs, settings),
      copyState: this.calculateOperationState('copy', remoteJobs, settings),
      bisyncState: this.calculateOperationState('bisync', remoteJobs, settings),
      moveState: this.calculateOperationState('move', remoteJobs, settings),
    };

    // 2. Enrich with Mounts
    const remoteMounts = mounts.filter(m => m.fs.startsWith(`${remote.remoteSpecs.name}:`));
    const isMounted = remoteMounts.length > 0;
    const activeMountProfiles: Record<string, string> = {};

    if (isMounted) {
      remoteMounts.forEach(mount => {
        if (mount.profile) {
          activeMountProfiles[mount.profile] = mount.mount_point;
        } else {
          // Fallback logic
          const profiles = settings['mountConfigs'] as
            | Record<string, Record<string, unknown>>
            | undefined;
          if (profiles) {
            const matchEntry = Object.entries(profiles).find(
              ([_, p]) => (p as any).dest === mount.mount_point
            );
            if (matchEntry) {
              activeMountProfiles[matchEntry[0]] = mount.mount_point;
            }
          }
        }
      });
    }

    const enrichedWithMounts = {
      ...enrichedWithJobs,
      mountState: {
        ...remote.mountState,
        mounted: isMounted,
        activeProfiles: activeMountProfiles,
      },
    };

    // 3. Enrich with Serves
    const remoteServes = serves.filter(
      s => s.params && s.params.fs && s.params.fs.split(':')[0] === remote.remoteSpecs.name
    );

    return {
      ...enrichedWithMounts,
      serveState: {
        isOnServe: remoteServes.length > 0,
        serveCount: remoteServes.length,
        serves: remoteServes,
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
      Object.keys(profiles).forEach(profileName => {
        const match = runningJobs.find(j => j.profile === profileName);
        if (match) {
          activeProfiles[profileName] = match.jobid;
        }
      });
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
}
