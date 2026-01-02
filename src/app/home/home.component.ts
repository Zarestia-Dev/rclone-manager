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
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { catchError, EMPTY, Observable, Subject, takeUntil, map } from 'rxjs';

// App Types
import {
  JobInfo,
  PrimaryActionType,
  Remote,
  RemoteAction,
  RemoteSettings,
  SyncOperationType,
} from '@app/types';

import { RemoteFacadeService } from '../services/facade/remote-facade.service';

// App Components
import { SidebarComponent } from '../layout/sidebar/sidebar.component';
import { GeneralDetailComponent } from '../features/components/dashboard/general-detail/general-detail.component';
import { GeneralOverviewComponent } from '../features/components/dashboard/general-overview/general-overview.component';
import { AppDetailComponent } from '../features/components/dashboard/app-detail/app-detail.component';
import { AppOverviewComponent } from '../features/components/dashboard/app-overview/app-overview.component';

// App Services
import { IconService } from '@app/services';
import { NotificationService } from '@app/services';
import {
  EventListenersService,
  UiStateService,
  SystemInfoService,
  AppSettingsService,
  ModalService,
  ConnectionService,
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
    AppDetailComponent,
    AppOverviewComponent,
    TranslateModule,
  ],
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.scss'],
})
export class HomeComponent implements OnInit, OnDestroy {
  // ============================================================================
  // PROPERTIES - SERVICES
  // ============================================================================
  private readonly modalService = inject(ModalService);
  private readonly uiStateService = inject(UiStateService);
  private readonly notificationService = inject(NotificationService);
  private readonly eventListenersService = inject(EventListenersService);
  private readonly remoteFacadeService = inject(RemoteFacadeService);
  private readonly connectionService = inject(ConnectionService);
  private readonly appSettingsService = inject(AppSettingsService);
  readonly systemInfoService = inject(SystemInfoService);
  readonly iconService = inject(IconService);
  private readonly translate = inject(TranslateService);

  // ============================================================================
  // PROPERTIES - DATA & UI STATE
  // ============================================================================
  currentTab = toSignal(this.uiStateService.currentTab$, { initialValue: 'general' as any });

  // Source of truth for SELECTION (from service)
  private readonly _selectedRemoteSource = toSignal(this.uiStateService.selectedRemote$, {
    initialValue: null as Remote | null,
  });

  // Facade provides unified and enriched data
  readonly remotes = this.remoteFacadeService.activeRemotes;

  // Expose raw signals from facade for template usage
  readonly jobs = this.remoteFacadeService.jobs;
  readonly mountedRemotes = this.remoteFacadeService.mountedRemotes;
  readonly runningServes = this.remoteFacadeService.runningServes;

