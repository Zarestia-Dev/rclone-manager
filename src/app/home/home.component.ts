import {
  Component,
  OnInit,
  OnDestroy,
  effect,
  inject,
  signal,
  computed,
  DestroyRef,
} from '@angular/core';
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

import {
  JobInfo,
  PrimaryActionType,
  Remote,
  RemoteAction,
  RemoteSettings,
  SyncOperationType,
} from '@app/types';

import { RemoteFacadeService } from '../services/facade/remote-facade.service';
import { SidebarComponent } from '../layout/sidebar/sidebar.component';
import { GeneralDetailComponent } from '../features/components/dashboard/general-detail/general-detail.component';
import { GeneralOverviewComponent } from '../features/components/dashboard/general-overview/general-overview.component';
import { AppDetailComponent } from '../features/components/dashboard/app-detail/app-detail.component';
import { AppOverviewComponent } from '../features/components/dashboard/app-overview/app-overview.component';
import {
  IconService,
  NotificationService,
  EventListenersService,
  UiStateService,
  SystemInfoService,
  AppSettingsService,
  ModalService,
  BackendService,
  RcloneStatusService,
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
    TranslateModule,
  ],
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.scss'],
})
export class HomeComponent implements OnInit, OnDestroy {
  private readonly modalService = inject(ModalService);
  private readonly uiStateService = inject(UiStateService);
  private readonly notificationService = inject(NotificationService);
  private readonly eventListenersService = inject(EventListenersService);
  private readonly remoteFacadeService = inject(RemoteFacadeService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly backendService = inject(BackendService);
  private readonly rcloneStatusService = inject(RcloneStatusService);
  readonly systemInfoService = inject(SystemInfoService);
  readonly iconService = inject(IconService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  readonly activeBackend = this.backendService.activeBackend;

  readonly backendStatusClass = computed(() =>
    this.rcloneStatusService.rcloneStatus() === 'active' ? 'connected' : 'disconnected'
  );

  readonly currentTab = this.uiStateService.currentTab;

  private readonly _selectedRemoteSource = this.uiStateService.selectedRemote;
  readonly remotes = this.remoteFacadeService.activeRemotes;
  readonly jobs = this.remoteFacadeService.jobs;
  readonly mountedRemotes = this.remoteFacadeService.mountedRemotes;
  readonly runningServes = this.remoteFacadeService.runningServes;
  readonly actionInProgress = this.remoteFacadeService.actionInProgress;

  readonly selectedRemote = computed(() => {
    const source = this._selectedRemoteSource();
    if (!source) return null;
    return this.remotes().find(r => r.name === source.name) ?? source;
  });

  readonly selectedRemoteSettings = computed(() => {
    const remote = this.selectedRemote();
    if (!remote) return {};
    return this.remoteFacadeService.getRemoteSettings(remote.name);
  });

  isSidebarOpen = signal(false);
  sidebarMode = signal<MatDrawerMode>('side');
  selectedSyncOperation = signal<SyncOperationType>('sync');
  isLoading = signal(false);

  private resizeObserver?: ResizeObserver;

  constructor() {
    // Restore saved sync operation when remote changes
    effect(() => {
      const remote = this.selectedRemote();
      if (remote) {
        const settings = this.selectedRemoteSettings();
        const savedOp = (settings['selectedSyncOperation'] as SyncOperationType) ?? 'sync';
        if (this.selectedSyncOperation() !== savedOp) {
          this.selectedSyncOperation.set(savedOp);
        }
      }
    });
  }

  async ngOnInit(): Promise<void> {
    try {
      this.setupResponsiveLayout();
      await this.loadInitialData();
    } catch (error) {
      this.handleError(this.translate.instant('home.errors.configFailed'), error);
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.uiStateService.resetSelectedRemote();
  }

  private setupResponsiveLayout(): void {
    this.updateSidebarMode();
    if (typeof window !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.updateSidebarMode());
      this.resizeObserver.observe(document.body);
    }
  }

  private updateSidebarMode(): void {
    const newMode: MatDrawerMode = window.innerWidth < 900 ? 'over' : 'side';
    if (newMode !== this.sidebarMode()) {
      this.sidebarMode.set(newMode);
    }
  }

  private async loadInitialData(): Promise<void> {
    this.isLoading.set(true);
    try {
      await this.remoteFacadeService.refreshAll();
    } catch (error) {
      this.handleError(this.translate.instant('home.errors.initialLoadFailed'), error);
    } finally {
      this.isLoading.set(false);
    }
  }

  selectRemote(remote: Remote): void {
    this.uiStateService.setSelectedRemote(remote);
  }

  onSyncOperationChange(operation: SyncOperationType): void {
    this.selectedSyncOperation.set(operation);
    const remote = this.selectedRemote();
    if (remote?.name) {
      void this.saveRemoteSettings(remote.name, { selectedSyncOperation: operation });
    }
  }

  async togglePrimaryAction(type: PrimaryActionType): Promise<void> {
    const remote = this.selectedRemote();
    if (!remote) return;

    const currentActions = remote.primaryActions ?? [];
    const newActions = currentActions.includes(type)
      ? currentActions.filter(action => action !== type)
      : [...currentActions, type];

    try {
      await this.saveRemoteSettings(remote.name, { primaryActions: newActions });
    } catch (error) {
      this.handleError(this.translate.instant('home.errors.updateActionsFailed'), error);
    }
  }

  async startJob(
    operationType: PrimaryActionType,
    remoteName: string,
    profileName?: string
  ): Promise<void> {
    try {
      await this.remoteFacadeService.startJob(
        remoteName,
        operationType as any,
        profileName,
        'dashboard'
      );
    } catch (error) {
      console.error('Start job failed:', error);
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
      console.error('Stop job failed:', error);
    }
  }

  async deleteRemote(remoteName: string): Promise<void> {
    if (!remoteName) return;
    try {
      await this.remoteFacadeService.deleteRemote(remoteName);
      this.remoteFacadeService.loadRemotes();
      if (this.selectedRemote()?.name === remoteName) {
        this.uiStateService.resetSelectedRemote();
      }
    } catch (error) {
      console.error('Delete remote failed:', error);
    }
  }

  async openRemoteInFiles(
    remoteName: string,
    pathOrOperation?: string | PrimaryActionType
  ): Promise<void> {
    try {
      await this.remoteFacadeService.openRemoteInFiles(remoteName, pathOrOperation);
    } catch (error) {
      console.error('Open remote failed:', error);
    }
  }

  async unmountRemote(remoteName: string): Promise<void> {
    try {
      await this.remoteFacadeService.unmountRemote(remoteName);
    } catch (error) {
      console.error('Unmount failed:', error);
    }
  }

  async deleteJob(jobId: number): Promise<void> {
    try {
      await this.remoteFacadeService.deleteJob(jobId);
    } catch (error) {
      console.error('Delete job failed:', error);
    }
  }

  openQuickAddRemoteModal(): void {
    this.modalService.openQuickAddRemote();
  }

  openRemoteConfigModal(
    editTarget?: string,
    existingConfig?: RemoteSettings,
    initialSection?: string,
    targetProfile?: string,
    remoteType?: string
  ): void {
    this.modalService.openRemoteConfig({
      remoteName: this.selectedRemote()?.name,
      remoteType,
      editTarget,
      existingConfig,
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

    const configData = config as { name: string; [key: string]: any };
    this.modalService.openRemoteConfig({
      remoteName: configData['name'],
      cloneTarget: true,
      existingConfig: configData,
    });
  }

  openExportModal(remoteName: string): void {
    this.modalService.openExport({ remoteName, defaultExportType: 'SpecificRemote' });
  }

  openBackendModal(): void {
    this.modalService.openBackend();
  }

  loadRemoteSettings(remoteName: string): RemoteSettings {
    return this.remoteFacadeService.getRemoteSettings(remoteName);
  }

  getRemoteSettingValue(remoteName: string, key: string): any {
    return this.loadRemoteSettings(remoteName)?.[key as keyof RemoteSettings];
  }

  async saveRemoteSettings(remoteName: string, settings: Partial<RemoteSettings>): Promise<void> {
    const merged = { ...this.loadRemoteSettings(remoteName), ...settings };
    await this.appSettingsService.saveRemoteSettings(remoteName, merged);
    await this.remoteFacadeService.loadRemotes();
  }

  async resetRemoteSettings(remoteName: string): Promise<void> {
    if (!remoteName) return;
    try {
      const confirmed = await this.notificationService.confirmModal(
        this.translate.instant('home.resetRemote.title'),
        this.translate.instant('home.resetRemote.message', { name: remoteName }),
        undefined,
        undefined,
        {
          icon: 'rotate-right',
          iconColor: 'warn',
          iconClass: 'destructive',
          confirmButtonColor: 'warn',
        }
      );
      if (confirmed) {
        await this.appSettingsService.resetRemoteSettings(remoteName);
        await this.remoteFacadeService.loadRemotes();
        this.notificationService.showSuccess(
          this.translate.instant('home.notifications.settingsReset', { name: remoteName })
        );
      }
    } catch (error) {
      this.handleError(this.translate.instant('home.errors.resetSettingsFailed'), error);
    }
  }

  async handleRetryDiskUsage(remoteName: string): Promise<void> {
    await this.remoteFacadeService.getCachedOrFetchDiskUsage(
      remoteName,
      undefined,
      'dashboard',
      true
    );
  }

  isActionInProgress(remoteName: string, action: RemoteAction, profileName?: string): boolean {
    return this.remoteFacadeService.isActionInProgress(remoteName, action, profileName);
  }

  getJobsForRemote(remoteName: string): JobInfo[] {
    return this.jobs().filter(j => j.remote_name === remoteName);
  }

  private handleError(message: string, error: unknown): void {
    console.error(`${message}:`, error);
    const backendMessage = error instanceof Error ? error.message : String(error);
    this.notificationService.showError(`${message}: ${backendMessage}`);
  }
}
