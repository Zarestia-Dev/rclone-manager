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
import { Subject, takeUntil } from 'rxjs';

// Components
import {
  AppTab,
  BandwidthLimitResponse,
  DiskUsage,
  JobInfo,
  MountedRemote,
  Remote,
  RemoteAction,
  RemoteActionProgress,
  RemoteSettings,
  STANDARD_MODAL_SIZE,
  UsePath,
} from '../shared/components/types';
import { MatToolbarModule } from '@angular/material/toolbar';
import { SidebarComponent } from '../layout/sidebar/sidebar.component';
import { GeneralDetailComponent } from '../features/components/dashboard/general-detail/general-detail.component';
import { GeneralOverviewComponent } from '../features/components/dashboard/general-overview/general-overview.component';
import { AppDetailComponent } from '../features/components/dashboard/app-detail/app-detail.component';
import { AppOverviewComponent } from '../features/components/dashboard/app-overview/app-overview.component';
import { LogsModalComponent } from '../features/modals/monitoring/logs-modal/logs-modal.component';
import { ExportModalComponent } from '../features/modals/settings/export-modal/export-modal.component';
import { RemoteConfigModalComponent } from '../features/modals/remote-management/remote-config-modal/remote-config-modal.component';
import { QuickAddRemoteComponent } from '../features/modals/remote-management/quick-add-remote/quick-add-remote.component';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { LoadingOverlayComponent } from '../shared/components/loading-overlay/loading-overlay.component';

// Services
import { IconService } from '../shared/services/icon.service';

import { EventListenersService } from '@app/services';
import { UiStateService } from '@app/services';
import { MountManagementService } from '@app/services';
import { RemoteManagementService } from '@app/services';
import { JobManagementService } from '@app/services';
import { SystemInfoService } from '@app/services';
import { AppSettingsService } from '@app/services';
import { NotificationService } from '../shared/services/notification.service';
import { MainOperationType, SyncOperationType } from '../shared/detail-shared';

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
    LoadingOverlayComponent,
  ],
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.scss'],
  changeDetection: ChangeDetectionStrategy.Default,
})
export class HomeComponent implements OnInit, OnDestroy {
  // UI State
  isSidebarOpen = false;
  sidebarMode: MatDrawerMode = 'side';
  currentTab: AppTab = 'general';
  UsePath: UsePath = 'mount';
  isLoading = false;
  restrictMode = true;
  jobs: JobInfo[] = [];

  // Data State
  remotes: Remote[] = [];
  mountedRemotes: MountedRemote[] = [];
  selectedRemote: Remote | null = null;
  remoteSettings: RemoteSettings = {};
  actionInProgress: RemoteActionProgress = {};
  bandwidthLimit: BandwidthLimitResponse | null = null;

  // Shutdown State
  isShuttingDown = false;

  // Cleanup
  private destroy$ = new Subject<void>();
  private resizeObserver?: ResizeObserver;

  dialog = inject(MatDialog);
  cdr = inject(ChangeDetectorRef);
  uiStateService = inject(UiStateService);
  mountManagementService = inject(MountManagementService);
  remoteManagementService = inject(RemoteManagementService);
  jobManagementService = inject(JobManagementService);
  systemInfoService = inject(SystemInfoService);
  appSettingsService = inject(AppSettingsService);
  iconService = inject(IconService);
  notificationService = inject(NotificationService);
  private eventListenersService = inject(EventListenersService);
  // private extendedData: { resync: boolean } | null = null;

  constructor() {
    this.restrictValue();
  }

