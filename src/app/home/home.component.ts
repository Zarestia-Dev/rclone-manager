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
import { catchError, EMPTY, Subject, takeUntil } from 'rxjs';

// Components
import {
  AppTab,
  BandwidthLimitResponse,
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
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomeComponent implements OnInit, OnDestroy {
  // UI State
  isSidebarOpen = false;
  sidebarMode: MatDrawerMode = 'side';
  currentTab: AppTab = 'general';
  // Track the selected sync subtype (sync, bisync, copy, move)
  selectedSyncOperation: SyncOperationType = 'sync';
  UsePath: PrimaryActionType = 'mount';
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

  constructor() {
    this.restrictValue();
  }

  // Handle sync subtype changes coming from AppDetail
  onSyncOperationChange(operation: SyncOperationType): void {
    this.selectedSyncOperation = operation;
    // Persist selection per-remote if a remote is selected
    if (this.selectedRemote?.remoteSpecs?.name) {
      this.saveRemoteSettings(this.selectedRemote.remoteSpecs.name, {
        selectedSyncOperation: operation,
      });
    }
    this.cdr.markForCheck();
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
      // Ensure mount state is refreshed and applied to remotes after initial load
      await this.refreshMounts();
      this.updateRemoteMountStates();
      this.cdr.markForCheck();
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
    // Try to restore previously selected sync operation for this remote if available
    const settings = this.loadRemoteSettings(remote.remoteSpecs.name) || {};
    if (settings.selectedSyncOperation && typeof settings.selectedSyncOperation === 'string') {
      this.selectedSyncOperation = settings.selectedSyncOperation as SyncOperationType;
    } else {
      this.selectedSyncOperation = 'sync';
    }
    this.cdr.markForCheck();
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

  async openRemoteInFiles(remoteName: string, UsePath: PrimaryActionType): Promise<void> {
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
  async startJob(operationType: PrimaryActionType, remoteName: string): Promise<void> {
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
        const dryRun = config.dryRun;
        const resync = config.resync;
        switch (operationType) {
          case 'mount':
            await this.mountRemote(remoteName);
            break;
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
              filterConfig,
              dryRun,
              resync
            );
            break;
          case 'move': {
            // You'll need to implement this in your JobManagementService
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
  async stopJob(type: PrimaryActionType, remoteName: string): Promise<void> {
    await this.executeRemoteAction(
      remoteName,
      'stop',
      async () => {
        if (type === 'mount') {
          // For mount, perform unmount operation
          await this.unmountRemote(remoteName);
        } else {
          const remote = this.remotes.find(r => r.remoteSpecs.name === remoteName);
          const jobId = this.getJobIdForOperation(remote, type);

          if (!jobId) {
            throw new Error(`No ${type} job ID found for ${remoteName}`);
          }
          console.log(`Stopping ${type} for ${remoteName} with job ID:`, jobId);

          if (jobId === undefined) {
            throw new Error(`No job ID found for ${type} operation on ${remoteName}`);
          }
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

  cloneRemote(remoteName: string): void {
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

  private updateSourcesForClonedRemote(
    settings: Record<string, any>,
    oldName: string,
    newName: string
  ): Record<string, any> {
    // Helper to update source fields in all configs
    const updateSource = (obj: Record<string, any> | undefined, key: string): void => {
      if (obj && typeof obj[key] === 'string' && obj[key].startsWith(`${oldName}:`)) {
        obj[key] = obj[key].replace(`${oldName}:`, `${newName}:`);
      }
    };

    updateSource(settings['mountConfig'] as Record<string, any> | undefined, 'source');
    updateSource(settings['syncConfig'] as Record<string, any> | undefined, 'source');
    updateSource(settings['copyConfig'] as Record<string, any> | undefined, 'source');

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
        defaultExportType: 'SpecificRemote',
      },
    });
  }

  // Remote Settings
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
    this.isLoading = true;
    // Single change detection for initial state
    this.cdr.markForCheck();

    try {
      await this.refreshData();
    } catch (error) {
      this.handleError('Initial load failed', error);
    } finally {
      this.isLoading = false;
      // Single change detection for final state
      this.cdr.markForCheck();
    }
  }
  private async refreshData(): Promise<void> {
    console.log('HomeComponent: Starting data refresh');
    try {
      // Sequential loading where order matters
      await this.getRemoteSettings(); // Load settings first
      await this.loadRemotes(); // Then remotes (which need settings)
      await Promise.all([this.refreshMounts(), this.loadJobs()]);
      // Ensure remotes reflect the refreshed mount information
      this.updateRemoteMountStates();
    } catch (error) {
      console.error('HomeComponent: Data refresh failed:', error);
      throw error;
    }
  }

  private async loadRemotes(): Promise<void> {
    try {
      await this.getRemoteSettings();
      const remoteConfigs = await this.remoteManagementService.getAllRemoteConfigs();

      // Refresh mounts first so createRemotesFromConfigs can set mountState correctly
      await this.refreshMounts();

      // Create remotes from configs (preserving existing state)
      this.remotes = this.createRemotesFromConfigs(remoteConfigs);

      // Load active jobs FIRST to set job states
      await this.loadActiveJobs();

      // Then load disk usage in background
      this.loadDiskUsageInBackground();

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
      throw error; // Re-throw if caller needs to know
    }
  }

  private buildMountedNameSet(): Set<string> {
    const set = new Set<string>();
    this.mountedRemotes.forEach(m => {
      // mounted fs strings look like "name:..." — extract prefix before ':'
      const parts = m.fs.split(':');
      if (parts.length > 0 && parts[0]) set.add(parts[0]);
    });
    return set;
  }

  private createRemotesFromConfigs(remoteConfigs: Record<string, any>): Remote[] {
    const mountedSet = this.buildMountedNameSet();

    return Object.keys(remoteConfigs).map(name => {
      // Find existing remote to preserve its state
      const existingRemote = this.remotes.find(r => r.remoteSpecs.name === name);
      const settings = this.loadRemoteSettings(name);

      return {
        remoteSpecs: { name, ...remoteConfigs[name] },
        primaryActions: settings?.primaryActions || [],
        // Disk usage moved to top-level
        diskUsage: existingRemote?.diskUsage || {
          total_space: 'Loading...',
          used_space: 'Loading...',
          free_space: 'Loading...',
          loading: true,
        },
        mountState: {
          mounted: mountedSet.has(name),
        },
        // Preserve existing job states if available
        syncState: existingRemote?.syncState || {
          isOnSync: false,
          syncJobID: 0,
          isLocal: this.isLocalPath(settings?.syncConfig?.dest || ''),
        },
        copyState: existingRemote?.copyState || {
          isOnCopy: false,
          copyJobID: 0,
          isLocal: this.isLocalPath(settings?.copyConfig?.dest || ''),
        },
        bisyncState: existingRemote?.bisyncState || {
          isOnBisync: false,
          bisyncJobID: 0,
          isLocal: this.isLocalPath(settings?.bisyncConfig?.dest || ''),
        },
        moveState: existingRemote?.moveState || {
          isOnMove: false,
          moveJobID: 0,
          isLocal: this.isLocalPath(settings?.moveConfig?.dest || ''),
        },
      };
    });
  }

  private async updateRemoteDiskUsage(remote: Remote): Promise<void> {
    const updateDiskUsageState = (updates: Partial<DiskUsage>): void => {
      // Find the current remote in the list to get the latest state
      const currentRemote = this.remotes.find(r => r.remoteSpecs.name === remote.remoteSpecs.name);
      if (!currentRemote) return;

      const updatedRemote = {
        ...currentRemote,
        diskUsage: {
          ...currentRemote.diskUsage,
          ...updates,
        },
      };
      this.updateRemoteInList(updatedRemote);
    };

    try {
      updateDiskUsageState({ loading: true });

      const fsInfo = await this.remoteManagementService.getFsInfo(remote.remoteSpecs.name);
      const aboutFlag =
        fsInfo &&
        typeof fsInfo === 'object' &&
        'Features' in (fsInfo as Record<string, unknown>) &&
        typeof (fsInfo as Record<string, unknown>)['Features'] === 'object' &&
        ((fsInfo as Record<string, unknown>)['Features'] as Record<string, unknown>)?.['About'] ===
          false;

      if (aboutFlag) {
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

  private async loadDiskUsageInBackground(): Promise<void> {
    // Filter remotes that need disk usage updates
    const remotesNeedingUpdate = this.remotes.filter(remote => {
      const du = remote.diskUsage;
      return !du || du.loading || du.error;
    });

    // Process disk usage updates without awaiting (fire and forget)
    remotesNeedingUpdate.forEach(remote => {
      this.updateRemoteDiskUsage(remote).catch(error => {
        console.error(`Background disk usage update failed for ${remote.remoteSpecs.name}:`, error);
      });
    });
  }

  private async getRemoteSettings(): Promise<void> {
    this.remoteSettings = await this.appSettingsService.getRemoteSettings();
    this.cdr.markForCheck();
  }

  private async refreshMounts(): Promise<void> {
    this.mountedRemotes = await this.mountManagementService.getMountedRemotes();
    this.updateRemoteMountStates();
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
      this.cdr.markForCheck();
    } catch (error) {
      this.handleError('Failed to load jobs', error);
    }
  }

  private updateRemoteInList(updatedRemote: Remote): void {
    // Update the remotes array
    this.remotes = this.remotes.map(r =>
      r.remoteSpecs.name === updatedRemote.remoteSpecs.name ? updatedRemote : r
    );

    // Update selectedRemote if it matches
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

  private async loadJobsForRemote(remoteName: string): Promise<void> {
    try {
      const jobs = await this.jobManagementService.getActiveJobs();
      const remoteJobs = jobs.filter((j: { remote_name: string }) => j.remote_name === remoteName);

      if (remoteJobs.length > 0 && this.selectedRemote) {
        this.updateRemoteWithJobs(this.selectedRemote, remoteJobs);
      }
    } catch (error) {
      this.handleError(`Failed to load jobs for ${remoteName}`, error);
    }
  }

  private getPathForOperation(remoteName: string, UsePath: PrimaryActionType): string | undefined {
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

  private handleError(message: string, error: unknown): void {
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
      .listenToAppEvents()
      .pipe(
        takeUntil(this.destroy$),
        catchError(error => {
          console.error('Event listener error:', error);
          return EMPTY;
        })
      )
      .subscribe({
        next: async event => {
          try {
            console.log('Rclone Engine event payload:', event);

            // Only handle if payload is 'ready'
            if (typeof event === 'object' && event?.status === 'shutting_down') {
              console.log('Shutdown sequence initiated - Shutting down app');
              this.isShuttingDown = true;
              this.cdr.detectChanges();
            }
          } catch (error) {
            console.error('Error during shutdown sequence:', error);
          }
        },
      });

    // UI notifications from backend
    this.eventListenersService
      .listenToNotifyUi()
      .pipe(
        takeUntil(this.destroy$),
        catchError(error => {
          console.error('Event listener error:', error);
          return EMPTY;
        })
      )
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
      .pipe(
        takeUntil(this.destroy$),
        catchError(error => {
          console.error('Event listener error:', error);
          return EMPTY;
        })
      )
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
      .pipe(
        takeUntil(this.destroy$),
        catchError(error => {
          console.error('Event listener error:', error);
          return EMPTY;
        })
      )
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

    // Rclone Engine ready - full refresh needed
    this.eventListenersService
      .listenToRcloneEngine()
      .pipe(
        takeUntil(this.destroy$),
        catchError(error => {
          console.error('Event listener error:', error);
          return EMPTY;
        })
      )
      .subscribe({
        next: async event => {
          try {
            console.log('Rclone Engine event payload:', event);

            // Only handle if payload is 'ready'
            if (typeof event === 'object' && event?.status === 'ready') {
              console.log('Refreshing data for Rclone Engine');
              await this.refreshData();
              await this.restrictValue();
              this.cdr.markForCheck();
            } else {
              console.log('Rclone Engine ready - payload not "ready":', event);
            }
          } catch (error) {
            this.handleError('Error handling rclone_engine', error);
          }
        },
      });

    // Job cache changed - only refresh jobs and update job states
    this.eventListenersService
      .listenToJobCacheChanged()
      .pipe(
        takeUntil(this.destroy$),
        catchError(error => {
          console.error('Event listener error:', error);
          return EMPTY;
        })
      )
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

  async togglePrimaryAction(type: PrimaryActionType): Promise<void> {
    if (!this.selectedRemote) return;

    const remoteName = this.selectedRemote.remoteSpecs.name;
    const currentActions = this.selectedRemote.primaryActions || [];

    const newActions = currentActions.includes(type)
      ? currentActions.filter(action => action !== type) // Remove if already selected
      : [...currentActions, type]; // Add to selection

    try {
      await this.appSettingsService.saveRemoteSettings(remoteName, {
        primaryActions: newActions,
      });

      // Update the selected remote
      this.selectedRemote = {
        ...this.selectedRemote,
        primaryActions: newActions,
      };

      this.cdr.markForCheck();
    } catch (error) {
      this.handleError('Failed to update quick actions', error);
    }
  }

  // Helper method to update remote mount states without full reload
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

  private cleanup(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.resizeObserver?.disconnect();
    this.uiStateService.resetSelectedRemote();
  }
}
