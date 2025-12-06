import {
  Component,
  HostListener,
  OnDestroy,
  OnInit,
  effect,
  inject,
  signal,
  computed,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatDrawerMode, MatSidenavModule } from '@angular/material/sidenav';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog } from '@angular/material/dialog';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { CdkMenuModule } from '@angular/cdk/menu';
import { catchError, EMPTY, Subject, takeUntil } from 'rxjs';

// App Types
import {
  // AppTab,
  DiskUsage,
  JobInfo,
  MountedRemote,
  PrimaryActionType,
  Remote,
  RemoteAction,
  RemoteActionProgress,
  RemoteSettings,
  STANDARD_MODAL_SIZE,
  SyncOperationType,
  ServeListItem,
} from '@app/types';

// App Components
import { SidebarComponent } from '../layout/sidebar/sidebar.component';
import { GeneralDetailComponent } from '../features/components/dashboard/general-detail/general-detail.component';
import { GeneralOverviewComponent } from '../features/components/dashboard/general-overview/general-overview.component';
import { AppDetailComponent } from '../features/components/dashboard/app-detail/app-detail.component';
import { AppOverviewComponent } from '../features/components/dashboard/app-overview/app-overview.component';
import { ServeOverviewComponent } from '../features/components/dashboard/serve-overview/serve-overview.component';
import { ServeDetailComponent } from '../features/components/dashboard/serve-detail/serve-detail.component';
import { LogsModalComponent } from '../features/modals/monitoring/logs-modal/logs-modal.component';
import { ExportModalComponent } from '../features/modals/settings/export-modal/export-modal.component';
import { RemoteConfigModalComponent } from '../features/modals/remote-management/remote-config-modal/remote-config-modal.component';
import { QuickAddRemoteComponent } from '../features/modals/remote-management/quick-add-remote/quick-add-remote.component';