  // Lifecycle Hooks
  async ngOnInit(): Promise<void> {
    console.log('HomeComponent: ngOnInit started');
    try {
      this.setupResponsiveLayout();
      console.log('HomeComponent: setupResponsiveLayout completed');

      this.setupSubscriptions();
      console.log('HomeComponent: setupSubscriptions completed');

      await this.loadInitialData();
      console.log('HomeComponent: loadInitialData called');

      this.setupTauriListeners();
      console.log('HomeComponent: setupTauriListeners completed');

      console.log('HomeComponent: ngOnInit completed');
    } catch (error) {
      console.error('HomeComponent: ngOnInit failed', error);
    }
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  // handleExtendedData($event: { resync: boolean }): void {
  //   this.extendedData = $event;
  // }

  // UI Event Handlers
  @HostListener('window:resize')
  onResize(): void {
    this.updateSidebarMode();
  }

  // Remote Selection
  async selectRemote(remote: Remote): Promise<void> {
    this.uiStateService.setSelectedRemote(remote);
    this.cdr.markForCheck();
    await this.loadJobsForRemote(remote.remoteSpecs.name);
  }

  // Remote Operations
  async mountRemote(remoteName: string): Promise<void> {
    await this.executeRemoteAction(
      remoteName,
      'mount',
      async () => {
        const settings = this.loadRemoteSettings(remoteName);
        if (!settings || !settings.mountConfig) {
          throw new Error(`Mount configuration missing for remote '${remoteName}'`);
        }
        await this.mountManagementService.mountRemote(
          remoteName,
          settings.mountConfig.source,
          settings.mountConfig.dest,
          settings.mountConfig.type,
          settings.mountConfig.options,
          settings.vfsConfig || {}
        );
        await this.refreshMounts();
      },
      `Failed to mount ${remoteName}`
    );
  }

  async unmountRemote(remoteName: string): Promise<void> {
    await this.executeRemoteAction(
      remoteName,
      'unmount',
      async () => {
        const mountPoint = this.getMountPoint(remoteName);
        if (!mountPoint) {
          throw new Error(`No mount point found for ${remoteName}`);
        }
        await this.mountManagementService.unmountRemote(mountPoint, remoteName);
        await this.refreshMounts();
      },
      `Failed to unmount ${remoteName}`
    );
  }

  async openRemoteInFiles(remoteName: string, UsePath: UsePath): Promise<void> {
    await this.executeRemoteAction(
      remoteName,
      'open',
      async () => {
        const path = this.getPathForOperation(remoteName, UsePath);
        await this.mountManagementService.openInFiles(path || '');
      },
      `Failed to open ${remoteName}`
    );
  }

  async openRemoteInFilesWithPath(remoteName: string, path?: string): Promise<void> {
    await this.executeRemoteAction(
      remoteName,
      'open',
      async () => {
        await this.mountManagementService.openInFiles(path || '');
      },
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
    } catch (error) {
      this.handleError(`Failed to delete remote ${remoteName}`, error);
    }
  }

  // Operation Control
  async startOperation(operationType: SyncOperationType, remoteName: string): Promise<void> {
    await this.executeRemoteAction(
      remoteName,
      operationType as RemoteAction,
      async () => {
        const settings = this.loadRemoteSettings(remoteName);
        const configKey = `${operationType}Config`;
        console.log(
          `Starting ${operationType} for ${remoteName} with config:`,
          settings[configKey]
        );

        const config = settings[configKey];
        const source = config.source;
        const dest = config.dest;
        const createEmptySrcDirs = config.createEmptySrcDirs;
        const options = config.options;
        const filterConfig = settings.filterConfig;

        switch (operationType) {
          case 'sync':
            await this.jobManagementService.startSync(
              remoteName,
              source,
              dest,
              createEmptySrcDirs,
              options,
              filterConfig
            );
            break;
          case 'copy':
            await this.jobManagementService.startCopy(
              remoteName,
              source,
              dest,
              createEmptySrcDirs,
              options,
              filterConfig
            );
            break;
          case 'bisync':
            await this.jobManagementService.startBisync(
              remoteName,
              source,
              dest,
              options,
              filterConfig
              // this.extendedData?.resync
            );
            break;
          case 'move': // You'll need to implement this in your JobManagementService
          {
            const deleteEmptySrcDirs = config.deleteEmptySrcDirs;
            await this.jobManagementService.startMove(
              remoteName,
              source,
              dest,
              createEmptySrcDirs,
              deleteEmptySrcDirs,
              options,
              filterConfig
            );
            break;
          }
          default:
            throw new Error(`Unsupported sync operation: ${operationType}`);
        }
      },
      `Failed to start ${operationType} for ${remoteName}`
    );
  }
  async stopOperation(
    type: 'sync' | 'copy' | 'mount' | 'bisync' | 'move' | string,
    remoteName: string
  ): Promise<void> {
    await this.executeRemoteAction(
      remoteName,
      'stop',
      async () => {
        const remote = this.remotes.find(r => r.remoteSpecs.name === remoteName);
        const jobId = this.getJobIdForOperation(remote, type);

        if (!jobId) {
          throw new Error(`No ${type} job ID found for ${remoteName}`);
        }
        console.log(`Stopping ${type} for ${remoteName} with job ID:`, jobId);
        await this.jobManagementService.stopJob(jobId, remoteName);
      },
      `Failed to stop ${type} for ${remoteName}`
    );
  }

  async deleteJob(jobId: number): Promise<void> {
    try {
      await this.jobManagementService.deleteJob(jobId);
      this.notificationService.openSnackBar(`Job ${jobId} deleted successfully.`, 'Close');
      // Refresh jobs after deletion
      await this.loadJobs();
      this.cdr.markForCheck();
    } catch (error) {
      this.handleError(`Failed to delete job ${jobId}`, error);
    }
  }

  // Modal Dialogs
  openQuickAddRemoteModal(): void {
    this.dialog.open(QuickAddRemoteComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
    });
  }

