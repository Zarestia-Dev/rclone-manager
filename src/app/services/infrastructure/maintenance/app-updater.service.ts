import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { Subject, interval } from 'rxjs';
import { takeUntil, filter, map } from 'rxjs/operators';
import { firstValueFrom } from 'rxjs';
import { UiStateService } from '../../ui/state/ui-state.service';
import { EventListenersService } from '../system/event-listeners.service';
import { ModalService } from '@app/services';
import { UpdateMetadata } from '@app/types';
import { BaseUpdateService } from '../maintenance/base-update.service';

export interface DownloadStatus {
  downloadedBytes: number;
  totalBytes: number;
  percentage: number;
  isComplete: boolean;
  isFailed?: boolean;
  failureMessage?: string | null;
}

@Injectable({ providedIn: 'root' })
export class AppUpdaterService extends BaseUpdateService implements OnDestroy {
  private readonly uiStateService = inject(UiStateService);
  private readonly modalService = inject(ModalService);
  private readonly eventListenersService = inject(EventListenersService);

  private readonly destroy$ = new Subject<void>();
  private readonly stopPolling$ = new Subject<void>();

  // ---------------------------------------------------------------------------
  // State signals
  // ---------------------------------------------------------------------------

  private readonly _buildType = signal<string | null>(null);
  private readonly _hasUpdates = signal<boolean>(false);
  private readonly _updateInProgress = signal<boolean>(false);
  private readonly _updateAvailable = signal<UpdateMetadata | null>(null);
  private readonly _downloadStatus = signal<DownloadStatus>({
    downloadedBytes: 0,
    totalBytes: 0,
    percentage: 0,
    isComplete: false,
  });
  private readonly _restartRequired = signal<boolean>(false);

  // Public readonly surface
  public readonly buildType = this._buildType.asReadonly();
  public readonly hasUpdates = this._hasUpdates.asReadonly();
  public readonly updateInProgress = this._updateInProgress.asReadonly();
  public readonly updateAvailable = this._updateAvailable.asReadonly();
  public readonly downloadStatus = this._downloadStatus.asReadonly();
  public readonly restartRequired = this._restartRequired.asReadonly();

  // ---------------------------------------------------------------------------
  // BaseUpdateService keys
  // ---------------------------------------------------------------------------

  protected override get settingNamespace(): string {
    return 'runtime';
  }
  protected override get skippedVersionsKey(): string {
    return 'app_skipped_updates';
  }
  protected override get updateChannelKey(): string {
    return 'app_update_channel';
  }
  protected override get autoCheckKey(): string {
    return 'app_auto_check_updates';
  }

  private readonly statusPollingInterval = 500;