// App Services
import { IconService } from '../shared/services/icon.service';
import { NotificationService } from '../shared/services/notification.service';
import {
  EventListenersService,
  UiStateService,
  MountManagementService,
  RemoteManagementService,
  JobManagementService,
  SystemInfoService,
  AppSettingsService,
  ServeManagementService,
  PathSelectionService,
} from '@app/services';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [
    MatSidenavModule,
    MatDividerModule,
    MatChipsModule,
    MatCardModule,
    MatTooltipModule,
    MatCheckboxModule,
    MatIconModule,
    MatButtonModule,
    MatToolbarModule,
    CdkMenuModule,
    SidebarComponent,
    GeneralDetailComponent,
    GeneralOverviewComponent,
    AppDetailComponent,
    AppOverviewComponent,
    ServeOverviewComponent,
    ServeDetailComponent,
  ],
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.scss'],
})
export class HomeComponent implements OnInit, OnDestroy {
  // ============================================================================
  // PROPERTIES - SERVICES
  // ============================================================================
  private readonly dialog = inject(MatDialog);
  private readonly uiStateService = inject(UiStateService);
  private readonly mountManagementService = inject(MountManagementService);
  private readonly serveManagementService = inject(ServeManagementService);
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly jobManagementService = inject(JobManagementService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly notificationService = inject(NotificationService);
  private readonly eventListenersService = inject(EventListenersService);
  private readonly pathSelectionService = inject(PathSelectionService);
  readonly systemInfoService = inject(SystemInfoService);
  readonly iconService = inject(IconService);

  // ============================================================================
  // PROPERTIES - DATA & UI STATE
  // ============================================================================
  currentTab = toSignal(this.uiStateService.currentTab$, { initialValue: 'general' as any });

  // Source of truth for SELECTION (from service)
  private readonly _selectedRemoteSource = toSignal(this.uiStateService.selectedRemote$, {
    initialValue: null as Remote | null,
  });

  // Local data state
  jobs = signal<JobInfo[]>([]);
  remotes = signal<Remote[]>([]);
  remoteSettings = signal<RemoteSettings>({});

  // Computed Source of truth for the OBJECT (merging selection with fresh data)
  // This ensures that when 'remotes' updates (e.g. job started), the UI sees the new object immediately.
  readonly selectedRemote = computed(() => {
    const source = this._selectedRemoteSource();
    const allRemotes = this.remotes();

    if (!source) return null;

    // Find the up-to-date object in the list using the name from the selection
    // If not found (e.g. during loading), fallback to the source object
    return allRemotes.find(r => r.remoteSpecs.name === source.remoteSpecs.name) || source;
  });

  selectedRemoteSettings = computed(() => {
    const remote = this.selectedRemote();
    if (!remote) return {};
    return this.loadRemoteSettings(remote.remoteSpecs.name);
  });

  mountedRemotes = toSignal(this.mountManagementService.mountedRemotes$, {
    initialValue: [] as MountedRemote[],
  });
  runningServes = toSignal(this.serveManagementService.runningServes$, {
    initialValue: [] as ServeListItem[],
  });

  // Local UI state
  isSidebarOpen = signal(false);
  sidebarMode = signal<MatDrawerMode>('side');
  selectedSyncOperation = signal<SyncOperationType>('sync');
  isLoading = signal(false);
  restrictMode = signal(true);
  actionInProgress = signal<RemoteActionProgress>({});

  // ============================================================================
  // PROPERTIES - LIFECYCLE
  // ============================================================================
  private destroy$ = new Subject<void>();
  private resizeObserver?: ResizeObserver;

  constructor() {
    // Reactive side effects for when service data changes
    effect(() => {
      this.mountedRemotes(); // depend on mountedRemotes signal
      this.updateRemoteMountStates();
    });

    effect(() => {
      this.runningServes(); // depend on runningServes signal
      this.updateRemoteServeStates();
    });

    effect(() => {
      const remote = this.selectedRemote();
      if (remote) {
        const settings = this.selectedRemoteSettings();
        // Only set this if it differs to avoid loops, though signal set() handles equality check
        const currentOp = this.selectedSyncOperation();
        const savedOp = (settings['selectedSyncOperation'] as SyncOperationType) || 'sync';
        if (currentOp !== savedOp) {
          this.selectedSyncOperation.set(savedOp);
        }
      }
    });
  }

  // ============================================================================
  // LIFECYCLE HOOKS
  // ============================================================================
  async ngOnInit(): Promise<void> {
    try {
      this.setupResponsiveLayout();
      await this.loadRestrictMode();
      await this.loadInitialData();
      this.setupTauriListeners();
    } catch (error) {
      this.handleError('Failed to initialize component', error);
    }
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  // ============================================================================
  // UI & LAYOUT
  // ============================================================================
  @HostListener('window:resize')
  onResize(): void {
    this.updateSidebarMode();
  }

  private setupResponsiveLayout(): void {
    this.updateSidebarMode();
    this.setupResizeObserver();
  }

  private updateSidebarMode(): void {
    const newMode: MatDrawerMode = window.innerWidth < 900 ? 'over' : 'side';
    if (newMode !== this.sidebarMode()) {
      this.sidebarMode.set(newMode);
    }
  }

  private setupResizeObserver(): void {
    if (typeof window !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.updateSidebarMode());
      this.resizeObserver.observe(document.body);
    }
  }

  // ============================================================================
  // DATA INITIALIZATION
  // ============================================================================
  private async loadInitialData(): Promise<void> {
    this.isLoading.set(true);
    try {
      await this.refreshData();
    } catch (error) {
      this.handleError('Initial data load failed', error);
    } finally {
      this.isLoading.set(false);
    }
  }

  private async refreshData(): Promise<void> {
    await this.getRemoteSettings();
    await this.mountManagementService.getMountedRemotes();
    await this.serveManagementService.refreshServes();
    await this.loadRemotes();
    await this.loadJobs();
  }

  private async loadRemotes(): Promise<void> {
    try {
      const remoteConfigs = await this.remoteManagementService.getAllRemoteConfigs();
      this.remotes.set(this.createRemotesFromConfigs(remoteConfigs));
      await this.loadActiveJobs();
      this.loadDiskUsageInBackground();
    } catch (error) {
      this.handleError('Failed to load remotes', error);
    }
  }

  private async loadJobs(): Promise<void> {
    try {
      this.jobs.set(await this.jobManagementService.getJobs());
    } catch (error) {
      this.handleError('Failed to load jobs', error);
      throw error;
    }
  }

  private createRemotesFromConfigs(remoteConfigs: Record<string, unknown>): Remote[] {
    const mountedSet = new Set(this.mountedRemotes().map(m => m.fs.split(':')[0]));
    const currentServes = this.runningServes();
    const currentRemotes = this.remotes();

    return Object.keys(remoteConfigs).map(name => {
      const existingRemote = currentRemotes.find(r => r.remoteSpecs.name === name);
      const settings = this.loadRemoteSettings(name);
      const remoteServes = currentServes.filter(s => s.params.fs.split(':')[0] === name);
      return {
        remoteSpecs: { name, ...(remoteConfigs[name] as { type: string }) },
        primaryActions: settings['primaryActions'] || [],
        diskUsage: existingRemote?.diskUsage || {
          total_space: 0,
          used_space: 0,
          free_space: 0,
          loading: true,
        },
        mountState: { mounted: mountedSet.has(name) },
        serveState: {
          hasActiveServes: remoteServes.length > 0,
          serveCount: remoteServes.length,
          serves: remoteServes,
        },
        syncState: this.getInitialJobState(settings, 'sync', existingRemote?.syncState),
        copyState: this.getInitialJobState(settings, 'copy', existingRemote?.copyState),
        bisyncState: this.getInitialJobState(settings, 'bisync', existingRemote?.bisyncState),
        moveState: this.getInitialJobState(settings, 'move', existingRemote?.moveState),
      };
    });
  }

  private getInitialJobState(
    settings: RemoteSettings,
    jobType: SyncOperationType,
    existingState?: any /* JobState */
  ): any /* JobState */ {
    const config = settings[`${jobType}Config`];
    const jobIDKey = `${jobType}JobID`;
    const isOnKey = `isOn${jobType.charAt(0).toUpperCase() + jobType.slice(1)}`;

    if (existingState) {
      return { ...existingState, isLocal: this.isLocalPath(config?.dest || '') };
    }
    return {
      [isOnKey]: false,
      [jobIDKey]: 0,
      isLocal: this.isLocalPath(config?.dest || ''),
    };
  }

  private async updateRemoteDiskUsage(remote: Remote): Promise<void> {
    const updateDiskUsage = (updates: Partial<DiskUsage>): void => {
      this.remotes.update(remotes =>
        remotes.map(r =>
          r.remoteSpecs.name === remote.remoteSpecs.name
            ? { ...r, diskUsage: { ...r.diskUsage, ...updates } }
            : r
        )
      );
    };

    updateDiskUsage({ loading: true });

    try {
      const fsName = this.pathSelectionService.normalizeRemoteForRclone(remote.remoteSpecs.name);
      const fsInfo = await this.remoteManagementService.getFsInfo(fsName);
      if ((fsInfo as any).Features?.About === false) {
        updateDiskUsage({
          total_space: 0,
          used_space: 0,
          free_space: 0,
          notSupported: true,
          loading: false,
          error: false,
        });
        return;
      }

      const usage = await this.remoteManagementService.getDiskUsage(fsName);
      updateDiskUsage({
        total_space: usage.total || -1,
        used_space: usage.used || -1,
        free_space: usage.free || -1,
        loading: false,
        error: false,
        notSupported: false,
      });
    } catch (error) {
      updateDiskUsage({ loading: false, error: true });
      console.error(`Failed to update disk usage for ${remote.remoteSpecs.name}`, error);
    }
  }

  private loadDiskUsageInBackground(): void {
    this.remotes()
      .filter(remote => {
        const du = remote.diskUsage;
        return !du || du.loading || du.error;
      })
      .forEach(remote => {
        this.updateRemoteDiskUsage(remote).catch(error => {
          console.error(
            `Background disk usage update failed for ${remote.remoteSpecs.name}:`,
            error
          );
        });
      });
  }

  private async loadActiveJobs(): Promise<void> {
    try {
      await this.jobManagementService.getActiveJobs();
      this.updateRemotesWithJobs();
    } catch (error) {
      this.handleError('Failed to load active jobs', error);
    }
  }

  // ============================================================================
  // TAURI EVENT LISTENERS
  // ============================================================================
  private setupTauriListeners(): void {
    this.listenToMountCache();
    this.listenToRemoteCache();
    this.listenToRcloneEngine();
    this.listenToJobCache();
  }

  private listenToMountCache(): void {
    this.eventListenersService
      .listenToMountCacheUpdated()
      .pipe(
        takeUntil(this.destroy$),
        catchError(error => (console.error('Event listener error (MountCache):', error), EMPTY))
      )
      .subscribe({
        next: async () => {
          try {
            await this.mountManagementService.getMountedRemotes();
          } catch (error) {
            this.handleError('Error handling mount_state_changed', error);
          }
        },
      });
  }

  private listenToRemoteCache(): void {
    this.eventListenersService
      .listenToRemoteCacheUpdated()
      .pipe(
        takeUntil(this.destroy$),
        catchError(error => (console.error('Event listener error (RemoteCache):', error), EMPTY))
      )
      .subscribe({
        next: async () => {
          try {
            await this.getRemoteSettings();
            await this.loadRemotes();
            await this.loadRestrictMode();
          } catch (error) {
            this.handleError('Error handling remote_cache_updated', error);
          }
        },
      });
  }

  private listenToRcloneEngine(): void {
    this.eventListenersService
      .listenToRcloneEngineReady()
      .pipe(
        takeUntil(this.destroy$),
        catchError(
          error => (console.error('Event listener error (RcloneEngineReady):', error), EMPTY)
        )
      )
      .subscribe({
        next: async () => {
          try {
            await this.refreshData();
            await this.loadRestrictMode();
          } catch (error) {
            this.handleError('Error handling rclone_engine_ready', error);
          }
        },
      });
  }

  private listenToJobCache(): void {
    this.eventListenersService
      .listenToJobCacheChanged()
      .pipe(
        takeUntil(this.destroy$),
        catchError(error => (console.error('Event listener error (JobCache):', error), EMPTY))
      )
      .subscribe({
        next: async () => {
          try {
            await this.loadJobs();
            await this.loadActiveJobs();
          } catch (error) {
            this.handleError('Error handling job_cache_changed', error);
          }
        },
      });
  }

  // ============================================================================
  // REMOTE SELECTION & STATE
  // ============================================================================
  selectRemote(remote: Remote): void {
    this.uiStateService.setSelectedRemote(remote);
  }

  onSyncOperationChange(operation: SyncOperationType): void {
    this.selectedSyncOperation.set(operation);
    const remote = this.selectedRemote();
    if (remote?.remoteSpecs.name) {
      this.saveRemoteSettings(remote.remoteSpecs.name, { selectedSyncOperation: operation });
    }
  }

  async togglePrimaryAction(type: PrimaryActionType): Promise<void> {
    //Has problems
    const remote = this.selectedRemote();
    if (!remote) return;

    const remoteName = remote.remoteSpecs.name;
    const currentActions = remote.primaryActions || [];
    const newActions = currentActions.includes(type)
      ? currentActions.filter(action => action !== type)
      : [...currentActions, type];

    try {
      await this.appSettingsService.saveRemoteSettings(remoteName, { primaryActions: newActions });
      this.remotes.update(remotes =>
        remotes.map(r =>
          r.remoteSpecs.name === remoteName ? { ...r, primaryActions: newActions } : r
        )
      );
    } catch (error) {
      this.handleError('Failed to update quick actions', error);
    }
  }

  // ============================================================================
  // REMOTE & JOB OPERATIONS
  // ============================================================================
  async mountRemote(remoteName: string, settings: any): Promise<void> {
    await this.executeRemoteAction(
      remoteName,
      'mount',
      () =>
        this.mountManagementService.mountRemote(
          remoteName,
          settings.mountConfig.source,
          settings.mountConfig.dest,
          settings.mountConfig.type,
          settings.mountConfig.options,
          settings.vfsConfig || {},
          settings.filterConfig || {},
          settings.backendConfig || {}
        ),
      `Failed to mount ${remoteName}`
    );
  }

  async unmountRemote(remoteName: string): Promise<void> {
    await this.executeRemoteAction(
      remoteName,
      'unmount',
      async () => {
        const mountPoint = this.getMountPoint(remoteName);
        if (!mountPoint) throw new Error(`No mount point found for ${remoteName}`);
        await this.mountManagementService.unmountRemote(mountPoint, remoteName);
      },
      `Failed to unmount ${remoteName}`
    );
  }

  async openRemoteInFiles(remoteName: string, usePath: PrimaryActionType): Promise<void> {
    await this.executeRemoteAction(
      remoteName,
      'open',
      () =>
        this.mountManagementService.openInFiles(
          this.getPathForOperation(remoteName, usePath) || ''
        ),
      `Failed to open ${remoteName}`
    );
  }

  async openRemoteInFilesWithPath(remoteName: string, path?: string): Promise<void> {
    await this.executeRemoteAction(
      remoteName,
      'open',
      () => this.mountManagementService.openInFiles(path || ''),
      `Failed to open ${remoteName}`
    );
  }

  async deleteRemote(remoteName: string): Promise<void> {
    if (!remoteName) return;
    try {
      const confirmed = await this.notificationService.confirmModal(
        'Delete Confirmation',
        `Are you sure you want to delete '${remoteName}'? This action cannot be undone.`
      );
      if (!confirmed) return;
      await this.executeRemoteAction(
        remoteName,
        null,
        async () => {
          if (this.isRemoteMounted(remoteName)) {
            await this.unmountRemote(remoteName);
          }
          await this.remoteManagementService.deleteRemote(remoteName);
          this.handleRemoteDeletion(remoteName);
        },
        `Failed to delete remote ${remoteName}`
      );
      this.uiStateService.setSelectedRemote(null);
    } catch (error) {
      this.handleError(`Failed to delete remote ${remoteName}`, error);
    }
  }

  async startJob(operationType: PrimaryActionType, remoteName: string): Promise<void> {
    await this.executeRemoteAction(
      remoteName,
      operationType as RemoteAction,
      async () => {
        const settings = this.loadRemoteSettings(remoteName);
        const config = settings[`${operationType}Config`];
        if (!config)
          throw new Error(`Configuration for ${operationType} not found on ${remoteName}.`);

        switch (operationType) {
          case 'mount':
            await this.mountRemote(remoteName, settings);
            break;
          case 'sync':
            await this.jobManagementService.startSync(
              remoteName,
              config.source,
              config.dest,
              config.createEmptySrcDirs,
              config.options,
              settings['filterConfig'],
              settings['backendConfig']
            );
            break;
          case 'copy':
            await this.jobManagementService.startCopy(
              remoteName,
              config.source,
              config.dest,
              config.createEmptySrcDirs,
              config.options,
              settings['filterConfig'],
              settings['backendConfig']
            );
            break;
          case 'bisync':
            await this.jobManagementService.startBisync(
              remoteName,
              config.source,
              config.dest,
              config.options,
              settings['filterConfig'],
              settings['backendConfig'],
              config.dryRun,
              config.resync,
              config.checkAccess,
              config.checkFilename,
              config.maxDelete,
              config.force,
              config.checkSync,
              config.createEmptySrcDirs,
              config.removeEmptyDirs,
              config.filtersFile,
              config.ignoreListingChecksum,
              config.resilient,
              config.workdir,
              config.backupdir1,
              config.backupdir2,
              config.noCleanup
            );
            break;
          case 'move':
            await this.jobManagementService.startMove(
              remoteName,
              config.source,
              config.dest,
              config.createEmptySrcDirs,
              config.deleteEmptySrcDirs,
              config.options,
              settings['filterConfig'],
              settings['backendConfig']
            );
            break;
          case 'serve':
            await this.serveManagementService.startServe(
              remoteName,
              config.options,
              settings['filterConfig'],
              settings['backendConfig'],
              config.vfsConfig
            );
            break;
          default:
            throw new Error(`Unsupported operation type: ${operationType}`);
        }
      },
      `Failed to start ${operationType} for ${remoteName}`
    );
  }

  async stopJob(type: PrimaryActionType, remoteName: string, serveId?: string): Promise<void> {
    await this.executeRemoteAction(
      remoteName,
      'stop',
      async () => {
        if (type === 'mount') {
          await this.unmountRemote(remoteName);
        } else if (type === 'serve') {
          if (!serveId) throw new Error('Serve ID is required to stop a serve');
          await this.serveManagementService.stopServe(serveId, remoteName);
        } else {
          const remote = this.remotes().find(r => r.remoteSpecs.name === remoteName);
          const jobId = this.getJobIdForOperation(remote, type as SyncOperationType);
          if (jobId === undefined) throw new Error(`No active ${type} job found for ${remoteName}`);
          await this.jobManagementService.stopJob(jobId, remoteName);
        }
      },
      `Failed to stop ${type} for ${remoteName}`
    );
  }

  async deleteJob(jobId: number): Promise<void> {
    try {
      await this.jobManagementService.deleteJob(jobId);
      this.notificationService.openSnackBar(`Job ${jobId} deleted successfully.`, 'Close');
      await this.loadJobs();
    } catch (error) {
      this.handleError(`Failed to delete job ${jobId}`, error);
    }
  }

  // ============================================================================
  // MODAL DIALOGS
  // ============================================================================
  openQuickAddRemoteModal(): void {
    this.dialog.open(QuickAddRemoteComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
    });
  }

