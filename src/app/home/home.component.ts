import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  HostListener,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { MatDrawerMode, MatSidenavModule } from '@angular/material/sidenav';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog } from '@angular/material/dialog';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { catchError, EMPTY, Subject, takeUntil } from 'rxjs';

// App Types
import {
  AppTab,
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
import { LoadingOverlayComponent } from '../shared/components/loading-overlay/loading-overlay.component';

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
  SchedulerService,
  ServeManagementService,
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
    MatMenuModule,
    MatIconModule,
    MatButtonModule,
    MatToolbarModule,
    SidebarComponent,
    GeneralDetailComponent,
    GeneralOverviewComponent,
    AppDetailComponent,
    AppOverviewComponent,
    ServeOverviewComponent,
    ServeDetailComponent,
    LoadingOverlayComponent,
  ],
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomeComponent implements OnInit, OnDestroy {
  // ============================================================================
  // PROPERTIES - SERVICES
  // ============================================================================
  private readonly dialog = inject(MatDialog);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly uiStateService = inject(UiStateService);
  private readonly mountManagementService = inject(MountManagementService);
  private readonly serveManagementService = inject(ServeManagementService);
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly jobManagementService = inject(JobManagementService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly notificationService = inject(NotificationService);
  private readonly eventListenersService = inject(EventListenersService);
  private readonly schedulerService = inject(SchedulerService);
  readonly systemInfoService = inject(SystemInfoService);
  readonly iconService = inject(IconService);

  // ============================================================================
  // PROPERTIES - UI STATE
  // ============================================================================
  isSidebarOpen = false;
  sidebarMode: MatDrawerMode = 'side';
  currentTab: AppTab = 'general';
  selectedSyncOperation: SyncOperationType = 'sync';
  usePath: PrimaryActionType = 'mount';
  isLoading = false;
  restrictMode = true;
  actionInProgress: RemoteActionProgress = {};
  isShuttingDown = false;

  // ============================================================================
  // PROPERTIES - DATA STATE
  // ============================================================================
  jobs: JobInfo[] = [];
  remotes: Remote[] = [];
  mountedRemotes: MountedRemote[] = [];
  mountedRemotes$ = this.mountManagementService.mountedRemotes$;
  runningServes$ = this.serveManagementService.runningServes$;
  selectedRemote: Remote | null = null;
  remoteSettings: RemoteSettings = {};

  // ============================================================================
  // PROPERTIES - LIFECYCLE
  // ============================================================================
  private destroy$ = new Subject<void>();
  private resizeObserver?: ResizeObserver;

  // ============================================================================
  // LIFECYCLE HOOKS
  // ============================================================================
  async ngOnInit(): Promise<void> {
    try {
      this.setupResponsiveLayout();
      this.setupSubscriptions();
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
    if (newMode !== this.sidebarMode) {
      this.sidebarMode = newMode;
      this.cdr.markForCheck();
    }
  }

  private setupResizeObserver(): void {
    if (typeof window !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.updateSidebarMode());
      this.resizeObserver.observe(document.body);
    }
  }

  // ============================================================================
  // DATA INITIALIZATION & SUBSCRIPTIONS
  // ============================================================================
  private setupSubscriptions(): void {
    this.uiStateService.currentTab$.pipe(takeUntil(this.destroy$)).subscribe(tab => {
      this.currentTab = tab;
      this.cdr.markForCheck();
    });

    this.uiStateService.selectedRemote$.pipe(takeUntil(this.destroy$)).subscribe(remote => {
      this.selectedRemote = remote;
      this.cdr.markForCheck();
    });

    // Subscribe to mounted remotes changes
    this.mountedRemotes$.pipe(takeUntil(this.destroy$)).subscribe(mountedRemotes => {
      this.mountedRemotes = mountedRemotes;
      this.updateRemoteMountStates();
      this.cdr.markForCheck();
    });

    // Subscribe to running serves changes
    this.runningServes$.pipe(takeUntil(this.destroy$)).subscribe(() => {
      this.updateRemoteServeStates();
      this.cdr.markForCheck();
    });
  }

  private async loadInitialData(): Promise<void> {
    this.isLoading = true;
    this.cdr.markForCheck();

    try {
      await this.refreshData();
    } catch (error) {
      this.handleError('Initial data load failed', error);
    } finally {
      this.isLoading = false;
      this.cdr.markForCheck();
    }
  }

  private async refreshData(): Promise<void> {
    await this.getRemoteSettings(); // Load settings first
    await this.mountManagementService.getMountedRemotes(); // This will trigger the observable
    await this.serveManagementService.refreshServes(); // Load running serves
    await this.loadRemotes(); // Then remotes
    await this.loadJobs();
  }

  private async loadRemotes(): Promise<void> {
    try {
      const remoteConfigs = await this.remoteManagementService.getAllRemoteConfigs();
      this.remotes = this.createRemotesFromConfigs(remoteConfigs);
      await this.loadActiveJobs();
      this.loadDiskUsageInBackground(); // Fire and forget

      // Load scheduled tasks from remote settings
      try {
        await this.schedulerService.reloadScheduledTasksFromConfigs(this.remoteSettings);
      } catch (error) {
        console.error('Failed to load scheduled tasks from settings:', error);
      }

      this.cdr.markForCheck();
    } catch (error) {
      this.handleError('Failed to load remotes', error);
    }
  }

  private async loadJobs(): Promise<void> {
    try {
      this.jobs = await this.jobManagementService.getJobs();
      this.cdr.markForCheck();
    } catch (error) {
      this.handleError('Failed to load jobs', error);
      throw error;
    }
  }

  private createRemotesFromConfigs(remoteConfigs: Record<string, any>): Remote[] {
    const mountedSet = new Set(this.mountedRemotes.map(m => m.fs.split(':')[0]));
    return Object.keys(remoteConfigs).map(name => {
      const existingRemote = this.remotes.find(r => r.remoteSpecs.name === name);
      const settings = this.loadRemoteSettings(name);
      return {
        remoteSpecs: { name, ...remoteConfigs[name] },
        primaryActions: settings?.primaryActions || [],
        diskUsage: existingRemote?.diskUsage || {
          total_space: 'Loading...',
          used_space: 'Loading...',
          free_space: 'Loading...',
          loading: true,
        },
        mountState: { mounted: mountedSet.has(name) },
        syncState: this.getInitialJobState(settings, 'sync', existingRemote?.syncState),
        copyState: this.getInitialJobState(settings, 'copy', existingRemote?.copyState),
        bisyncState: this.getInitialJobState(settings, 'bisync', existingRemote?.bisyncState),
        moveState: this.getInitialJobState(settings, 'move', existingRemote?.moveState),
      };
    });
  }

  private getInitialJobState(settings: any, jobType: SyncOperationType, existingState?: any): any {
    const config = settings?.[`${jobType}Config`];
    const jobIDKey = `${jobType}JobID`;
    const isOnKey = `isOn${jobType.charAt(0).toUpperCase() + jobType.slice(1)}`;

    if (existingState) {
      return {
        ...existingState,
        isLocal: this.isLocalPath(config?.dest || ''),
      };
    }

    return {
      [isOnKey]: false,
      [jobIDKey]: 0,
      isLocal: this.isLocalPath(config?.dest || ''),
    } as any;
  }

  private async updateRemoteDiskUsage(remote: Remote): Promise<void> {
    const updateDiskUsage = (updates: Partial<DiskUsage>): void => {
      const currentRemote = this.remotes.find(r => r.remoteSpecs.name === remote.remoteSpecs.name);
      if (!currentRemote) return;
      const updatedRemote = {
        ...currentRemote,
        diskUsage: { ...currentRemote.diskUsage, ...updates },
      };
      this.updateRemoteInList(updatedRemote);
    };

    updateDiskUsage({ loading: true });

    try {
      const fsInfo = (await this.remoteManagementService.getFsInfo(
        remote.remoteSpecs.name
      )) as Record<string, any>;
      if (fsInfo?.['Features']?.About === false) {
        updateDiskUsage({
          total_space: 'Not supported',
          used_space: 'Not supported',
          free_space: 'Not supported',
          notSupported: true,
          loading: false,
          error: false,
        });
        return;
      }

      const usage = await this.remoteManagementService.getDiskUsage(remote.remoteSpecs.name);
      updateDiskUsage({
        total_space: usage.total || 'N/A',
        used_space: usage.used || 'N/A',
        free_space: usage.free || 'N/A',
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
    this.remotes
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
      const jobs = await this.jobManagementService.getActiveJobs();
      this.updateRemotesWithJobs(jobs);
      this.cdr.markForCheck();
    } catch (error) {
      this.handleError('Failed to load active jobs', error);
    }
  }

  private async loadJobsForRemote(remoteName: string): Promise<void> {
    try {
      const jobs = await this.jobManagementService.getActiveJobs();
      const remoteJobs = jobs.filter(j => j.remote_name === remoteName);

      if (remoteJobs.length > 0 && this.selectedRemote) {
        this.updateRemoteWithJobs(this.selectedRemote, remoteJobs);
      }
    } catch (error) {
      this.handleError(`Failed to load jobs for ${remoteName}`, error);
    }
  }

  // ============================================================================
  // TAURI EVENT LISTENERS
  // ============================================================================
  private setupTauriListeners(): void {
    this.listenToAppEvents();
    // this.listenToNotifyUi();
    this.listenToMountCache();
    this.listenToRemoteCache();
    this.listenToRcloneEngine();
    this.listenToJobCache();
  }

  private listenToAppEvents(): void {
    this.eventListenersService
      .listenToAppEvents()
      .pipe(
        takeUntil(this.destroy$),
        catchError(error => (console.error('Event listener error (AppEvents):', error), EMPTY))
      )
      .subscribe({
        next: event => {
          if (typeof event === 'object' && event?.status === 'shutting_down') {
            this.isShuttingDown = true;
            this.cdr.detectChanges();
          }
        },
      });
  }

  // private listenToNotifyUi(): void {
  //   this.eventListenersService
  //     .listenToNotifyUi()
  //     .pipe(
  //       takeUntil(this.destroy$),
  //       catchError(error => (console.error('Event listener error (NotifyUi):', error), EMPTY))
  //     )
  //     .subscribe({
  //       next: message => {
  //         if (message) {
  //           this.notificationService.openSnackBar(message, 'Close');
  //         }
  //       },
  //     });
  // }

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
            // Just trigger a refresh - the observable subscription will handle the update
            await this.mountManagementService.getMountedRemotes();
          } catch (error) {
            this.handleError('Error handling mount_cache_updated', error);
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
            this.cdr.markForCheck();
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
            this.cdr.markForCheck();
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
            this.cdr.markForCheck();
          } catch (error) {
            this.handleError('Error handling job_cache_changed', error);
          }
        },
      });
  }

  // ============================================================================
  // REMOTE SELECTION & STATE
  // ============================================================================
  async selectRemote(remote: Remote): Promise<void> {
    this.uiStateService.setSelectedRemote(remote);
    this.cdr.markForCheck();
    await this.loadJobsForRemote(remote.remoteSpecs.name);

    const settings = this.loadRemoteSettings(remote.remoteSpecs.name) || {};
    this.selectedSyncOperation = (settings.selectedSyncOperation as SyncOperationType) || 'sync';
    this.cdr.markForCheck();
  }

  onSyncOperationChange(operation: SyncOperationType): void {
    this.selectedSyncOperation = operation;
    if (this.selectedRemote?.remoteSpecs.name) {
      this.saveRemoteSettings(this.selectedRemote.remoteSpecs.name, {
        selectedSyncOperation: operation,
      });
    }
    this.cdr.markForCheck();
  }

  async togglePrimaryAction(type: PrimaryActionType): Promise<void> {
    if (!this.selectedRemote) return;

    const remoteName = this.selectedRemote.remoteSpecs.name;
    const currentActions = this.selectedRemote.primaryActions || [];
    const newActions = currentActions.includes(type)
      ? currentActions.filter(action => action !== type)
      : [...currentActions, type];

    try {
      await this.appSettingsService.saveRemoteSettings(remoteName, { primaryActions: newActions });
      this.selectedRemote = { ...this.selectedRemote, primaryActions: newActions };
      this.cdr.markForCheck();
    } catch (error) {
      this.handleError('Failed to update quick actions', error);
    }
  }

  // ============================================================================
  // REMOTE OPERATIONS (ACTIONS)
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

  /**
   * Handle the start serve event from serve components
   * This will open the remote config modal with start serve mode
   */
  onStartServe(remoteName: string): void {
    const remoteSettings = this.loadRemoteSettings(remoteName);
    const serveConfig = remoteSettings?.['serveConfig'];

    console.log('Starting serve with config:', serveConfig);

    this.serveManagementService.startServe(
      remoteName,
      serveConfig?.['options'],
      serveConfig?.['filterConfig'],
      serveConfig?.['backendConfig'],
      serveConfig?.['vfsConfig']
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
    } catch (error) {
      this.handleError(`Failed to delete remote ${remoteName}`, error);
    }
  }

  // ============================================================================
  // JOB OPERATIONS (START/STOP)
  // ============================================================================
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
              settings.filterConfig,
              settings.backendConfig
            );
            break;
          case 'copy':
            await this.jobManagementService.startCopy(
              remoteName,
              config.source,
              config.dest,
              config.createEmptySrcDirs,
              config.options,
              settings.filterConfig,
              settings.backendConfig
            );
            break;
          case 'bisync':
            await this.jobManagementService.startBisync(
              remoteName,
              config.source,
              config.dest,
              config.options,
              settings.filterConfig,
              settings.backendConfig,
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
              settings.filterConfig,
              settings.backendConfig
            );
            break;
          default:
            throw new Error(`Unsupported operation type: ${operationType}`);
        }
      },
      `Failed to start ${operationType} for ${remoteName}`
    );
  }

  async stopJob(type: PrimaryActionType, remoteName: string): Promise<void> {
    await this.executeRemoteAction(
      remoteName,
      'stop',
      async () => {
        if (type === 'mount') {
          await this.unmountRemote(remoteName);
        } else {
          const remote = this.remotes.find(r => r.remoteSpecs.name === remoteName);
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
      this.cdr.markForCheck();
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
        name: this.selectedRemote?.remoteSpecs.name,
        editTarget,
        existingConfig,
        restrictMode: this.restrictMode,
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
    const remote = this.remotes.find(r => r.remoteSpecs.name === remoteName);
    if (!remote) return;

    const baseName = remote.remoteSpecs.name.replace(/-\d+$/, '');
    const newName = this.generateUniqueRemoteName(baseName);

    const clonedSpecs = { ...remote.remoteSpecs, name: newName };

    const settings = this.remoteSettings[remoteName]
      ? JSON.parse(JSON.stringify(this.remoteSettings[remoteName]))
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
        restrictMode: this.restrictMode,
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
    this.remoteSettings = await this.appSettingsService.getRemoteSettings();
    this.cdr.markForCheck();
  }

  loadRemoteSettings(remoteName: string): any {
    return (this.remoteSettings as Record<string, any>)[remoteName] || {};
  }

  getRemoteSettingValue(remoteName: string, key: string): any {
    return this.remoteSettings[remoteName]?.[key];
  }

  saveRemoteSettings(remoteName: string, settings: any): void {
    const currentSettings = this.remoteSettings[remoteName] || {};
    const mergedSettings = { ...currentSettings, ...settings };

    this.appSettingsService.saveRemoteSettings(remoteName, mergedSettings);
    this.remoteSettings[remoteName] = mergedSettings;
    this.cdr.markForCheck();
  }

  async resetRemoteSettings(): Promise<void> {
    if (!this.selectedRemote?.remoteSpecs.name) return;

    try {
      const confirmed = await this.notificationService.confirmModal(
        'Reset Remote Settings',
        `Are you sure you want to reset ALL settings (including operations) for ${this.selectedRemote?.remoteSpecs.name}? This action cannot be undone.`
      );

      if (confirmed) {
        const remoteName = this.selectedRemote.remoteSpecs.name;
        await this.appSettingsService.resetRemoteSettings(remoteName);
        delete this.remoteSettings[remoteName];
        this.cdr.markForCheck();
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
      this.restrictMode =
        (await this.appSettingsService.getSettingValue<boolean>('general.restrict')) ?? true;
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
      this.actionInProgress = { ...this.actionInProgress, [remoteName]: action };
      this.cdr.markForCheck();

      await operation();
    } catch (error) {
      this.handleError(errorMessage, error);
    } finally {
      this.actionInProgress = { ...this.actionInProgress, [remoteName]: null };
      this.cdr.markForCheck();
    }
  }

  private generateUniqueRemoteName(baseName: string): string {
    const existingNames = this.remotes.map(r => r.remoteSpecs.name);
    let newName = baseName;
    let counter = 1;
    while (existingNames.includes(newName)) {
      newName = `${baseName}-${counter++}`;
    }
    return newName;
  }

  private updateSourcesForClonedRemote(
    settings: Record<string, any>,
    oldName: string,
    newName: string
  ): Record<string, any> {
    const updateSource = (obj: Record<string, any> | undefined, key: string): void => {
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
    return this.jobs.filter(j => j.remote_name === remoteName);
  }

  isLocalPath(path: string): boolean {
    if (!path) return false;
    return (
      (/^[a-zA-Z]:[\\/]/.test(path) ||
        path.startsWith('/') ||
        path.startsWith('~/') ||
        path.startsWith('./')) &&
      !path.includes(':/')
    );
  }

  private getMountPoint(remoteName: string): string | undefined {
    const mount = this.mountedRemotes.find(m => m.fs.startsWith(`${remoteName}:`));
    return mount?.mount_point;
  }

  private isRemoteMounted(remoteName: string): boolean {
    return this.mountedRemotes.some(m => m.fs.startsWith(`${remoteName}:`));
  }

  private updateRemoteInList(updatedRemote: Remote): void {
    this.remotes = this.remotes.map(r =>
      r.remoteSpecs.name === updatedRemote.remoteSpecs.name ? updatedRemote : r
    );

    if (this.selectedRemote?.remoteSpecs.name === updatedRemote.remoteSpecs.name) {
      this.selectedRemote = updatedRemote;
    }
    this.cdr.markForCheck();
  }

  private updateRemotesWithJobs(jobs: JobInfo[]): void {
    this.remotes.forEach(remote => {
      const remoteJobs = jobs.filter(j => j.remote_name === remote.remoteSpecs.name);
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
        isLocal: this.isLocalPath(settings?.syncConfig?.dest || ''),
      },
      copyState: {
        isOnCopy: !!runningCopyJob,
        copyJobID: runningCopyJob?.jobid,
        isLocal: this.isLocalPath(settings?.copyConfig?.dest || ''),
      },
      bisyncState: {
        isOnBisync: !!runningBisyncJob,
        bisyncJobID: runningBisyncJob?.jobid,
        isLocal: this.isLocalPath(settings?.bisyncConfig?.dest || ''),
      },
      moveState: {
        isOnMove: !!runningMoveJob,
        moveJobID: runningMoveJob?.jobid,
        isLocal: this.isLocalPath(settings?.moveConfig?.dest || ''),
      },
    };

    this.updateRemoteInList(updatedRemote);
    return updatedRemote;
  }

  private getPathForOperation(remoteName: string, usePath: PrimaryActionType): string | undefined {
    const settings = this.loadRemoteSettings(remoteName);
    const configMap: Record<PrimaryActionType, () => string | undefined> = {
      mount: () => settings?.mountConfig?.dest,
      sync: () => settings?.syncConfig?.dest,
      copy: () => settings?.copyConfig?.dest,
      bisync: () => settings?.bisyncConfig?.dest,
      move: () => settings?.moveConfig?.dest,
      serve: () => settings?.serveConfig?.dest,
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

    const stateMap = {
      sync: remote.syncState,
      copy: remote.copyState,
      bisync: remote.bisyncState,
      move: remote.moveState,
    };

    return stateMap[type]?.[`${type}JobID` as keyof (typeof stateMap)[typeof type]];
  }

  private handleRemoteDeletion(remoteName: string): void {
    this.remotes = this.remotes.filter(r => r.remoteSpecs.name !== remoteName);

    if (this.selectedRemote?.remoteSpecs.name === remoteName) {
      this.selectedRemote = null;
      this.uiStateService.resetSelectedRemote(); // Clear global state
    }

    this.notificationService.openSnackBar(`Remote ${remoteName} deleted successfully.`, 'Close');
    this.cdr.markForCheck();
  }

  private updateRemoteMountStates(): void {
    this.remotes.forEach(remote => {
      const updatedRemote = {
        ...remote,
        mountState: {
          ...remote.mountState,
          mounted: this.isRemoteMounted(remote.remoteSpecs.name),
        },
      };
      this.updateRemoteInList(updatedRemote);
    });
  }

  private updateRemoteServeStates(): void {
    const serves = this.serveManagementService.getRunningServes();
    this.remotes.forEach(remote => {
      const remoteServes = serves.filter(s => {
        const remoteName = s.params.fs.split(':')[0];
        return remoteName === remote.remoteSpecs.name;
      });
      const updatedRemote = {
        ...remote,
        serveState: {
          hasActiveServes: remoteServes.length > 0,
          serveCount: remoteServes.length,
          serves: remoteServes.map(s => ({
            id: s.id,
            addr: s.addr,
            serve_type: s.params.type,
          })),
        },
      };
      this.updateRemoteInList(updatedRemote);
    });
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
