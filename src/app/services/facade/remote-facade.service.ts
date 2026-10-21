import {
  Injectable,
  DestroyRef,
  computed,
  inject,
  signal,
  Signal,
  WritableSignal,
  linkedSignal,
  effect,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { merge } from 'rxjs';
import { VaultService } from '../security/vault.service';
import { JobManagementService } from '../operations/job-management.service';
import { MountManagementService } from '../operations/mount-management.service';
import { ServeManagementService } from '../operations/serve-management.service';
import { RemoteDiskUsageService } from '../remote/remote-disk-usage.service';
import { RemoteManagementService } from '../remote/remote-management.service';
import { RemoteFileOperationsService } from '../remote/remote-file-operations.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { FileSystemService } from '../operations/file-system.service';
import { NautilusService } from '../ui/nautilus.service';
import { BackendService } from '../infrastructure/system/backend.service';
import { UiStateService } from '../ui/state/ui-state.service';
import { PathService } from '../infrastructure/platform/path.service';
import { RcloneStatusService } from '../infrastructure/maintenance/rclone-status.service';
import { NotificationService } from '../ui/notification.service';
import { TranslateService } from '@ngx-translate/core';
import { findUniqueName } from '../remote/utils/unique-name.util';
import { retargetProfilesRemote } from '../remote/utils/profile-mapper.utils';
import {
  Remote,
  JobActionType,
  RemoteSettings,
  SyncOperationType,
  ActionState,
  RemoteAction,
  Origin,
  RemoteConfig,
  PrimaryActionType,
  ProfileConfigMap,
  REMOTE_CONFIG_KEYS,
  BackendsRemotesLayout,
  RemotesLayout,
  BATCH_OP_LABELS,
  OPERATION_TYPE_KEYS,
  MountPathCollision,
  isProfileScoped,
} from '@app/types';
import {
  buildRemoteProfileStatus,
  readRemoteProfiles,
} from '../remote/utils/remote-profile-state.util';
import {
  deepEqual,
  extractProfileDest,
  extractProfileSource,
  getRcloneCfg,
} from 'src/app/shared/utils';
import { CoalescedTask } from 'src/app/shared/utils/coalesced-task.util';
import { abortableRequest, isAbortError } from 'src/app/shared/utils/abortable-request.util';

interface RemoteState {
  config: WritableSignal<RemoteConfig>;
  settings: WritableSignal<RemoteSettings>;
  remote: Signal<Remote>;
}

@Injectable({ providedIn: 'root' })
export class RemoteFacadeService {
  private readonly jobService = inject(JobManagementService);
  private readonly mountService = inject(MountManagementService);
  private readonly serveService = inject(ServeManagementService);
  private readonly remoteService = inject(RemoteManagementService);
  private readonly diskUsage = inject(RemoteDiskUsageService);
  private readonly remoteOpsService = inject(RemoteFileOperationsService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly eventListeners = inject(EventListenersService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly nautilusService = inject(NautilusService);
  private readonly backendService = inject(BackendService);
  private readonly uiStateService = inject(UiStateService);
  private readonly pathService = inject(PathService);
  private readonly statusService = inject(RcloneStatusService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);

  private readonly vault = inject(VaultService);
  private readonly canLoad = this.vault.isAccessible;

  readonly jobs = this.jobService.jobs;
  readonly mountedRemotes = this.mountService.mountedRemotes;
  readonly runningServes = this.serveService.runningServes;

  private readonly remoteNames = signal<string[]>([], { equal: deepEqual });
  private readonly activeNames = computed(() => new Set(this.remoteNames()));
  private readonly remoteSettings = computed<Record<string, RemoteSettings>>(() =>
    Object.fromEntries(
      this.remoteNames().map(name => [name, this.remoteStates.get(name)?.settings() ?? {}])
    )
  );

  private readonly isLoading = signal(false);
  private scope = new AbortController();

  private readonly remoteStates = new Map<string, RemoteState>();

  private readonly _actionInProgress = signal<Record<string, ActionState[]>>({});
  readonly actionInProgress = this._actionInProgress.asReadonly();

  readonly loading = computed(() => !this.vault.isStatusKnown() || this.isLoading());

  readonly activeRemotes = computed(() =>
    this.remoteNames()
      .map(name => this.remoteStates.get(name)?.remote())
      .filter((r): r is Remote => !!r)
  );

  isRemoteActive(name?: string | null): boolean {
    return !!this.findRemoteState(name);
  }

  private findRemoteState(name?: string | null): RemoteState | undefined {
    const clean = name?.replace(/:$/, '');
    return clean && this.activeNames().has(clean) ? this.remoteStates.get(clean) : undefined;
  }

  readonly selectedRemote = computed(() => {
    const name = this.uiStateService.selectedRemote()?.name;
    return this.getRemote(name);
  });

  // --- Layout ---
  private readonly _remoteLayout = linkedSignal<RemotesLayout>(() => {
    const options = this.appSettingsService.options();
    const backend = this.backendService.activeBackend();
    if (!options) return { order: [], hidden: [] };

    const allLayouts =
      (options['runtime.remote_layouts']?.value as unknown as BackendsRemotesLayout) || {};
    let layout = allLayouts[backend] || { order: [], hidden: [] };

    if (Array.isArray(layout)) layout = { order: [], hidden: [] };

    return layout;
  });

  private readonly hiddenSet = computed(() => new Set(this._remoteLayout().hidden));

  private readonly orderedNames = computed(() => {
    const names = this.remoteNames();
    const active = this.activeNames();
    const ordered = [...new Set(this._remoteLayout().order)].filter(name => active.has(name));
    const seen = new Set(ordered);
    return [...ordered, ...names.filter(name => !seen.has(name))];
  });

  /** Lightweight catalogue for filters and icons; never reads status, disk or features. */
  readonly remoteSummaries = computed(() =>
    this.orderedNames().flatMap(name => {
      const summary = this.getRemoteSummary(name);
      return summary ? [summary] : [];
    })
  );

  readonly orderedRemotes = computed(() =>
    this.orderedNames().flatMap(name => {
      const remote = this.remoteStates.get(name)?.remote();
      return remote ? [remote] : [];
    })
  );

  getRemoteSummary(name?: string | null): Pick<Remote, 'name' | 'type'> | undefined {
    const config = this.findRemoteState(name)?.config();
    return config ? { name: config.name, type: config.type } : undefined;
  }

  getRemote(name?: string | null): Remote | undefined {
    return this.findRemoteState(name)?.remote();
  }

  readonly orderedVisibleRemotes = computed(() =>
    this.orderedRemotes().filter(r => !this.hiddenSet().has(r.name))
  );

  readonly allRemotesForEditor = this.orderedRemotes;

  readonly hiddenRemoteNames = computed(() => [...this.hiddenSet()]);

  private readonly catalogueRefresh = new CoalescedTask(() => this.fetchRemotes());
  private readonly fullRefresh = new CoalescedTask(() => this.fetchAll());

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.scope.abort();
    });
    if (this.canLoad()) {
      void this.refreshAll();
    }

    this.eventListeners
      .listenToVaultState()
      .pipe(takeUntilDestroyed())
      .subscribe(payload => {
        if (payload.isLocked) this.resetCatalogue();
      });

    // Primary trigger: engine ready event (fires after caches are populated)
    this.eventListeners
      .listenToRcloneEngineReady()
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.refreshAll());

    // Secondary trigger: status changes (handles reconnection after disconnects)
    let wasAccessible = this.canLoad();
    let previousStatus = this.statusService.rcloneStatus();
    effect(() => {
      const accessible = this.canLoad();
      const status = this.statusService.rcloneStatus();
      if (accessible && (!wasAccessible || (status === 'active' && previousStatus !== 'active'))) {
        untracked(() => void this.refreshAll());
      }
      wasAccessible = accessible;
      previousStatus = status;
    });

    // Event-driven reactive store updates:
    // REMOTE_CACHE_CHANGED (remotes created/edited/deleted),
    // REMOTE_SETTINGS_CHANGED (profiles/settings modified/reset), and
    // BACKEND_SWITCHED (active backend changed).
    merge(
      this.eventListeners.listenToRemoteCacheUpdated(),
      this.eventListeners.listenToRemoteSettingsChanged()
    )
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.loadRemotes());

    this.eventListeners
      .listenToBackendSwitched()
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        this.resetCatalogue();
        void this.loadRemotes();
      });

    this.eventListeners
      .listenToSystemSettingsChanged()
      .pipe(takeUntilDestroyed())
      .subscribe(payload => {
        if (payload.category === '*') {
          void this.refreshAll();
        }
      });
  }

  private resetCatalogue(): void {
    this.scope.abort();
    this.scope = new AbortController();
    this.remoteNames.set([]);
    this.remoteStates.clear();
    this._actionInProgress.set({});
  }

  // --- Settings & Path Collisions ---

  getRemoteSettings(remoteName: string): RemoteSettings {
    return this.findRemoteState(remoteName)?.settings() ?? {};
  }

  checkMountPathCollision(
    proposedPath: string,
    currentRemoteName: string,
    currentProfileName?: string
  ): MountPathCollision[] {
    return this.pathService.checkMountPathCollision(
      proposedPath,
      currentRemoteName,
      this.remoteSettings(),
      currentProfileName
    );
  }

  async updateRemoteSettings(remoteName: string, updates: Partial<RemoteSettings>): Promise<void> {
    try {
      await this.appSettingsService.saveRemoteSettings(remoteName, updates);
      this.notificationService.showSuccess(
        this.translate.instant('settings.remoteSaved', { remote: remoteName })
      );
    } catch (error) {
      this.notificationService.showError(
        this.translate.instant('settings.remoteSaveFailed', {
          remote: remoteName,
          error: String(error),
        })
      );
      throw error;
    }
  }

  // --- Data Loading ---

  loadRemotes(): Promise<void> {
    return this.canLoad() ? this.catalogueRefresh.run() : Promise.resolve();
  }

  private async fetchRemotes(): Promise<void> {
    if (!this.canLoad()) return;
    const scope = this.scope;
    this.isLoading.set(true);
    try {
      const [configs, settings] = await abortableRequest(scope.signal, () =>
        Promise.all([
          this.remoteService.getAllRemoteConfigs(),
          this.appSettingsService.getRemoteSettings(),
        ])
      );
      if (!this.canLoad() || scope.signal.aborted) return;
      const incomingNames = Object.keys(configs);
      const currentNames = Array.from(this.remoteStates.keys());
      const incoming = new Set(incomingNames);

      for (const name of currentNames) {
        if (!incoming.has(name)) {
          this.remoteStates.delete(name);
          this.remoteService.clearCache(name);
          this.diskUsage.clear(name);
        }
      }

      for (const name of incomingNames) {
        const config = { ...(configs[name] as Record<string, unknown>), name } as RemoteConfig;
        const state = this.remoteStates.get(name);

        if (state) {
          const prevConfig = state.config();
          if (!deepEqual(prevConfig, config)) {
            this.remoteService.clearCache(name);
            this.diskUsage.clear(name);
            state.config.set(config);
          }
          state.settings.set(settings[name] ?? {});
        } else {
          this.createRemoteState(config, settings[name] ?? {});
        }
      }

      this.remoteNames.set(incomingNames);
      this.diskUsage.prefetch(incomingNames);
    } catch (error) {
      if (!isAbortError(error))
        console.error('[RemoteFacadeService] Error loading remotes:', error);
    } finally {
      this.isLoading.set(false);
    }
  }

  // --- Layout Operations ---

  async saveCurrentLayout(backendName: string, newNames: string[]): Promise<void> {
    const activeNames = new Set(this.remoteNames());
    await this.persistLayout(backendName, {
      order: newNames,
      hidden: this._remoteLayout().hidden.filter(name => activeNames.has(name)),
    });
  }

  async toggleRemoteVisibility(backendName: string, remoteName: string): Promise<void> {
    const currentLayout = this._remoteLayout();
    const hiddenSet = new Set(currentLayout.hidden);

    if (hiddenSet.has(remoteName)) {
      hiddenSet.delete(remoteName);
    } else {
      hiddenSet.add(remoteName);
    }

    const activeNames = new Set(this.remoteNames());
    await this.persistLayout(backendName, {
      order: this.orderedNames(),
      hidden: Array.from(hiddenSet).filter(name => activeNames.has(name)),
    });
  }

  private async persistLayout(backendName: string, layout: RemotesLayout): Promise<void> {
    const options = this.appSettingsService.options();
    const allLayouts =
      (options?.['runtime.remote_layouts']?.value as unknown as BackendsRemotesLayout) || {};
    this._remoteLayout.set(layout);
    await this.appSettingsService.saveSetting('runtime', 'remote_layouts', {
      ...allLayouts,
      [backendName]: layout,
    });
  }

  refreshAll(): Promise<void> {
    return this.canLoad() ? this.fullRefresh.run() : Promise.resolve();
  }

  private async fetchAll(): Promise<void> {
    if (!this.canLoad()) return;
    const scope = this.scope;
    try {
      const results = await abortableRequest(scope.signal, () =>
        Promise.allSettled([
          this.loadRemotes(),
          this.statusService.refreshStatus(),
          this.mountService.getMountedRemotes(),
          this.serveService.refreshServes(),
          this.jobService.refreshJobs(),
        ])
      );
      if (!this.canLoad() || scope.signal.aborted) return;
      for (const result of results) {
        if (result.status === 'rejected' && !isAbortError(result.reason)) {
          console.error('[RemoteFacadeService] Failed to refresh remote data:', result.reason);
        }
      }
    } catch (error) {
      if (!isAbortError(error)) throw error;
    }
  }

  // --- Action State ---

  canEmptyTrash(remote: { name: string; type?: string }): boolean {
    return this.remoteService.hasFeature(remote.name, 'CleanUp');
  }

  async emptyTrash(
    remote: { name: string; type?: string; isLocal?: boolean },
    origin: Origin = 'dashboard'
  ): Promise<boolean> {
    const scope = this.scope;
    const confirmed = await this.notificationService.confirmModal(
      this.translate.instant('nautilus.modals.emptyTrash.title'),
      this.translate.instant('nautilus.modals.emptyTrash.message', { remote: remote.name }),
      'common.delete',
      'common.cancel',
      { icon: 'trash', color: 'warn' }
    );
    if (!confirmed || scope.signal.aborted) return false;

    try {
      const isLocal = remote.isLocal ?? false;
      const normalized = isLocal
        ? remote.name
        : this.pathService.normalizeRemoteForRclone(remote.name);
      await this.remoteOpsService.cleanup(normalized, undefined, origin);
      this.notificationService.showInfo(
        this.translate.instant('nautilus.notifications.trashEmptied')
      );
      return true;
    } catch (e) {
      this.notificationService.showError(
        this.translate.instant('nautilus.errors.emptyTrashFailed', {
          error: (e as Error).message,
        })
      );
      return false;
    }
  }

  async executeAction<T>(
    remoteName: string,
    action: RemoteAction,
    operation: () => Promise<T>,
    profileName?: string,
    operationType?: PrimaryActionType
  ): Promise<T> {
    const entry = { type: action, profileName, operationType };
    this.addAction(remoteName, entry);
    try {
      return await operation();
    } finally {
      this.removeAction(remoteName, entry);
    }
  }

  private addAction(remoteName: string, entry: ActionState): void {
    this._actionInProgress.update(state => ({
      ...state,
      [remoteName]: [...(state[remoteName] ?? []), entry],
    }));
  }

  private removeAction(remoteName: string, entry: ActionState): void {
    this._actionInProgress.update(state => {
      const actions = state[remoteName];
      if (!actions?.includes(entry)) return state;
      const next = { ...state };
      const remaining = actions.filter(action => action !== entry);
      if (remaining.length) next[remoteName] = remaining;
      else delete next[remoteName];
      return next;
    });
  }

  // --- Operations ---

  async startJob(
    remoteName: string,
    opType: SyncOperationType | 'mount' | 'serve',
    profileName: string,
    source: Origin = 'dashboard',
    noCache?: boolean
  ): Promise<void> {
    if (!profileName) {
      throw new Error(
        `Cannot start ${opType} on ${remoteName}: no profile specified. Pick a profile first.`
      );
    }
    const settings = this.getRemoteSettings(remoteName);
    const configKey = REMOTE_CONFIG_KEYS[
      opType as keyof typeof REMOTE_CONFIG_KEYS
    ] as keyof RemoteSettings;
    const profiles = settings[configKey] as Record<string, Record<string, unknown>> | undefined;

    if (!profiles?.[profileName]) {
      throw new Error(
        `Configuration for ${opType} profile '${profileName}' not found on ${remoteName}.`
      );
    }

    await this.executeAction(
      remoteName,
      opType as RemoteAction,
      () => this.dispatchJobStart(opType, remoteName, profileName, source, noCache),
      profileName,
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
    if (opType === 'mount') {
      return this.mountService.mountRemoteProfile(remoteName, profile, source, noCache);
    }
    if (opType === 'serve') {
      return this.serveService.startServeProfile(remoteName, profile);
    }

    const label = BATCH_OP_LABELS[opType];
    if (!label) throw new Error(`Unsupported operation: ${opType}`);

    return this.jobService.startProfileBatch(label, {
      remoteName,
      profileName: profile,
      source,
      noCache,
    });
  }

  async stopJob(
    remoteName: string,
    type: JobActionType,
    serveId: string | undefined,
    profileName: string | undefined
  ): Promise<void> {
    if (!profileName && !serveId) {
      throw new Error(
        `Cannot stop ${type} on ${remoteName}: no profile specified. Pick a profile first.`
      );
    }
    const trackerOpType = OPERATION_TYPE_KEYS.has(type) ? (type as PrimaryActionType) : undefined;
    await this.executeAction(
      remoteName,
      'stop',
      () => this.dispatchJobStop(remoteName, type, serveId, profileName),
      profileName,
      trackerOpType
    );
  }

  private async dispatchJobStop(
    remoteName: string,
    type: JobActionType,
    serveId?: string,
    profileName?: string
  ): Promise<void> {
    if (type === 'serve') {
      const serves = this.runningServes().filter(
        s => this.pathService.getRemoteNameFromFs(s.params?.fs) === remoteName && isProfileScoped(s)
      );
      const idToStop =
        serveId ?? (profileName ? serves.find(s => s.profile === profileName)?.id : serves[0]?.id);
      if (!idToStop) throw new Error('Serve ID required to stop serve');
      await this.serveService.stopServe(idToStop, remoteName);
      return;
    }

    if (type === 'mount') {
      const mounts = this.mountedRemotes().filter(
        m => this.pathService.getRemoteNameFromFs(m.fs) === remoteName && isProfileScoped(m)
      );
      const mountPoint = profileName
        ? mounts.find(m => m.profile === profileName)?.mount_point
        : mounts[0]?.mount_point;
      if (!mountPoint) throw new Error(`Active mount not found for ${remoteName}`);
      await this.mountService.unmountRemote(mountPoint, remoteName);
      return;
    }

    const remote = remoteName.replace(/:$/, '');
    const groupName = profileName ? `${type}/${remote}/${profileName}` : `${type}/${remote}`;
    await this.jobService.stopJobsByGroup(groupName);
  }

  async deleteRemote(remoteName: string): Promise<void> {
    const backendName = this.backendService.activeBackend();
    await this.executeAction(remoteName, 'delete', async () => {
      await this.remoteService.deleteRemote(remoteName, backendName);
      await this.refreshAll();
      this.notificationService.showSuccess(
        this.translate.instant('backendSuccess.remote.deleted', { name: remoteName })
      );
    });
  }

  async openRemoteInFiles(
    remoteName: string,
    pathOrOperation?: string,
    profileName?: string,
    operationType?: PrimaryActionType
  ): Promise<void> {
    let path = pathOrOperation ?? '';

    if (OPERATION_TYPE_KEYS.has(path)) {
      const settings = this.getRemoteSettings(remoteName);
      const configKey = REMOTE_CONFIG_KEYS[path as keyof typeof REMOTE_CONFIG_KEYS];
      const profiles = settings[configKey as keyof RemoteSettings] as ProfileConfigMap | undefined;
      const profile = profileName ? profiles?.[profileName] : Object.values(profiles ?? {})[0];
      const rclone = getRcloneCfg(profile) ?? profile;
      const destination = extractProfileDest(rclone) ?? extractProfileSource(rclone);
      path = typeof destination === 'string' ? destination : '';
    }

    if (this.pathService.isLocalPath(path) || path.startsWith('saf://')) {
      await this.executeAction(
        remoteName,
        'open',
        () => this.fileSystemService.openInFiles(path),
        profileName,
        operationType
      );
    } else {
      await this.executeAction(
        remoteName,
        'open',
        async () => {
          const { remote: targetRemoteName, path: relativePath } =
            this.pathService.splitFsPath(path);
          await this.nautilusService.newNautilusWindow(
            targetRemoteName || remoteName,
            relativePath
          );
        },
        profileName,
        operationType
      );
    }
  }

  private generateUniqueCloneName(baseName: string): string {
    const cleanBase = baseName.replace(/-(?:clone|\d+)+$/, '');
    return findUniqueName(`${cleanBase}-clone`, Array.from(this.remoteStates.keys()));
  }

  async cloneRemote(remoteName: string): Promise<RemoteSettings | null> {
    const base = this.remoteStates.get(remoteName)?.config();
    if (!base) return null;

    const newName = this.generateUniqueCloneName(base.name);
    const settings = structuredClone(this.getRemoteSettings(remoteName)) as RemoteSettings;
    const retargetedSettings = retargetProfilesRemote(settings, remoteName, newName);

    return {
      ...retargetedSettings,
      config: { ...base, name: newName },
      name: newName,
    };
  }

  async deleteJob(jobId: number): Promise<void> {
    await this.jobService.deleteJob(jobId);
  }

  private createRemoteState(config: RemoteConfig, settings: RemoteSettings): void {
    const name = config.name;
    const configState = signal(config);
    const settingsState = signal(settings ?? {}, { equal: deepEqual });
    const state: RemoteState = {
      config: configState,
      settings: settingsState,
      remote: this.createRemoteSignal(name, configState, settingsState),
    };
    this.remoteStates.set(name, state);
  }

  private createRemoteSignal(
    name: string,
    configState: Signal<RemoteConfig>,
    settingsState: Signal<RemoteSettings>
  ): Signal<Remote> {
    // Group stores emit for all remotes. Preserve unchanged per-remote inputs across polls.
    const jobs = computed(() => this.jobService.jobsByRemote()[name] ?? [], { equal: deepEqual });
    const mounts = computed(() => this.mountService.mountsByRemote()[name] ?? [], {
      equal: deepEqual,
    });
    const serves = computed(() => this.serveService.servesByRemote()[name] ?? [], {
      equal: deepEqual,
    });
    const profiles = computed(() => readRemoteProfiles(settingsState()));
    const status = computed(() =>
      buildRemoteProfileStatus({
        profiles: profiles(),
        jobs: jobs(),
        mounts: mounts(),
        serves: serves(),
      })
    );
    return computed(() => ({
      name,
      type: configState().type,
      config: configState(),
      primaryActions: profiles().primaryActions,
      syncActions: profiles().syncActions,
      status: { ...status(), diskUsage: this.diskUsage.usage(name)() },
      features: this.remoteService.getFeaturesSignal(name)(),
    }));
  }
}