  openRemoteConfigModal(editTarget?: string, existingConfig?: RemoteSettings): void {
    this.dialog.open(RemoteConfigModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data: {
        name: this.selectedRemote?.remoteSpecs.name,
        editTarget,
        existingConfig,
        restrictMode: this.restrictMode,
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

  private generateUniqueRemoteName(baseName: string): string {
    const existingNames = this.remotes.map(r => r.remoteSpecs.name);
    let newName = baseName;
    let counter = 1;
    while (existingNames.includes(newName)) {
      newName = `${baseName}-${counter++}`;
    }
    return newName;
  }

  cloneRemote(remoteName: string) {
    const remote = this.remotes.find(r => r.remoteSpecs.name === remoteName);
    if (!remote) return;

    const baseName = remote.remoteSpecs.name.replace(/-\d+$/, '');
    const newName = this.generateUniqueRemoteName(baseName);

    const clonedSpecs = {
      ...remote.remoteSpecs,
      remoteSpecs: { ...remote.remoteSpecs, name: newName },
      name: newName,
    };

    // Deep clone settings
    const settings = this.remoteSettings[remoteName]
      ? JSON.parse(JSON.stringify(this.remoteSettings[remoteName]))
      : {};

    // Update all source fields to use the new name
    const clonedSettings = this.updateSourcesForClonedRemote(
      { ...settings, name: newName },
      remoteName,
      newName
    );

    this.dialog.open(RemoteConfigModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data: {
        name: newName,
        editTarget: undefined,
        cloneTarget: true,
        existingConfig: {
          ...clonedSpecs,
          ...clonedSettings,
        },
        restrictMode: this.restrictMode,
      },
    });
  }

  private updateSourcesForClonedRemote(settings: any, oldName: string, newName: string): any {
    // Helper to update source fields in all configs
    const updateSource = (obj: any, key: string) => {
      if (obj && typeof obj[key] === 'string' && obj[key].startsWith(`${oldName}:`)) {
        obj[key] = obj[key].replace(`${oldName}:`, `${newName}:`);
      }
    };

    if (settings.mountConfig) updateSource(settings.mountConfig, 'source');
    if (settings.syncConfig) updateSource(settings.syncConfig, 'source');
    if (settings.copyConfig) updateSource(settings.copyConfig, 'source');

    return settings;
  }

  getJobsForRemote(remoteName: string): JobInfo[] {
    return this.jobs.filter(j => j.remote_name === remoteName);
  }

  openExportModal(remoteName: string): void {
    this.dialog.open(ExportModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data: {
        remoteName,
        defaultExportType: 'specific-remote',
      },
    });
  }

  // Remote Settings
  loadRemoteSettings(remoteName: string): any {
    return this.remoteSettings[remoteName] || {};
  }

  getRemoteSettingValue(remoteName: string, key: string): any {
    return this.remoteSettings[remoteName]?.[key];
  }

  saveRemoteSettings(remoteName: string, settings: any): void {
    this.appSettingsService.saveRemoteSettings(remoteName, settings);
    this.remoteSettings[remoteName] = {
      ...this.remoteSettings[remoteName],
      ...settings,
    };
    this.cdr.markForCheck();
  }

  async resetRemoteSettings(): Promise<void> {
    if (!this.selectedRemote?.remoteSpecs.name) return;

    try {
      const result = await this.notificationService.confirmModal(
        'Reset Remote Settings',
        `Are you sure you want to reset settings for ${this.selectedRemote?.remoteSpecs.name}? This action cannot be undone.`
      );

      if (result) {
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

  // Utility Methods
  isLocalPath(path: string): boolean {
    if (!path) return false;
    return (
      /^[a-zA-Z]:[\\/]/.test(path) ||
      path.startsWith('/') ||
      path.startsWith('~/') ||
      path.startsWith('./')
    );
  }

  // Action handlers for cleaner template logic
  handlePrimaryAction(
    mainType: MainOperationType,
    remoteName: string,
    subType?: SyncOperationType
  ): void {
    switch (mainType) {
      case 'sync':
        if (subType) {
          this.startOperation(subType, remoteName);
        }
        break;
      case 'mount':
        this.mountRemote(remoteName);
        break;
    }
  }

  handleSecondaryAction(
    mainType: MainOperationType,
    remoteName: string,
    subType?: SyncOperationType
  ): void {
    switch (mainType) {
      case 'sync':
        if (subType) {
          this.stopOperation(subType, remoteName);
        }
        break;
      case 'mount':
        this.unmountRemote(remoteName);
        break;
    }
  }

  // Private Helpers
  private setupResponsiveLayout(): void {
    this.updateSidebarMode();
    this.setupResizeObserver();
  }

  private updateSidebarMode(): void {
    this.sidebarMode = window.innerWidth < 900 ? 'over' : 'side';
    this.cdr.markForCheck();
  }

  private setupResizeObserver(): void {
    if (typeof window !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.updateSidebarMode());
      this.resizeObserver.observe(document.body);
    }
  }

  private setupSubscriptions(): void {
    this.uiStateService.currentTab$.pipe(takeUntil(this.destroy$)).subscribe(tab => {
      this.currentTab = tab;
      this.cdr.markForCheck();
    });

    this.uiStateService.selectedRemote$.pipe(takeUntil(this.destroy$)).subscribe(remote => {
      this.selectedRemote = remote;
      this.cdr.markForCheck();
    });
  }

  private async loadInitialData(): Promise<void> {
    console.log('HomeComponent: Starting initial data load');
    this.isLoading = true;
    this.cdr.markForCheck();

    try {
      await this.refreshData();
      console.log('HomeComponent: Initial data load completed successfully');
    } catch (error) {
      console.error('HomeComponent: Initial data load failed', error);
      this.handleError('Failed to load initial data', error);
    } finally {
      this.isLoading = false;
      this.cdr.markForCheck();
    }
  }

  private async refreshData(): Promise<void> {
    console.log('HomeComponent: Starting data refresh');
    // Add timeout to prevent infinite hanging
    const operations = [
      this.refreshMounts().catch(e => console.error('Mount refresh failed:', e)),
      this.loadRemotes().catch(e => console.error('Remote load failed:', e)),
      this.getRemoteSettings().catch(e => console.error('Settings load failed:', e)),
      this.loadJobs().catch(e => console.error('Jobs load failed:', e)),
    ];

    // Add a timeout to prevent hanging
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Data refresh timeout')), 10000)
    );

    try {
      await Promise.race([Promise.allSettled(operations), timeout]);
      console.log('HomeComponent: Data refresh completed');
    } catch (error) {
      console.error('HomeComponent: Data refresh timed out or failed:', error);
      throw error;
    }
  }

  private async loadRemotes(): Promise<void> {
    try {
      const remoteConfigs = await this.remoteManagementService.getAllRemoteConfigs();
      this.remotes = this.createRemotesFromConfigs(remoteConfigs);
      this.loadDiskUsageInBackground();
      await this.loadActiveJobs();
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
    }
  }

  private createRemotesFromConfigs(remoteConfigs: any): Remote[] {
    return Object.keys(remoteConfigs).map(name => ({
      remoteSpecs: { name, ...remoteConfigs[name] },
      mountState: {
        mounted: this.isRemoteMounted(name),
        diskUsage: {
          total_space: 'Loading...',
          used_space: 'Loading...',
          free_space: 'Loading...',
          loading: true,
        },
      },
      syncState: {
        isOnSync: false,
        syncJobID: 0,
        isLocal: this.isLocalPath(this.remoteSettings[name]?.['syncConfig']?.dest || ''),
      },
      copyState: {
        isOnCopy: false,
        copyJobID: 0,
        isLocal: this.isLocalPath(this.remoteSettings[name]?.['copyConfig']?.dest || ''),
      },
      bisyncState: {
        isOnBisync: false,
        bisyncJobID: 0,
        isLocal: this.isLocalPath(this.remoteSettings[name]?.['bisyncConfig']?.dest || ''),
      },
      moveState: {
        isOnMove: false,
        moveJobID: 0,
        isLocal: this.isLocalPath(this.remoteSettings[name]?.['moveConfig']?.dest || ''),
      },
    }));
  }

  private async loadDiskUsageInBackground(): Promise<void> {
    const promises = this.remotes
      .filter(
        remote =>
          !remote.mountState?.diskUsage ||
          remote.mountState.diskUsage.loading ||
          remote.mountState.diskUsage.error
      )
      .map(remote => this.updateRemoteDiskUsage(remote));

    await Promise.all(promises);
  }

  private async updateRemoteDiskUsage(remote: Remote): Promise<void> {
    if (!remote.mountState) return;

    const updateDiskUsageState = (updates: Partial<DiskUsage>) => {
      if (remote.mountState) {
        remote.mountState.diskUsage = {
          ...remote.mountState.diskUsage,
          ...updates,
        };
        this.updateSelectedRemoteIfMatches(remote);
        this.cdr.markForCheck();
      }
    };

    try {
      updateDiskUsageState({ loading: true });

      const fsInfo = await this.remoteManagementService.getFsInfo(remote.remoteSpecs.name);

      if (fsInfo?.Features?.About === false) {
        updateDiskUsageState({
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
      updateDiskUsageState({
        total_space: usage.total || 'N/A',
        used_space: usage.used || 'N/A',
        free_space: usage.free || 'N/A',
        loading: false,
        error: false,
      });
    } catch (error) {
      updateDiskUsageState({ loading: false, error: true });
      console.error(`Failed to update disk usage for ${remote.remoteSpecs.name}`, error);
    }
  }

  private updateSelectedRemoteIfMatches(remote: Remote): void {
    if (this.selectedRemote?.remoteSpecs.name === remote.remoteSpecs.name) {
      this.selectedRemote = {
        ...this.selectedRemote,
        mountState: {
          ...this.selectedRemote.mountState,
          diskUsage: { ...remote.mountState?.diskUsage },
        },
      };
      this.cdr.markForCheck();
    }
  }

  private async getRemoteSettings(): Promise<void> {
    this.remoteSettings = await this.appSettingsService.getRemoteSettings();
    this.cdr.markForCheck();
  }

  private async refreshMounts(): Promise<void> {
    this.mountedRemotes = await this.mountManagementService.getMountedRemotes();
    this.cdr.markForCheck();
  }

  private getMountPoint(remoteName: string): string | undefined {
    const mount = this.mountedRemotes.find(m => m.fs.startsWith(`${remoteName}:`));
    return mount?.mount_point;
  }

  private isRemoteMounted(remoteName: string): boolean {
    return this.mountedRemotes.some(mount => mount.fs.startsWith(`${remoteName}:`));
  }

  private async loadActiveJobs(): Promise<void> {
    try {
      const jobs = await this.jobManagementService.getActiveJobs();
      this.updateRemotesWithJobs(jobs);
      this.updateSelectedRemoteIfNeeded();
      this.cdr.markForCheck();
    } catch (error) {
      this.handleError('Failed to load jobs', error);
    }
  }

  private updateRemotesWithJobs(jobs: any[]): void {
    this.remotes = this.remotes.map(remote => {
      const remoteJobs = jobs.filter(j => j.remote_name === remote.remoteSpecs.name);
      return this.updateRemoteWithJobs(remote, remoteJobs);
    });
    this.cdr.markForCheck();
  }

  private updateRemoteWithJobs(remote: Remote, jobs: any[]): Remote {
    const runningSyncJob = jobs.find(j => j.status === 'Running' && j.job_type === 'sync');
    const runningCopyJob = jobs.find(j => j.status === 'Running' && j.job_type === 'copy');
    const runningBisyncJob = jobs.find(j => j.status === 'Running' && j.job_type === 'bisync');
    const runningMoveJob = jobs.find(j => j.status === 'Running' && j.job_type === 'move');

    return {
      ...remote,
      syncState: {
        isOnSync: !!runningSyncJob,
        syncJobID: runningSyncJob?.jobid,
        isLocal: this.isLocalPath(
          this.remoteSettings[remote.remoteSpecs.name]?.['syncConfig']?.dest || ''
        ),
      },
      copyState: {
        isOnCopy: !!runningCopyJob,
        copyJobID: runningCopyJob?.jobid,
        isLocal: this.isLocalPath(
          this.remoteSettings[remote.remoteSpecs.name]?.['copyConfig']?.dest || ''
        ),
      },
      bisyncState: {
        isOnBisync: !!runningBisyncJob,
        bisyncJobID: runningBisyncJob?.jobid,
        isLocal: this.isLocalPath(
          this.remoteSettings[remote.remoteSpecs.name]?.['bisyncConfig']?.dest || ''
        ),
      },
      moveState: {
        isOnMove: !!runningMoveJob,
        moveJobID: runningMoveJob?.jobid,
        isLocal: this.isLocalPath(
          this.remoteSettings[remote.remoteSpecs.name]?.['moveConfig']?.dest || ''
        ),
      },
    };
  }

  private updateSelectedRemoteIfNeeded(): void {
    if (!this.selectedRemote) return;

    const updatedRemote = this.remotes.find(
      r => r.remoteSpecs.name === this.selectedRemote?.remoteSpecs.name
    );

    if (updatedRemote) {
      this.selectedRemote = { ...updatedRemote };
      this.cdr.markForCheck();
    }
  }

  private async loadJobsForRemote(remoteName: string): Promise<void> {
    try {
      const jobs = await this.jobManagementService.getActiveJobs();
      const remoteJobs = jobs.filter((j: { remote_name: string }) => j.remote_name === remoteName);

      if (remoteJobs.length > 0 && this.selectedRemote) {
        this.selectedRemote = this.updateRemoteWithJobs(this.selectedRemote, remoteJobs);
        this.cdr.markForCheck();
      }
    } catch (error) {
      this.handleError(`Failed to load jobs for ${remoteName}`, error);
    }
  }

  private getPathForOperation(remoteName: string, UsePath: UsePath): string | undefined {
    const settings = this.loadRemoteSettings(remoteName);
    const configMap = {
      mount: () => settings?.mountConfig?.dest,
      sync: () => settings?.syncConfig?.dest,
      copy: () => settings?.copyConfig?.dest,
      bisync: () => settings?.bisyncConfig?.dest,
      move: () => settings?.moveConfig?.dest,
      general: () => undefined,
    } as const;
    const getPath = configMap[UsePath];
    if (!getPath) {
      throw new Error(`Invalid UsePath: ${UsePath}`);
    }
    return getPath();
  }

  private getJobIdForOperation(
    remote: Remote | undefined,
    type: 'sync' | 'copy' | 'mount' | 'bisync' | 'move' | string
  ): number | undefined {
    if (!remote) return undefined;

    // Mount operations don't have job IDs in the same way
    if (type === 'mount') {
      return undefined; // Mount operations are handled differently
    }

    const jobIdMap = {
      sync: remote.syncState?.syncJobID,
      copy: remote.copyState?.copyJobID,
      bisync: remote.bisyncState?.bisyncJobID,
      move: remote.moveState?.moveJobID,
      mount: undefined,
    } as const;

    return jobIdMap[type as keyof typeof jobIdMap];
  }

  private handleRemoteDeletion(remoteName: string): void {
    this.remotes = this.remotes.filter(r => r.remoteSpecs.name !== remoteName);

    if (this.selectedRemote?.remoteSpecs.name === remoteName) {
      this.selectedRemote = null;
    }

    this.notificationService.openSnackBar(`Remote ${remoteName} deleted successfully.`, 'Close');
    this.cdr.markForCheck();
  }

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

  private handleError(message: string, error: any): void {
    console.error(`${message}:`, error);
    this.notificationService.openSnackBar(String(error), 'Close');
  }

  private async restrictValue(): Promise<void> {
    try {
      this.restrictMode = await this.appSettingsService.loadSettingValue('general', 'restrict');
    } catch (error) {
      this.handleError('Failed to load restrict setting', error);
    }
  }

  private setupTauriListeners(): void {
    // Global shortcut event for force checking mounted remotes
    this.eventListenersService
      .listenToShutdownSequence()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: async () => {
          try {
            console.log('Shutdown sequence initiated - Shutting down app');
            this.isShuttingDown = true;
            this.cdr.detectChanges();
          } catch (error) {
            console.error('Error during shutdown sequence:', error);
          }
        },
      });

    // UI notifications from backend
    this.eventListenersService
      .listenToNotifyUi()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: event => {
          const message = event.payload;
          if (message) {
            this.notificationService.openSnackBar(message, 'Close');
          }
        },
      });

    // Mount cache updated - only refresh mounts and update remote mount states
    this.eventListenersService
      .listenToMountCacheUpdated()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: async () => {
          try {
            console.log('Mount cache updated - refreshing mounts');
            await this.refreshMounts();
            this.updateRemoteMountStates();
            this.cdr.markForCheck();
          } catch (error) {
            this.handleError('Error handling mount_cache_updated', error);
          }
        },
      });