  // Computed Source of truth for the OBJECT (merging selection with fresh data)
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
    return this.remoteFacadeService.getRemoteSettings(remote.remoteSpecs.name);
  });

  // Local UI state
  isSidebarOpen = signal(false);
  sidebarMode = signal<MatDrawerMode>('side');
  selectedSyncOperation = signal<SyncOperationType>('sync');
  isLoading = signal(false);

  // Reactive restriction mode from settings
  restrictMode = toSignal(
    this.appSettingsService
      .selectSetting('general.restrict')
      .pipe(map(setting => (setting?.value as boolean) ?? true)),
    { initialValue: true }
  );

  actionInProgress = this.remoteFacadeService.actionInProgress;
  // ============================================================================
  // PROPERTIES - LIFECYCLE
  // ============================================================================
  private destroy$ = new Subject<void>();
  private resizeObserver?: ResizeObserver;

  constructor() {
    // Reactive side effects for when service data changes
    // Note: mountedRemotes and runningServes effects are now handled by RemoteFacadeService enrichment

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
      this.setupResponsiveLayout();
      // Ensure settings are loaded
      await this.appSettingsService.loadSettings();
      await this.loadInitialData();
      this.setupTauriListeners();
    } catch (error) {
      this.handleError(this.translate.instant('home.errors.configFailed'), error);
    }
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  /** Get operation state from a remote */
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
      this.handleError(this.translate.instant('home.errors.initialLoadFailed'), error);
    } finally {
      this.isLoading.set(false);
    }
  }

  private async refreshData(): Promise<void> {
    await this.remoteFacadeService.refreshAll();
  }

  private async loadRemotes(): Promise<void> {
    try {
      await this.remoteFacadeService.loadRemotes();
      // Ensure we pass the list explicitly
      this.loadDiskUsageInBackground(this.remotes());
    } catch (error) {
      this.handleError(this.translate.instant('home.errors.loadRemotesFailed'), error);
    }
  }

  async updateRemoteDiskUsage(remoteName: string): Promise<void> {
    try {
      await this.remoteFacadeService.getCachedOrFetchDiskUsage(remoteName);
    } catch (error) {
      console.error(`Failed to update disk usage for ${remoteName}:`, error);
      this.remoteFacadeService.updateDiskUsage(remoteName, { loading: false, error: true });
    }
  }

  // Load disk usage for visible remotes one by one to avoid backend congestion
  loadDiskUsageInBackground(remotes: Remote[]): void {
    const remotesToLoad = remotes.filter(
      r =>
        !r.diskUsage.loading &&
        !r.diskUsage.error &&
        r.diskUsage.total_space === undefined &&
        !r.diskUsage.notSupported &&
        r.remoteSpecs.type !== 'crypt' // Skip crypt remotes for disk usage
    );

    if (remotesToLoad.length === 0) return;

    // Process one by one
    (async () => {
      for (const remote of remotesToLoad) {
        await this.updateRemoteDiskUsage(remote.remoteSpecs.name);
        // Small delay between requests
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    })();
  }

  // ============================================================================
  // TAURI EVENT LISTENERS
  // ============================================================================
  private setupTauriListeners(): void {
    // Engine ready - full refresh needed
    this.setupEventListener(
      () => this.eventListenersService.listenToRcloneEngineReady(),
      async () => {
        await this.refreshData();
      },
      'RcloneEngine'
    );
  }

  private setupEventListener(
    eventFn: () => Observable<unknown>,
    handler: () => Promise<unknown>,
    context: string
  ): void {
    eventFn()
      .pipe(
        takeUntil(this.destroy$),
        catchError(error => (console.error(`Event listener error (${context}):`, error), EMPTY))
      )
      .subscribe({
        next: async () => {
          try {
            await handler();
          } catch (error) {
            this.handleError(`Error handling ${context} event`, error);
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
      await this.saveRemoteSettings(remoteName, { primaryActions: newActions });
    } catch (error) {
      this.handleError(this.translate.instant('home.errors.updateActionsFailed'), error);
    }
  }

  // ============================================================================
  // REMOTE & JOB OPERATIONS
  // ============================================================================
  async startJob(
    operationType: PrimaryActionType,
    remoteName: string,
    profileName?: string
  ): Promise<void> {
    try {
      await this.remoteFacadeService.startJob(remoteName, operationType, profileName);
    } catch (error) {
      this.handleError(
        this.translate.instant('home.errors.startJobFailed', {
          type: operationType,
          name: remoteName,
        }) + (profileName ? ` (${profileName})` : ''),
        error
      );
    }
  }

  async stopJob(
    type: PrimaryActionType,
    remoteName: string,
    serveId?: string,
    profileName?: string
  ): Promise<void> {
    try {
      await this.remoteFacadeService.stopJob(remoteName, type, serveId, profileName);
    } catch (error) {
      this.handleError(
        this.translate.instant('home.errors.stopJobFailed', { type: type, name: remoteName }),
        error
      );
    }
  }

  async deleteRemote(remoteName: string): Promise<void> {
    if (!remoteName) return;
    try {
      const confirmed = await this.notificationService.confirmModal(
        this.translate.instant('home.deleteRemote.title'),
        this.translate.instant('home.deleteRemote.message', { name: remoteName })
      );
      if (!confirmed) return;

      await this.remoteFacadeService.deleteRemote(remoteName);

      this.handleRemoteDeletion(remoteName);
    } catch (error) {
      this.handleError(
        this.translate.instant('home.errors.deleteRemoteFailed', { name: remoteName }),
        error
      );
    }
  }

  async openRemoteInFiles(
    remoteName: string,
    pathOrOperation?: string | PrimaryActionType
  ): Promise<void> {
    try {
      await this.remoteFacadeService.openRemoteInFiles(remoteName, pathOrOperation);
    } catch (error) {
      this.handleError(
        this.translate.instant('home.errors.openFailed', { name: remoteName }),
        error
      );
    }
  }

  async unmountRemote(remoteName: string): Promise<void> {
    try {
      await this.remoteFacadeService.unmountRemote(remoteName);
    } catch (error) {
      this.handleError(
        this.translate.instant('home.errors.unmountFailed', { name: remoteName }),
        error
      );
    }
  }

  async deleteJob(jobId: number): Promise<void> {
    try {
      await this.remoteFacadeService.deleteJob(jobId);
      this.notificationService.openSnackBar(
        this.translate.instant('home.notifications.jobDeleted', { id: jobId }),
        this.translate.instant('common.close')
      );
    } catch (error) {
      this.handleError(this.translate.instant('home.errors.deleteJobFailed', { id: jobId }), error);
    }
  }

  // ============================================================================
  // MODAL DIALOGS
  // ============================================================================
  openQuickAddRemoteModal(): void {
    this.modalService.openQuickAddRemote();
  }

  openRemoteConfigModal(
    editTarget?: string,
    existingConfig?: RemoteSettings,
    initialSection?: string,
    targetProfile?: string
  ): void {
    this.modalService.openRemoteConfig({
      remoteName: this.selectedRemote()?.remoteSpecs.name,
      editTarget,
      existingConfig,
      restrictMode: this.restrictMode(),
      initialSection,
      targetProfile,
    });
  }

  openLogsModal(remoteName: string): void {
    this.modalService.openLogs(remoteName);
  }

  async cloneRemote(remoteName: string): Promise<void> {
    const config = await this.remoteFacadeService.cloneRemote(remoteName);
    if (!config) return;

    this.modalService.openRemoteConfig({
      remoteName: config['remoteSpecs'].name,
      cloneTarget: true,
      existingConfig: config,
      restrictMode: this.restrictMode(),
    });
  }

  openExportModal(remoteName: string): void {
    this.modalService.openExport({ remoteName, defaultExportType: 'SpecificRemote' });
  }

  openBackendModal(): void {
    this.modalService.openBackend();
  }

  // ============================================================================
  // SETTINGS MANAGEMENT
  // ============================================================================

  loadRemoteSettings(remoteName: string): RemoteSettings {
    return this.remoteFacadeService.getRemoteSettings(remoteName);
  }

  getRemoteSettingValue(remoteName: string, key: string): any {
    return this.loadRemoteSettings(remoteName)?.[key as keyof RemoteSettings];
  }

  async saveRemoteSettings(remoteName: string, settings: Partial<RemoteSettings>): Promise<void> {
    const currentSettings = this.loadRemoteSettings(remoteName);
    const mergedSettings = { ...currentSettings, ...settings };

    await this.appSettingsService.saveRemoteSettings(remoteName, mergedSettings);
    await this.remoteFacadeService.loadRemotes();
  }

  async resetRemoteSettings(remoteName: string): Promise<void> {
    if (!remoteName) return;
    try {
      const confirmed = await this.notificationService.confirmModal(
        this.translate.instant('home.resetRemote.title'),
        this.translate.instant('home.resetRemote.message', { name: remoteName })
      );
      if (confirmed) {
        await this.appSettingsService.resetRemoteSettings(remoteName);
        await this.remoteFacadeService.loadRemotes();
        this.notificationService.openSnackBar(
          this.translate.instant('home.notifications.settingsReset', { name: remoteName }),
          this.translate.instant('common.close')
        );
      }
    } catch (error) {
      this.handleError(this.translate.instant('home.errors.resetSettingsFailed'), error);
    }
  }

  // ============================================================================
  // UTILITY & HELPER METHODS
  // ============================================================================
  private async executeRemoteAction(
    remoteName: string,
    action: RemoteAction,
    operation: () => Promise<void>,
    errorMessage: string,
    profileName?: string
  ): Promise<void> {
    if (!remoteName) return;
    try {
      await this.remoteFacadeService.executeAction(remoteName, action, operation, profileName);
    } catch (error) {
      this.handleError(errorMessage, error);
    }
  }

  isActionInProgress(remoteName: string, action: RemoteAction, profileName?: string): boolean {
    return this.remoteFacadeService.isActionInProgress(remoteName, action, profileName);
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

  getJobsForRemote(remoteName: string): JobInfo[] {
    return this.jobs().filter(j => j.remote_name === remoteName);
  }

  private getMountPoint(remoteName: string): string | undefined {
    const mount = this.mountedRemotes().find(m => m.fs.startsWith(`${remoteName}:`));
    return mount?.mount_point;
  }

  private isRemoteMounted(remoteName: string): boolean {
    return this.mountedRemotes().some(m => m.fs.startsWith(`${remoteName}:`));
  }

  private getPathForOperation(remoteName: string, usePath: PrimaryActionType): string | undefined {
    const settings = this.loadRemoteSettings(remoteName);
    const configKey = `${usePath}Configs` as keyof RemoteSettings;
    const profiles = settings[configKey] as Record<string, unknown> | undefined;
    if (!profiles) return undefined;

    const firstProfileKey = Object.keys(profiles)[0];
    const firstProfile = firstProfileKey ? (profiles as any)[firstProfileKey] : undefined;
    return firstProfile?.dest;
  }

  private handleRemoteDeletion(remoteName: string): void {
    // Facade will handle the data update when the event comes in, or we trigger a reload.
    // Trigger reload to be responsive.
    this.remoteFacadeService.loadRemotes();

    if (this.selectedRemote()?.remoteSpecs.name === remoteName) {
      this.uiStateService.resetSelectedRemote();
    }
    this.notificationService.openSnackBar(
      this.translate.instant('home.notifications.deleteRemoteSuccess', { name: remoteName }),
      this.translate.instant('common.close')
    );
  }

  private handleError(message: string, error: unknown): void {
    console.error(`${message}:`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.notificationService.openSnackBar(errorMessage, this.translate.instant('common.close'));
  }

  private cleanup(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.resizeObserver?.disconnect();
    this.uiStateService.resetSelectedRemote();
  }
}