  constructor() {
    super();
    this.setupEventListeners();
    void this.initialize();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async checkForUpdates(): Promise<UpdateMetadata | null> {
    try {
      this._updateInProgress.set(false);
      this.resetDownloadStatus();

      const result = await this.invokeCommand<UpdateMetadata | null>('fetch_update', {
        channel: this.updateChannel(),
      });

      if (result) {
        if (result.restartRequired) {
          this._restartRequired.set(true);
          return result;
        }

        if (result.updateInProgress) {
          this._updateAvailable.set(result);
          this._updateInProgress.set(true);
          this._hasUpdates.set(true);
          this.startStatusPolling();
          return result;
        }

        if (this.isVersionSkipped(result.version)) {
          return null;
        }

        this._updateAvailable.set(result);
        this._hasUpdates.set(true);
        this.notificationService.showInfo(
          this.translate.instant('updates.availableNotification', { version: result.version }),
          this.translate.instant('common.ok'),
          10000
        );
      } else {
        this._updateAvailable.set(null);
        this._hasUpdates.set(false);
      }

      return result;
    } catch (error) {
      console.error('Failed to check for updates:', error);
      this.notificationService.showError(this.translate.instant('updates.checkFailed'));
      return null;
    }
  }

  async installUpdate(): Promise<void> {
    const update = this._updateAvailable();
    if (!update) {
      this.notificationService.showWarning(this.translate.instant('updates.noUpdateAvailable'));
      return;
    }

    try {
      if (this.uiStateService.platform === 'windows') {
        const confirmed = await firstValueFrom(
          this.modalService
            .openConfirm({
              title: this.translate.instant('updates.confirmInstall.title'),
              message: this.translate.instant('updates.confirmInstall.message'),
              confirmText: this.translate.instant('updates.confirmInstall.confirm'),
              cancelText: this.translate.instant('updates.confirmInstall.cancel'),
            })
            .afterClosed()
        );
        if (!confirmed) return;
      }

      this._updateInProgress.set(true);
      this.resetDownloadStatus();
      this.startStatusPolling();

      await this.invokeWithNotification('install_update', undefined, {
        errorKey: 'updates.installFailed',
        showSuccess: false,
      });
    } catch (error) {
      console.error('Failed to install update:', error);
      this.stopStatusPolling();
      this._updateInProgress.set(false);
      this.resetDownloadStatus();

      if (this.isStaleUpdateError(String(error))) {
        this._updateAvailable.set(null);
        this._hasUpdates.set(false);
        await this.checkForUpdates();
      }
    }
  }

  /** Restarts the app and applies the staged update. */
  async finishUpdate(): Promise<void> {
    try {
      await this.invokeWithNotification('apply_app_update', undefined, {
        errorKey: 'updates.restartFailed',
        showSuccess: false,
      });
    } catch (error) {
      console.error('Failed to apply update and restart:', error);
    }
  }

  override async skipVersion(version: string): Promise<void> {
    await super.skipVersion(version);
    this._updateAvailable.set(null);
    this._hasUpdates.set(false);
    this.notificationService.showInfo(this.translate.instant('updates.skipVersion', { version }));
  }

  override async unskipVersion(version: string): Promise<void> {
    await super.unskipVersion(version);
    await this.checkForUpdates();
  }

  override async setChannel(channel: string): Promise<void> {
    await super.setChannel(channel);
    this._updateAvailable.set(null);
    this._hasUpdates.set(false);
    this.resetDownloadStatus();
    this.notificationService.showInfo(
      this.translate.instant('updates.channelChanged', { channel })
    );
  }

  // ---------------------------------------------------------------------------
  // Status polling
  // ---------------------------------------------------------------------------

  private startStatusPolling(): void {
    this.stopPolling$.next(); // cancel any existing poll

    interval(this.statusPollingInterval)
      .pipe(takeUntil(this.stopPolling$), takeUntil(this.destroy$))
      .subscribe(() => void this.pollDownloadStatus());
  }

  private stopStatusPolling(): void {
    this.stopPolling$.next();
  }

  private async pollDownloadStatus(): Promise<void> {
    try {
      const status = await this.invokeCommand<DownloadStatus>('get_download_status');
      this._downloadStatus.set(status);

      if (status.isFailed) {
        const msg = status.failureMessage ?? this.translate.instant('updates.installFailed');
        this.notificationService.showError(msg);
        this.stopStatusPolling();
        this._updateInProgress.set(false);
        this.resetDownloadStatus();

        if (this.isStaleUpdateError(msg)) {
          this._updateAvailable.set(null);
          this._hasUpdates.set(false);
          await this.checkForUpdates();
        }
        return;
      }

      if (status.isComplete) {
        this.stopStatusPolling();
        this._updateInProgress.set(false);
        this._updateAvailable.set(null);
        this._hasUpdates.set(false);
        this._restartRequired.set(true);
        this.notificationService.showSuccess(this.translate.instant('updates.installSuccess'));
      }
    } catch (error) {
      console.error('Error polling download status:', error);
      this.stopStatusPolling();
      this._updateInProgress.set(false);
      this.resetDownloadStatus();
    }
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  private async initialize(): Promise<void> {
    try {
      await this.initBaseSettings();
      this._buildType.set(await this.invokeCommand<string>('get_build_type'));

      if (!this.autoCheckEnabled()) return;

      // Silent background check — no notifications during init.
      const cached = await this.invokeCommand<UpdateMetadata | null>('fetch_update', {
        channel: this.updateChannel(),
      });

      if (!cached || this.isVersionSkipped(cached.version)) return;

      if (cached.restartRequired) {
        this._restartRequired.set(true);
        return;
      }

      this._updateAvailable.set(cached);
      this._hasUpdates.set(true);

      if (cached.updateInProgress) {
        this._updateInProgress.set(true);
        this.startStatusPolling();
      }
    } catch (error) {
      console.error('Failed to initialize updater service:', error);
    }
  }

  // ---------------------------------------------------------------------------
  // Event listeners
  // ---------------------------------------------------------------------------

  private setupEventListeners(): void {
    this.eventListenersService
      .listenToAppEvents()
      .pipe(
        takeUntil(this.destroy$),
        filter(event => event.status === 'update_found' && !!event.data),
        map(event => event.data as UpdateMetadata)
      )
      .subscribe(metadata => {
        const current = this._updateAvailable();
        if (current?.version === metadata.version) return;
        if (this.isVersionSkipped(metadata.version)) return;

        this._updateAvailable.set(metadata);
        this._hasUpdates.set(true);
        this.notificationService.showInfo(
          this.translate.instant('updates.availableNotification', { version: metadata.version }),
          this.translate.instant('common.ok'),
          10000
        );
      });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private resetDownloadStatus(): void {
    this._downloadStatus.set({
      downloadedBytes: 0,
      totalBytes: 0,
      percentage: 0,
      isComplete: false,
      isFailed: false,
      failureMessage: null,
    });
  }

  /** True when the error message indicates the staged update is no longer valid. */
  private isStaleUpdateError(message: string): boolean {
    const msg = message.toLowerCase();
    return (
      msg.includes('no pending update') ||
      msg.includes('update unavailable') ||
      msg.includes('no longer available')
    );
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.stopPolling$.next();
    this.stopPolling$.complete();
  }
}