  openRemoteConfigModal(
    editTarget?: string,
    existingConfig?: RemoteSettings,
    initialSection?: string
  ): void {
    this.dialog.open(RemoteConfigModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data: {
        name: this.selectedRemote()?.remoteSpecs.name,
        editTarget,
        existingConfig,
        restrictMode: this.restrictMode(),
        initialSection,
      },
    });
  }

  openLogsModal(remoteName: string): void {
    this.dialog.open(LogsModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data: { remoteName },
    });
  }

  cloneRemote(remoteName: string): void {
    const remote = this.remotes().find(r => r.remoteSpecs.name === remoteName);
    if (!remote) return;

    const baseName = remote.remoteSpecs.name.replace(/-\d+$/, '');
    const newName = this.generateUniqueRemoteName(baseName);
    const clonedSpecs = { ...remote.remoteSpecs, name: newName };

    const settings = this.remoteSettings()[remoteName]
      ? JSON.parse(JSON.stringify(this.remoteSettings()[remoteName]))
      : {};

    const clonedSettings = this.updateSourcesForClonedRemote(settings, remoteName, newName);

    this.dialog.open(RemoteConfigModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data: {
        name: newName,
        editTarget: undefined,
        cloneTarget: true,
        existingConfig: {
          remoteSpecs: clonedSpecs,
          ...clonedSettings,
        },
        restrictMode: this.restrictMode(),
      },
    });
  }

  openExportModal(remoteName: string): void {
    this.dialog.open(ExportModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data: {
        remoteName,
        defaultExportType: 'SpecificRemote',
      },
    });
  }

  // ============================================================================
  // SETTINGS MANAGEMENT
  // ============================================================================
  private async getRemoteSettings(): Promise<void> {
    this.remoteSettings.set(await this.appSettingsService.getRemoteSettings());
  }

  loadRemoteSettings(remoteName: string): RemoteSettings {
    return (this.remoteSettings() as Record<string, RemoteSettings>)[remoteName] || {};
  }

  getRemoteSettingValue(remoteName: string, key: string): any {
    return this.remoteSettings()[remoteName]?.[key as keyof RemoteSettings];
  }

  saveRemoteSettings(remoteName: string, settings: Partial<RemoteSettings>): void {
    const currentSettings = this.remoteSettings()[remoteName] || {};
    const mergedSettings = { ...currentSettings, ...settings };

    this.appSettingsService.saveRemoteSettings(remoteName, mergedSettings);
    this.remoteSettings.update(allSettings => ({ ...allSettings, [remoteName]: mergedSettings }));
  }

  async resetRemoteSettings(): Promise<void> {
    const remote = this.selectedRemote();
    if (!remote?.remoteSpecs.name) return;
    try {
      const confirmed = await this.notificationService.confirmModal(
        'Reset Remote Settings',
        `Are you sure you want to reset ALL settings for ${remote.remoteSpecs.name}?`
      );
      if (confirmed) {
        const remoteName = remote.remoteSpecs.name;
        await this.appSettingsService.resetRemoteSettings(remoteName);
        this.remoteSettings.update(allSettings => {
          const newSettings = { ...allSettings };
          delete newSettings[remoteName];
          return newSettings;
        });
        this.notificationService.openSnackBar(
          `Settings for ${remoteName} have been reset.`,
          'Close'
        );
      }
    } catch (error) {
      this.handleError('Failed to reset remote settings', error);
    }
  }

  private async loadRestrictMode(): Promise<void> {
    try {
      this.restrictMode.set(
        (await this.appSettingsService.getSettingValue<boolean>('general.restrict')) ?? true
      );
    } catch (error) {
      this.handleError('Failed to load restrict setting', error);
    }
  }

  // ============================================================================
  // UTILITY & HELPER METHODS
  // ============================================================================
  private async executeRemoteAction(
    remoteName: string,
    action: RemoteAction,
    operation: () => Promise<void>,
    errorMessage: string
  ): Promise<void> {
    if (!remoteName) return;
    try {
      this.actionInProgress.update(progress => ({ ...progress, [remoteName]: action }));
      await operation();
    } catch (error) {
      this.handleError(errorMessage, error);
    } finally {
      this.actionInProgress.update(progress => ({ ...progress, [remoteName]: null }));
    }
  }

  private generateUniqueRemoteName(baseName: string): string {
    const existingNames = this.remotes().map(r => r.remoteSpecs.name);
    let newName = baseName;
    let counter = 1;
    while (existingNames.includes(newName)) {
      newName = `${baseName}-${counter++}`;
    }
    return newName;
  }

  private updateSourcesForClonedRemote(
    settings: RemoteSettings,
    oldName: string,
    newName: string
  ): RemoteSettings {
    const updateSource = (obj: Record<string, string> | undefined, key: string): void => {
      if (obj && typeof obj[key] === 'string' && obj[key].startsWith(`${oldName}:`)) {
        obj[key] = obj[key].replace(`${oldName}:`, `${newName}:`);
      }
    };

    updateSource(settings['mountConfig'], 'source');
    updateSource(settings['syncConfig'], 'source');
    updateSource(settings['copyConfig'], 'source');
    updateSource(settings['bisyncConfig'], 'source');
    updateSource(settings['moveConfig'], 'source');

    return settings;
  }

  getJobsForRemote(remoteName: string): JobInfo[] {
    return this.jobs().filter(j => j.remote_name === remoteName);
  }

  // Need to remove this function later. Because we need the use the real remote setting to determine local or not.
  isLocalPath(path: string): boolean {
    if (!path) return false;
    return (
      (/^[a-zA-Z]:[\\/]/.test(path) ||
        path.startsWith('/') ||
        path.startsWith('~/') ||
        path.startsWith('./')) &&
      !path.includes(':')
    );
  }

  private getMountPoint(remoteName: string): string | undefined {
    const mount = this.mountedRemotes().find(m => m.fs.startsWith(`${remoteName}:`));
    return mount?.mount_point;
  }

  private isRemoteMounted(remoteName: string): boolean {
    return this.mountedRemotes().some(m => m.fs.startsWith(`${remoteName}:`));
  }

  private updateRemoteInList(updatedRemote: Remote): void {
    this.remotes.update(remotes =>
      remotes.map(r => (r.remoteSpecs.name === updatedRemote.remoteSpecs.name ? updatedRemote : r))
    );
  }

  private updateRemotesWithJobs(): void {
    const currentRemotes = this.remotes();
    currentRemotes.forEach(remote => {
      const remoteJobs = this.jobManagementService.getActiveJobsForRemote(remote.remoteSpecs.name);
      this.updateRemoteWithJobs(remote, remoteJobs);
    });
  }

  private updateRemoteWithJobs(remote: Remote, jobs: JobInfo[]): Remote {
    const runningSyncJob = jobs.find(j => j.status === 'Running' && j.job_type === 'sync');
    const runningCopyJob = jobs.find(j => j.status === 'Running' && j.job_type === 'copy');
    const runningBisyncJob = jobs.find(j => j.status === 'Running' && j.job_type === 'bisync');
    const runningMoveJob = jobs.find(j => j.status === 'Running' && j.job_type === 'move');

    const settings = this.loadRemoteSettings(remote.remoteSpecs.name);

    const updatedRemote: Remote = {
      ...remote,
      syncState: {
        isOnSync: !!runningSyncJob,
        syncJobID: runningSyncJob?.jobid,
        isLocal: this.isLocalPath(settings['syncConfig']?.dest || ''),
      },
      copyState: {
        isOnCopy: !!runningCopyJob,
        copyJobID: runningCopyJob?.jobid,
        isLocal: this.isLocalPath(settings['copyConfig']?.dest || ''),
      },
      bisyncState: {
        isOnBisync: !!runningBisyncJob,
        bisyncJobID: runningBisyncJob?.jobid,
        isLocal: this.isLocalPath(settings['bisyncConfig']?.dest || ''),
      },
      moveState: {
        isOnMove: !!runningMoveJob,
        moveJobID: runningMoveJob?.jobid,
        isLocal: this.isLocalPath(settings['moveConfig']?.dest || ''),
      },
    };

    this.updateRemoteInList(updatedRemote);
    return updatedRemote;
  }

  private getPathForOperation(remoteName: string, usePath: PrimaryActionType): string | undefined {
    const settings = this.loadRemoteSettings(remoteName);
    const configMap: Record<PrimaryActionType, () => string | undefined> = {
      mount: () => settings['mountConfig']?.dest,
      sync: () => settings['syncConfig']?.dest,
      copy: () => settings['copyConfig']?.dest,
      bisync: () => settings['bisyncConfig']?.dest,
      move: () => settings['moveConfig']?.dest,
      serve: () => undefined, // Serve does not have a single path
    };
    const getPath = configMap[usePath];
    if (!getPath) {
      throw new Error(`Invalid usePath: ${usePath}`);
    }
    return getPath();
  }

  private getJobIdForOperation(
    remote: Remote | undefined,
    type: SyncOperationType
  ): number | undefined {
    if (!remote) return undefined;

    const stateMap: Record<SyncOperationType, any | undefined> = {
      sync: remote.syncState,
      copy: remote.copyState,
      bisync: remote.bisyncState,
      move: remote.moveState,
    };

    const jobState = stateMap[type];
    const jobId = jobState?.[`${type}JobID` as keyof typeof jobState];
    return typeof jobId === 'number' ? jobId : undefined;
  }

  private handleRemoteDeletion(remoteName: string): void {
    this.remotes.update(remotes => remotes.filter(r => r.remoteSpecs.name !== remoteName));
    if (this.selectedRemote()?.remoteSpecs.name === remoteName) {
      this.uiStateService.resetSelectedRemote();
    }
    this.notificationService.openSnackBar(`Remote ${remoteName} deleted successfully.`, 'Close');
  }

  private updateRemoteMountStates(): void {
    this.remotes.update(remotes =>
      remotes.map(remote => ({
        ...remote,
        mountState: {
          ...remote.mountState,
          mounted: this.isRemoteMounted(remote.remoteSpecs.name),
        },
      }))
    );
  }

  private updateRemoteServeStates(): void {
    const serves = this.serveManagementService.getRunningServes();
    this.remotes.update(remotes =>
      remotes.map(remote => {
        const remoteServes = serves.filter(
          s => s.params.fs.split(':')[0] === remote.remoteSpecs.name
        );
        return {
          ...remote,
          serveState: {
            hasActiveServes: remoteServes.length > 0,
            serveCount: remoteServes.length,
            serves: remoteServes,
          },
        };
      })
    );
  }

  private handleError(message: string, error: unknown): void {
    console.error(`${message}:`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.notificationService.openSnackBar(errorMessage, 'Close');
  }

  private cleanup(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.resizeObserver?.disconnect();
    this.uiStateService.resetSelectedRemote();
  }
}