    // Remote cache updated - refresh remotes and settings
    this.eventListenersService
      .listenToRemoteCacheUpdated()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: async () => {
          try {
            console.log('Remote cache updated - refreshing remotes');
            await this.loadRemotes();
            await this.getRemoteSettings();
            await this.restrictValue();
            this.cdr.markForCheck();
          } catch (error) {
            this.handleError('Error handling remote_cache_updated', error);
          }
        },
      });

    // Rclone API ready - full refresh needed
    this.eventListenersService
      .listenToRcloneApiReady()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: async () => {
          try {
            console.log('Rclone API ready - full refresh');
            await this.refreshData();
            await this.restrictValue();
            this.cdr.markForCheck();
          } catch (error) {
            this.handleError('Error handling rclone_api_ready', error);
          }
        },
      });

    // Job cache changed - only refresh jobs and update job states
    this.eventListenersService
      .listenToJobCacheChanged()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: async () => {
          try {
            console.log('Job cache changed - refreshing jobs');
            await this.loadJobs();
            await this.loadActiveJobs();
            this.cdr.markForCheck();
          } catch (error) {
            this.handleError('Error handling job_cache_changed', error);
          }
        },
      });
  }

  // Helper method to update remote mount states without full reload
  private updateRemoteMountStates(): void {
    this.remotes = this.remotes.map(remote => ({
      ...remote,
      mountState: {
        ...remote.mountState,
        mounted: this.isRemoteMounted(remote.remoteSpecs.name),
      },
    }));

    // Update selected remote if it exists
    if (this.selectedRemote) {
      const updatedRemote = this.remotes.find(
        r => r.remoteSpecs.name === this.selectedRemote?.remoteSpecs.name
      );
      if (updatedRemote) {
        this.selectedRemote = { ...updatedRemote };
      }
    }
    this.cdr.markForCheck();
  }

  private cleanup(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.resizeObserver?.disconnect();
    this.uiStateService.resetSelectedRemote();
  }
}
