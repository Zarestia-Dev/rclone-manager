import {
  Component,
  afterNextRender,
  effect,
  inject,
  signal,
  computed,
  untracked,
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
  OperationTab,
  PrimaryActionType,
  Remote,
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
  NotificationService,
  UiStateService,
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
export class HomeComponent {
  private readonly modalService = inject(ModalService);
  private readonly uiStateService = inject(UiStateService);
  private readonly notificationService = inject(NotificationService);
  private readonly remoteFacadeService = inject(RemoteFacadeService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly backendService = inject(BackendService);
  private readonly rcloneStatusService = inject(RcloneStatusService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  readonly activeBackend = this.backendService.activeBackend;
  readonly currentTab = this.uiStateService.currentTab;
  readonly remotes = this.remoteFacadeService.activeRemotes;
  readonly jobs = this.remoteFacadeService.jobs;
  readonly runningServes = this.remoteFacadeService.runningServes;
  readonly actionInProgress = this.remoteFacadeService.actionInProgress;

  readonly backendStatusClass = computed(() =>
    this.rcloneStatusService.rcloneStatus() === 'active' ? 'connected' : 'disconnected'
  );

  readonly selectedRemote = computed(() => {
    const source = this.uiStateService.selectedRemote();
    if (!source) return null;
    return this.remotes().find(r => r.name === source.name) ?? source;
  });

  readonly selectedRemoteSettings = computed(() => {
    const remote = this.selectedRemote();
    return remote ? this.remoteFacadeService.getRemoteSettings(remote.name) : {};
  });

  readonly mainOperationType = computed<OperationTab>(() => {
    const tab = this.currentTab();
    return tab === 'general' ? 'mount' : tab;
  });

  readonly isSidebarOpen = signal(false);
  readonly sidebarMode = signal<MatDrawerMode>('side');
  readonly selectedSyncOperation = signal<SyncOperationType>('sync');

  private readonly _isLoading = signal(false);
  readonly isLoading = this._isLoading.asReadonly();

  private resizeObserver?: ResizeObserver;

  constructor() {
    effect(() => {
      const settings = this.selectedRemoteSettings();
      if (this.selectedRemote()) {
        const saved = (settings['selectedSyncOperation'] as SyncOperationType) ?? 'sync';
        untracked(() => this.selectedSyncOperation.set(saved));
      }
    });

    afterNextRender(() => this.setupResponsiveLayout());

    void this.loadInitialData();

    this.destroyRef.onDestroy(() => {
      this.resizeObserver?.disconnect();
      this.uiStateService.resetSelectedRemote();
    });
  }

  // --- Layout ---

  private setupResponsiveLayout(): void {
    this.updateSidebarMode();
    this.resizeObserver = new ResizeObserver(() => this.updateSidebarMode());
    this.resizeObserver.observe(document.body);
  }

  private updateSidebarMode(): void {
    const next: MatDrawerMode = window.innerWidth < 900 ? 'over' : 'side';
    if (next !== this.sidebarMode()) this.sidebarMode.set(next);
  }

  // --- Data ---

  private async loadInitialData(): Promise<void> {
    this._isLoading.set(true);
    try {
      await this.remoteFacadeService.refreshAll();
    } catch (error) {
      this.handleError(this.translate.instant('home.errors.initialLoadFailed'), error);
    } finally {
      this._isLoading.set(false);
    }
  }

  // --- Remote Selection ---

  selectRemote(remote: Remote): void {
    this.uiStateService.setSelectedRemote(remote);
  }

  // --- Sync Operation ---

  onSyncOperationChange(operation: SyncOperationType): void {
    this.selectedSyncOperation.set(operation);
    const remote = this.selectedRemote();
    if (remote?.name) {
      void this.saveRemoteSettings(remote.name, { selectedSyncOperation: operation });
    }
  }

  // --- Primary Actions ---

  async togglePrimaryAction(type: PrimaryActionType): Promise<void> {
    const remote = this.selectedRemote();
    if (!remote) return;

    const current = remote.primaryActions ?? [];
    const next = current.includes(type) ? current.filter(a => a !== type) : [...current, type];

    try {
      await this.saveRemoteSettings(remote.name, { primaryActions: next });
    } catch (error) {
      this.handleError(this.translate.instant('home.errors.updateActionsFailed'), error);
    }
  }

  // --- Jobs ---

  async startJob(
    operationType: PrimaryActionType,
    remoteName: string,
    profileName?: string
  ): Promise<void> {
    try {
      await this.remoteFacadeService.startJob(remoteName, operationType, profileName, 'dashboard');
    } catch (error) {
      this.handleError('Start job failed', error);
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

  async deleteJob(jobId: number): Promise<void> {
    try {
      await this.remoteFacadeService.deleteJob(jobId);
    } catch (error) {
      console.error('Delete job failed:', error);
    }
  }

  getJobsForRemote(remoteName: string): JobInfo[] {
    return this.jobs().filter(j => j.remote_name === remoteName);
  }

  // --- Remote Operations ---

  async deleteRemote(remoteName: string): Promise<void> {
    if (!remoteName) return;
    try {
      this.notificationService
        .confirmModal(
          this.translate.instant('home.deleteRemote.title'),
          this.translate.instant('home.deleteRemote.message', { name: remoteName }),
          this.translate.instant('common.delete'),
          this.translate.instant('common.cancel'),
          {
            icon: 'trash',
            color: 'warn',
          }
        )
        .then(async confirmed => {
          if (!confirmed) return;
          await this.remoteFacadeService.deleteRemote(remoteName);
          this.remoteFacadeService.loadRemotes();
          if (this.selectedRemote()?.name === remoteName) {
            this.uiStateService.resetSelectedRemote();
          }
        });
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

  async handleRetryDiskUsage(remoteName: string): Promise<void> {
    await this.remoteFacadeService.getCachedOrFetchDiskUsage(
      remoteName,
      undefined,
      'dashboard',
      undefined,
      true
    );
  }

  // --- Settings ---

  getRemoteSettingValue(
    remoteName: string,
    key: keyof RemoteSettings
  ): RemoteSettings[keyof RemoteSettings] {
    return this.remoteFacadeService.getRemoteSettings(remoteName)?.[key];
  }

  async saveRemoteSettings(remoteName: string, settings: Partial<RemoteSettings>): Promise<void> {
    const merged = { ...this.remoteFacadeService.getRemoteSettings(remoteName), ...settings };
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
          color: 'warn',
        }
      );
      if (!confirmed) return;
      await this.appSettingsService.resetRemoteSettings(remoteName);
      await this.remoteFacadeService.loadRemotes();
      this.notificationService.showSuccess(
        this.translate.instant('home.notifications.settingsReset', { name: remoteName })
      );
    } catch (error) {
      this.handleError(this.translate.instant('home.errors.resetSettingsFailed'), error);
    }
  }

  // --- Modals ---

  openQuickAddRemoteModal(): void {
    this.modalService
      .openQuickAddRemote()
      .afterClosed()
      .subscribe(saved => {
        if (saved) {
          void this.remoteFacadeService.refreshAll();
        }
      });
  }

  openRemoteConfigModal(
    editTarget?: string,
    existingConfig?: RemoteSettings,
    initialSection?: string,
    targetProfile?: string,
    remoteType?: string,
    autoAddProfile?: boolean
  ): void {
    this.modalService
      .openRemoteConfig({
        remoteName: this.selectedRemote()?.name,
        remoteType,
        editTarget,
        existingConfig,
        initialSection,
        targetProfile,
        autoAddProfile,
      })
      .afterClosed()
      .subscribe(saved => {
        if (saved) {
          void this.remoteFacadeService.refreshAll();
        }
      });
  }

  openLogsModal(remoteName: string): void {
    this.modalService.openLogs(remoteName);
  }

  async cloneRemote(remoteName: string): Promise<void> {
    const config = await this.remoteFacadeService.cloneRemote(remoteName);
    if (!config) return;
    const remoteConfig = config as RemoteSettings & { name?: string };
    this.modalService
      .openRemoteConfig({
        remoteName: remoteConfig['name'],
        cloneTarget: true,
        existingConfig: remoteConfig,
      })
      .afterClosed()
      .subscribe(saved => {
        if (saved) {
          void this.remoteFacadeService.refreshAll();
        }
      });
  }

  openExportModal(remoteName: string): void {
    this.modalService.openExport({ remoteName, defaultExportType: 'SpecificRemote' });
  }

  openBackendModal(): void {
    this.modalService.openBackend();
  }

  // --- Error Handling ---

  private handleError(message: string, error: unknown): void {
    console.error(`${message}:`, error);
    const detail = error instanceof Error ? error.message : String(error);
    this.notificationService.showError(`${message}: ${detail}`);
  }
}
