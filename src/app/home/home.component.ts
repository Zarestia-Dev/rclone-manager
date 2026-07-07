import {
  Component,
  afterNextRender,
  inject,
  signal,
  computed,
  DestroyRef,
  linkedSignal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

import {
  OperationTab,
  PrimaryActionType,
  Remote,
  RemoteSettings,
  SyncOperationType,
  SYNC_TYPES,
} from '@app/types';

import { RemoteFacadeService } from '../services/facade/remote-facade.service';
import { SidebarComponent } from '../layout/sidebar/sidebar.component';
import { GeneralDetailComponent } from '../features/components/dashboard/general-detail/general-detail.component';
import { GeneralOverviewComponent } from '../features/components/dashboard/general-overview/general-overview.component';
import { AppDetailComponent } from '../features/components/dashboard/app-detail/app-detail.component';
import { AppOverviewComponent } from '../features/components/dashboard/app-overview/app-overview.component';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { RcloneStatusService } from 'src/app/services/infrastructure/maintenance/rclone-status.service';
import { LocalStorageService } from 'src/app/services/ui/state/local-storage.service';

@Component({
  selector: 'app-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
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
    TranslatePipe,
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
  readonly remotes = this.remoteFacadeService.orderedRemotes;
  readonly jobs = this.remoteFacadeService.jobs;
  readonly runningServes = this.remoteFacadeService.runningServes;

  readonly backendStatusClass = computed(() =>
    this.rcloneStatusService.rcloneStatus() === 'active' ? 'connected' : 'disconnected'
  );

  readonly selectedRemote = this.remoteFacadeService.selectedRemote;

  readonly selectedRemoteSettings = computed(() => {
    const remote = this.selectedRemote();
    return remote ? this.remoteFacadeService.getRemoteSettings(remote.name) : {};
  });

  readonly mainOperationType = computed<OperationTab>(() => {
    const tab = this.currentTab();
    return tab === 'general' ? 'mount' : tab;
  });

  private readonly localStorage = inject(LocalStorageService);
  readonly isSidebarOpen = signal(this.localStorage.get('ui.sidebarOpen', false));
  readonly sidebarMode = signal<MatDrawerMode>('side');
  readonly selectedSyncOperation = linkedSignal<SyncOperationType>(() => {
    const remote = this.selectedRemote();
    if (!remote) return 'sync';
    const val = this.localStorage.getScoped<SyncOperationType>(
      `remote.${remote.name}`,
      'selectedSyncOperation',
      'sync'
    );
    return SYNC_TYPES.includes(val) ? val : 'sync';
  });

  readonly isLoading = this.remoteFacadeService.loading;

  constructor() {
    afterNextRender(() => this.setupResponsiveLayout());
    this.destroyRef.onDestroy(() => this.uiStateService.resetSelectedRemote());
  }

  // --- Layout ---

  setSidebarOpen(open: boolean): void {
    this.isSidebarOpen.set(open);
    this.localStorage.set('ui.sidebarOpen', open);
  }

  private setupResponsiveLayout(): void {
    const mql = window.matchMedia('(min-width: 900px)');
    const update = (matches: boolean): void => this.sidebarMode.set(matches ? 'side' : 'over');
    const handler = (e: MediaQueryListEvent): void => update(e.matches);

    update(mql.matches);
    mql.addEventListener('change', handler);
    this.destroyRef.onDestroy(() => mql.removeEventListener('change', handler));
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
      this.localStorage.setScoped(`remote.${remote.name}`, 'selectedSyncOperation', operation);
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

  // --- Remote Operations ---

  async deleteRemote(remoteName: string): Promise<void> {
    if (!remoteName) return;

    const confirmed = await this.notificationService.confirmModal(
      this.translate.instant('home.deleteRemote.title'),
      this.translate.instant('home.deleteRemote.message', { name: remoteName }),
      this.translate.instant('common.delete'),
      this.translate.instant('common.cancel'),
      { icon: 'trash', color: 'warn' }
    );
    if (!confirmed) return;

    try {
      await this.remoteFacadeService.deleteRemote(remoteName);
      if (this.selectedRemote()?.name === remoteName) {
        this.uiStateService.resetSelectedRemote();
      }
    } catch (error) {
      this.handleError(this.translate.instant('home.errors.deleteRemoteFailed'), error);
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
    await this.remoteFacadeService.updateRemoteSettings(remoteName, settings);
  }

  async resetRemoteSettings(remoteName: string): Promise<void> {
    if (!remoteName) return;

    const confirmed = await this.notificationService.confirmModal(
      this.translate.instant('home.resetRemote.title'),
      this.translate.instant('home.resetRemote.message', { name: remoteName }),
      'common.yes',
      'common.no',
      { icon: 'rotate-right', color: 'warn' }
    );
    if (!confirmed) return;

    try {
      await this.appSettingsService.resetRemoteSettings(remoteName);
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
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((saved: boolean) => {
        if (saved) void this.remoteFacadeService.refreshAll();
      });
  }

  openRemoteConfigModal(
    editTarget?: string,
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
        initialSection,
        targetProfile,
        autoAddProfile,
      })
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((saved: boolean) => {
        if (saved) void this.remoteFacadeService.refreshAll();
      });
  }

  openLogsModal(remoteName: string): void {
    this.modalService.openLogs(remoteName);
  }

  async cloneRemote(remoteName: string): Promise<void> {
    const remote = this.remoteFacadeService.activeRemotes().find(r => r.name === remoteName);
    if (!remote) return;
    this.modalService
      .openRemoteConfig({
        cloneFrom: remoteName,
        remoteType: remote.type,
      })
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((saved: boolean) => {
        if (saved) void this.remoteFacadeService.refreshAll();
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
