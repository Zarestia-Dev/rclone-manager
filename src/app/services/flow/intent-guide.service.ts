import { Injectable, Injector, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { filter, firstValueFrom, map, timeout } from 'rxjs';
import {
  BATCH_OP_LABELS,
  JOB_STATUS,
  REMOTE_CONFIG_KEYS,
  JobInfo,
  LocalDrive,
  PrimaryActionType,
  QuickRun,
  QuickRunInput,
  RepairSheetType,
  SyncOperationType,
} from '@app/types';
import { HasStarter, profileOf, quickRunIdOf } from 'src/app/shared/types/starter';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { isAndroid } from '../infrastructure/platform/api-client.service';
import { PathService } from '../infrastructure/platform/path.service';
import { PathInspectionService } from '../infrastructure/platform/path-inspection.service';
import { OpenerService } from '../infrastructure/platform/opener.service';
import { SystemInfoService } from '../infrastructure/system/system-info.service';
import { BackendService } from '../infrastructure/system/backend.service';
import { SystemHealthService } from '../infrastructure/maintenance/system-health.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { RemoteFacadeService } from '../facade/remote-facade.service';
import { RemoteManagementService } from '../remote/remote-management.service';
import { RemoteDiskUsageService } from '../remote/remote-disk-usage.service';
import { RemoteFileOperationsService } from '../remote/remote-file-operations.service';
import { RemotePresetsService } from '../remote/remote-presets';
import { JobManagementService } from '../operations/job-management.service';
import { MountManagementService } from '../operations/mount-management.service';
import { ServeManagementService } from '../operations/serve-management.service';
import { QuickRunService } from './quick-run.service';
import { FILE_REPORT_OPERATIONS } from 'src/app/shared/utils/job-report.util';
import {
  ExistingSetup,
  GUIDE_OPERATIONS,
  GuideDestination,
  GuideDestinationSetting,
  GuideNetwork,
  GuidePlan,
  GuidePresets,
  PreviewResult,
  asDryRun,
  buildPlanProfile,
  buildPreview,
  describeSetup,
  isLoopbackHost,
  resolveDestination,
  withoutResync,
} from 'src/app/shared/utils/intent-guide.util';

export interface GuideRemote {
  readonly name: string;
  readonly type: string;
}

/** Where the guide runs, which decides the words it uses and the options it offers. */
export interface GuideEnvironment {
  readonly remotes: readonly GuideRemote[];
  /** Home folder of the machine rclone runs on, when rclone reports one. */
  readonly home?: string;
  readonly homeFree?: number;
  /** The files live on another machine: a headless server or a remote rclone backend. */
  readonly isServer: boolean;
  readonly isAndroid: boolean;
  /** Mounting needs FUSE (or WinFsp), which is not installed. */
  readonly mountPluginMissing: boolean;
  /** "Start with the computer" exists on this build. */
  readonly canStartOnLogin: boolean;
  readonly startsOnLogin: boolean;
}

/** What the guide learns from starting what it saved. */
export interface GuideExecution {
  readonly executeId?: string;
  readonly serveAddr?: string;
  readonly mountPoint?: string;
}

export interface GuideSettings {
  /** Opens the guide when a new cloud has been added. */
  readonly afterRemote: boolean;
  /** What the settings say; `auto` follows the startup view. */
  readonly setting: GuideDestinationSetting;
  /** Where that puts what the guide sets up. */
  readonly destination: GuideDestination;
}

/** What tells one setup from another when asking how it is doing. */
export type SetupIdentity = Pick<ExistingSetup, 'kind' | 'id' | 'name' | 'remoteName'>;

/** How a setup is doing now: running, or how its last run ended. */
export interface GuideSetupStatus {
  readonly state: 'running' | 'ok' | 'failed' | 'stopped' | 'idle';
  /** When the last run ended (RFC 3339). */
  readonly at?: string;
  /** Why the last run failed, as rclone reported it. */
  readonly error?: string;
}

/** What it takes to take a setup back: its name, and for a Quick Run its id. */
export interface GuideSetupRef {
  readonly name: string;
  readonly destination?: GuideDestination;
  readonly quickRun?: { readonly id: string };
  readonly execution?: GuideExecution | null;
}

export interface GuideApplyResult {
  readonly destination: GuideDestination;
  /** The name of the Quick Run or of the profile that was saved. */
  readonly name: string;
  readonly quickRun?: QuickRun;
  readonly execution: GuideExecution | null;
  /** The first two-way run finished and the next runs no longer rebuild the listings. */
  readonly firstRunDone?: boolean;
}

const ORIGIN = 'quickrun';
const HOME_LABEL = 'titlebar.home';

/**
 * Real data and actions behind the "What do you want to do?" guide. Everything it shows comes
 * from rclone or the system; nothing is estimated.
 */
@Injectable({ providedIn: 'root' })
export class IntentGuideService extends TauriBaseService {
  private readonly injector = inject(Injector);
  private readonly remoteManagement = inject(RemoteManagementService);
  private readonly diskUsage = inject(RemoteDiskUsageService);
  private readonly fileOps = inject(RemoteFileOperationsService);
  private readonly presetsService = inject(RemotePresetsService);
  private readonly systemInfo = inject(SystemInfoService);
  private readonly systemHealth = inject(SystemHealthService);
  private readonly backend = inject(BackendService);
  private readonly appSettings = inject(AppSettingsService);
  private readonly paths = inject(PathService);
  private readonly pathInspection = inject(PathInspectionService);
  private readonly opener = inject(OpenerService);
  private readonly quickRuns = inject(QuickRunService);
  private readonly jobs = inject(JobManagementService);
  private readonly mounts = inject(MountManagementService);
  private readonly serves = inject(ServeManagementService);
  private readonly facade = inject(RemoteFacadeService);

  async loadEnvironment(): Promise<GuideEnvironment> {
    const [configs, drives, startOnLogin] = await Promise.all([
      this.remoteManagement.getAllRemoteConfigs(),
      this.remoteManagement.getLocalDrives().catch((): LocalDrive[] => []),
      this.appSettings.getSettingValue<boolean>('general.start_on_startup'),
    ]);
    const remotes = Object.entries(configs).map(([name, config]) => ({
      name,
      type: String((config as { type?: unknown } | null)?.type ?? ''),
    }));
    const homeDrive = drives.find(d => d.label === HOME_LABEL) ?? drives[0];
    const home = homeDrive?.name || homeDrive?.mount_point || undefined;
    const android = isAndroid();
    return {
      remotes,
      home,
      // The drive list leaves the space of a folder that is not a mount point at 0; rclone knows.
      homeFree: home ? await this.localFree(home) : undefined,
      isServer: !this.isTauri || !this.backend.isLocalBackend(),
      isAndroid: android,
      mountPluginMissing:
        !android &&
        !this.systemHealth.skipMountPluginCheck() &&
        this.systemHealth.mountPluginInstalled() === false,
      canStartOnLogin: startOnLogin !== undefined,
      startsOnLogin: startOnLogin === true,
    };
  }

  /** Used and free bytes on the remote; empty when the backend does not report them. */
  async cloudUsage(remoteName: string): Promise<{ used?: number; free?: number }> {
    try {
      const usage = await this.diskUsage.load(remoteName);
      return { used: usage?.used, free: usage?.free };
    } catch {
      return {};
    }
  }

  /** Free bytes on the disk that holds `dir`, or on its closest existing parent. */
  async localFree(dir: string): Promise<number | undefined> {
    let current = dir;
    for (let depth = 0; current && depth < 32; depth++) {
      const free = await this.freeOf(current);
      if (free !== undefined) {
        return free;
      }
      const parent = this.paths.getParentPath(current);
      if (!parent || parent === current) {
        return undefined;
      }
      current = parent;
    }
    return undefined;
  }

  /**
   * The file manager's own way first (`operations/about` on the local path), `core/du` second.
   * A folder that does not exist yet fails both, which is why the caller walks up to its parent.
   */
  private async freeOf(dir: string): Promise<number | undefined> {
    const { root, relative } = this.paths.splitLocalForStat(dir);
    let aboutError: unknown;
    try {
      const { free } = await this.fileOps.getDiskUsage(root, relative, ORIGIN);
      if (typeof free === 'number') return free;
    } catch (error) {
      aboutError = error;
    }
    try {
      const { free } = await this.systemInfo.getLocalDiskUsage(dir);
      if (typeof free === 'number') return free;
    } catch (error) {
      console.error('[IntentGuide] No free space for', dir, { about: aboutError, du: error });
    }
    return undefined;
  }

  /** Total bytes under an rclone path, local or remote; undefined when it cannot be measured. */
  async folderSize(fs: string): Promise<number | undefined> {
    try {
      return (await this.fileOps.getSize(fs, undefined, ORIGIN)).bytes;
    } catch {
      return undefined;
    }
  }

  /** Names of the visible folders right under a local folder. */
  async localFolders(dir: string): Promise<string[]> {
    const { root, relative } = this.paths.splitLocalForStat(dir);
    return this.listFolders(root, relative);
  }

  private async listFolders(root: string, relative: string): Promise<string[]> {
    try {
      const { list } = await this.fileOps.getRemotePaths(
        root,
        relative,
        { dirsOnly: true },
        ORIGIN
      );
      return (list ?? [])
        .filter(entry => entry.IsDir && !entry.Name.startsWith('.'))
        .map(entry => entry.Name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  /** The folder the app's settings choose for a new mount or two-way copy of this remote. */
  async defaultLocalPath(remoteName: string, kind: 'mount' | 'bisync'): Promise<string> {
    try {
      return await this.pathInspection.resolveDefaultPath(remoteName, kind);
    } catch {
      return '';
    }
  }

  /**
   * Where a phone finds the share. When rclone runs here, the addresses of this machine. For a
   * remote backend those would be the wrong ones and rclone reports none of its own, so it is the
   * address the app connects to it with, unless that one only works from this machine (an SSH
   * tunnel to `localhost`).
   */
  async network(): Promise<GuideNetwork | null> {
    if (!this.backend.isLocalBackend()) {
      const active = this.backend.backends().find(b => b.name === this.backend.activeBackend());
      const host = active?.host.trim();
      return host && !isLoopbackHost(host) ? { addresses: [host], viaBackend: true } : null;
    }
    try {
      const { hostName, addresses } = await this.systemInfo.getLocalAddresses();
      return { hostName, addresses };
    } catch (error) {
      console.debug('[IntentGuide] No network addresses:', error);
      return null;
    }
  }

  /**
   * Whether a port on the machine rclone runs on is free to listen on. `null` when that is not
   * known: rclone runs elsewhere, or this build has no such check (rclone built into the app).
   */
  async portFree(port: number): Promise<boolean | null> {
    if (!this.backend.isLocalBackend()) return null;
    try {
      return await this.invokeCommand<boolean>('check_port_available', { port });
    } catch {
      return null;
    }
  }

  /** The first free port from `from` upward, for a port that is taken; `null` when unknown. */
  async nextFreePort(from: number): Promise<number | null> {
    if (!this.backend.isLocalBackend()) return null;
    try {
      return await this.invokeCommand<number>('find_available_port', { startPort: from });
    } catch {
      return null;
    }
  }

  /** Presets a new remote of this type gets on this system: VFS cache, mount type and options. */
  presets(remoteType: string): GuidePresets {
    const { vfs, mount } = this.presetsService.resolvePresets(remoteType);
    return { vfs, mount };
  }

  installMountPlugin(): void {
    void this.systemHealth.showRepairSheet({ type: RepairSheetType.MOUNT_PLUGIN });
  }

  /**
   * Runs the operation once as a dry run and reports what it would change. The temporary Quick
   * Run is removed afterwards, whatever the outcome.
   */
  async preview(
    input: QuickRunInput,
    previewName: string,
    onStarted?: (executeId: string) => void
  ): Promise<PreviewResult | null> {
    const saved = await this.quickRuns.save({ ...asDryRun(input), name: previewName });
    if (!saved) return null;
    try {
      const execution = await this.quickRuns.start(saved.id);
      if (!execution) return null;
      onStarted?.(execution.executeId);
      const job = await this.waitForJob(execution.executeId);
      if (job.status === JOB_STATUS.Failed) throw new Error(job.error || job.stats.lastError);
      // A sync, copy or move keeps a report of every file; the report is gone with the job.
      const report = FILE_REPORT_OPERATIONS.has(input.operationType)
        ? await this.jobs.getJobReport(job.jobid).catch(() => null)
        : null;
      return buildPreview(input.operationType, job.stats, report);
    } finally {
      await this.quickRuns.remove(saved.id);
    }
  }

  /** The guide's own settings, and where they say it keeps what it sets up. */
  async settings(): Promise<GuideSettings> {
    const [afterRemote, destination, defaultView] = await Promise.all([
      this.appSettings.getSettingValue<boolean>('wizard.after_remote'),
      this.appSettings.getSettingValue<string>('wizard.destination'),
      this.appSettings.getSettingValue<string>('general.default_view'),
    ]).catch(() => [undefined, undefined, undefined]);
    const setting = destination === 'quick_run' || destination === 'profile' ? destination : 'auto';
    return {
      afterRemote: afterRemote !== false,
      setting,
      destination: resolveDestination(setting, defaultView),
    };
  }

  /** `auto` becomes the destination the startup view asks for. */
  async resolveDestination(setting: GuideDestinationSetting): Promise<GuideDestination> {
    const defaultView = await this.appSettings
      .getSettingValue<string>('general.default_view')
      .catch(() => undefined);
    return resolveDestination(setting, defaultView);
  }

  saveAfterRemote(value: boolean): Promise<void> {
    return this.appSettings.saveSetting('wizard', 'after_remote', value);
  }

  saveDestination(setting: GuideDestinationSetting): Promise<void> {
    return this.appSettings.saveSetting('wizard', 'destination', setting);
  }

  /**
   * Saves the operation as a Quick Run or as a profile of the remote and starts it. A two-way
   * copy runs its first run with `--resync` and keeps what it saved without it once that run
   * succeeds.
   */
  async apply(
    input: QuickRunInput,
    guidePlan: GuidePlan,
    options: {
      destination?: GuideDestination;
      startOnLogin?: boolean;
      onStarted?: (executeId: string) => void;
    } = {}
  ): Promise<GuideApplyResult | null> {
    await this.pathInspection
      .createRequiredDirectoriesForOperation(input.operationType, input.config.rclone)
      .catch(error => console.warn('[IntentGuide] Could not prepare the folders:', error));

    const result =
      options.destination === 'profile'
        ? await this.startProfile(input, options.onStarted)
        : await this.startQuickRun(input, options.onStarted);
    if (!result) return null;

    if (options.startOnLogin) {
      await this.appSettings
        .saveSetting('general', 'start_on_startup', true)
        .catch(error =>
          console.warn('[IntentGuide] Could not turn on start with the system:', error)
        );
    }

    const executeId = result.execution?.executeId;
    if (!executeId || !guidePlan.firstRunResync) return result;
    const job = await this.waitForJob(executeId);
    if (job.status !== JOB_STATUS.Completed) return { ...result, firstRunDone: false };
    await this.keepWithoutResync(input, result);
    return { ...result, firstRunDone: true };
  }

  private async startQuickRun(
    input: QuickRunInput,
    onStarted?: (executeId: string) => void
  ): Promise<GuideApplyResult | null> {
    const quickRun = await this.quickRuns.save(input);
    if (!quickRun) return null;
    const execution = await this.quickRuns.start(quickRun.id);
    if (execution?.executeId) onStarted?.(execution.executeId);
    return { destination: 'quick_run', name: quickRun.name, quickRun, execution };
  }

  /** The remote's settings as the settings file holds them now. */
  private async remoteSettings(remoteName: string): Promise<Record<string, unknown>> {
    const all = await this.appSettings.getRemoteSettings();
    return all[remoteName] ?? {};
  }

  private async startProfile(
    input: QuickRunInput,
    onStarted?: (executeId: string) => void
  ): Promise<GuideApplyResult | null> {
    const { remoteName, operationType } = input;
    const profile = buildPlanProfile(input, await this.remoteSettings(remoteName));
    if (!profile) return null;
    await this.appSettings.saveRemoteSettings(remoteName, profile.settings);

    let execution: GuideExecution;
    if (operationType === 'mount') {
      await this.mounts.mountRemoteProfile(remoteName, profile.name, 'dashboard');
      execution = {};
    } else if (operationType === 'serve') {
      const started = await this.serves.startServeProfile(remoteName, profile.name);
      execution = { serveAddr: started.addr };
    } else {
      await this.jobs.startProfileBatch(BATCH_OP_LABELS[operationType as SyncOperationType], {
        remoteName,
        profileName: profile.name,
        source: 'dashboard',
      });
      const job = await this.waitForProfileJob(remoteName, profile.name);
      execution = { executeId: job?.execute_id };
      if (job) onStarted?.(job.execute_id);
    }
    return { destination: 'profile', name: profile.name, execution };
  }

  /**
   * Takes back what `apply` set up: stops what runs from it, then deletes the Quick Run or the
   * profile. The files in the cloud and on this computer are never touched.
   */
  async undo(
    result: GuideSetupRef,
    remoteName: string,
    operationType: PrimaryActionType
  ): Promise<void> {
    const { quickRun } = result;
    if (quickRun) {
      await this.quickRuns.stop(quickRun.id);
      await this.quickRuns.remove(quickRun.id);
      if (this.quickRuns.quickRuns().some(q => q.id === quickRun.id)) {
        throw new Error('The Quick Run could not be removed');
      }
      return;
    }
    for (const mount of this.mounts.getMountsForRemoteProfile(remoteName, result.name)) {
      await this.mounts.unmountRemote(mount.mount_point, remoteName);
    }
    for (const serve of this.serves.getServesForRemoteProfile(remoteName, result.name)) {
      await this.serves.stopServe(serve.id, remoteName);
    }
    if (result.execution?.executeId) await this.cancel(result.execution.executeId);
    const configKey = REMOTE_CONFIG_KEYS[operationType];
    const settings = await this.remoteSettings(remoteName);
    const profiles = { ...(settings[configKey] as Record<string, unknown> | undefined) };
    delete profiles[result.name];
    await this.appSettings.saveRemoteSettings(remoteName, { [configKey]: profiles });
  }

  /** Saves the profile again without the flag that only its first run needs. */
  private async keepWithoutResync(input: QuickRunInput, result: GuideApplyResult): Promise<void> {
    if (result.quickRun) {
      await this.quickRuns.save({
        id: result.quickRun.id,
        name: result.quickRun.name,
        description: result.quickRun.description,
        operationType: result.quickRun.operationType,
        remoteName: result.quickRun.remoteName,
        config: withoutResync(result.quickRun.config),
      });
      return;
    }
    const settings = await this.remoteSettings(input.remoteName);
    const configKey = REMOTE_CONFIG_KEYS[input.operationType];
    const profiles = settings[configKey] as Record<string, QuickRunInput['config']> | undefined;
    const saved = profiles?.[result.name];
    if (!saved) return;
    await this.appSettings.saveRemoteSettings(input.remoteName, {
      [configKey]: { ...profiles, [result.name]: withoutResync(saved) },
    });
  }

  /**
   * Every Quick Run and profile the guide can describe, in its own words. Profiles are read from
   * the settings of all remotes; the ones it could not have made are left out.
   */
  async loadSetups(remoteNames: readonly string[]): Promise<ExistingSetup[]> {
    const [, all] = await Promise.all([
      this.quickRuns.refresh(),
      this.appSettings.getRemoteSettings(),
    ]);
    const setups: ExistingSetup[] = [];
    for (const qr of this.quickRuns.quickRuns()) {
      const setup = describeSetup(
        {
          kind: 'quick_run',
          id: qr.id,
          name: qr.name,
          remoteName: qr.remoteName,
          operationType: qr.operationType,
          config: qr.config,
        },
        remoteNames
      );
      if (setup) setups.push(setup);
    }
    for (const [remoteName, settings] of Object.entries(all)) {
      for (const operationType of GUIDE_OPERATIONS) {
        const profiles = settings[REMOTE_CONFIG_KEYS[operationType]] as
          Record<string, unknown> | undefined;
        for (const [name, config] of Object.entries(profiles ?? {})) {
          const setup = describeSetup(
            { kind: 'profile', name, remoteName, operationType, config },
            remoteNames
          );
          if (setup) setups.push(setup);
        }
      }
    }
    return setups;
  }

  /** Starts a setup the way its own page does: a Quick Run, or a profile of the remote. */
  async startSetup(setup: ExistingSetup): Promise<void> {
    if (setup.kind === 'quick_run' && setup.id) {
      await this.quickRuns.start(setup.id);
      return;
    }
    await this.facade.startJob(
      setup.remoteName,
      setup.operationType as SyncOperationType | 'mount' | 'serve',
      setup.name
    );
  }

  /** Stops what a setup runs: its job, its mount or its share. */
  async stopSetup(setup: ExistingSetup): Promise<void> {
    if (setup.kind === 'quick_run' && setup.id) {
      await this.quickRuns.stop(setup.id);
      return;
    }
    await this.facade.stopJob(setup.remoteName, setup.operationType, undefined, setup.name);
  }

  /**
   * How a setup is doing, from the jobs, mounts and shares that exist now. A mount or share that is
   * up counts as running; otherwise the newest job of the setup tells how its last run ended.
   */
  setupStatus(setup: SetupIdentity): GuideSetupStatus {
    const mine = (item: HasStarter): boolean =>
      setup.kind === 'quick_run' ? quickRunIdOf(item) === setup.id : profileOf(item) === setup.name;
    const live =
      this.mounts.mountedRemotes().some(mount => mine(mount)) ||
      this.serves.runningServes().some(serve => mine(serve));
    const last = this.jobs
      .jobs()
      .filter(
        job => mine(job) && (setup.kind === 'quick_run' || job.remote_name === setup.remoteName)
      )
      .sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time))[0];
    if (live || last?.status === JOB_STATUS.Running) return { state: 'running' };
    if (!last) return { state: 'idle' };
    const at = last.end_time ?? last.start_time;
    switch (last.status) {
      case JOB_STATUS.Completed:
        return { state: 'ok', at };
      case JOB_STATUS.Failed:
        return { state: 'failed', at, error: last.error?.trim() || undefined };
      default:
        return { state: 'stopped', at };
    }
  }

  /** The live job of an execution, for showing its progress. */
  job(executeId: string): JobInfo | undefined {
    return this.jobs.jobs().find(job => job.execute_id === executeId);
  }

  /** Stops the job of an execution, for a preview the user no longer wants to wait for. */
  async cancel(executeId: string): Promise<void> {
    const job = this.job(executeId);
    if (job && job.status === JOB_STATUS.Running)
      await this.jobs.stopJob(job.jobid, job.remote_name);
  }

  /** Opens a local folder in the system file manager (desktop app only). */
  async openFolder(path: string): Promise<void> {
    if (!this.isTauri) return;
    await this.opener.openPath(path);
  }

  /** The job a profile started, which carries the profile's name as its starter. */
  private waitForProfileJob(remoteName: string, profileName: string): Promise<JobInfo | undefined> {
    return firstValueFrom(
      toObservable(this.jobs.jobs, { injector: this.injector }).pipe(
        map(list =>
          list.find(
            job =>
              job.remote_name === remoteName &&
              job.starter?.kind === 'profile' &&
              job.starter.name === profileName
          )
        ),
        filter((job): job is JobInfo => !!job),
        timeout(10_000)
      )
    ).catch(() => undefined);
  }

  /** Resolves once the job of this execution has stopped running. */
  private waitForJob(executeId: string): Promise<JobInfo> {
    return firstValueFrom(
      toObservable(this.jobs.jobs, { injector: this.injector }).pipe(
        map(list => list.find(job => job.execute_id === executeId)),
        filter((job): job is JobInfo => !!job && job.status !== JOB_STATUS.Running)
      )
    );
  }
}
