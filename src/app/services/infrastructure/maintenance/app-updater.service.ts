import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil, filter, map } from 'rxjs/operators';
import { firstValueFrom } from 'rxjs';
import { UiStateService } from '../../ui/state/ui-state.service';
import { EventListenersService } from '../system/event-listeners.service';
import { ModalService } from '@app/services';
import { UpdateInfo, DownloadStatus, BackendUpdateStatus } from '@app/types';
import { BaseUpdateService } from '../maintenance/base-update.service';

@Injectable({ providedIn: 'root' })
export class AppUpdaterService extends BaseUpdateService implements OnDestroy {
  private readonly uiStateService = inject(UiStateService);
  private readonly modalService = inject(ModalService);
  private readonly eventListenersService = inject(EventListenersService);

  private readonly destroy$ = new Subject<void>();

  // ---------------------------------------------------------------------------
  // State signals
  // ---------------------------------------------------------------------------

  private readonly _buildType = signal<string | null>(null);
  private readonly _hasUpdates = signal<boolean>(false);
  private readonly _updateInProgress = signal<boolean>(false);
  private readonly _updateAvailable = signal<UpdateInfo | null>(null);
  private readonly _downloadStatus = signal<DownloadStatus>({
    downloadedBytes: 0,
    totalBytes: 0,
    percentage: 0,
    isComplete: false,
    isFailed: false,
    failureMessage: null,
  });
  private readonly _readyToRestart = signal<boolean>(false);
  private readonly _isChecking = signal<boolean>(false);

  // Public readonly surface
  public readonly buildType = this._buildType.asReadonly();
  public readonly hasUpdates = this._hasUpdates.asReadonly();
  public readonly updateInProgress = this._updateInProgress.asReadonly();
  public readonly updateAvailable = this._updateAvailable.asReadonly();
  public readonly downloadStatus = this._downloadStatus.asReadonly();
  public readonly readyToRestart = this._readyToRestart.asReadonly();
  public readonly isChecking = this._isChecking.asReadonly();

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

  constructor() {
    super();
    this.setupEventListeners();
    void this.initialize();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async checkForUpdates(): Promise<UpdateInfo | null> {
    try {
      // If we're already updating, just sync and return current state.
      if (this._updateInProgress() || this._readyToRestart()) {
        this._isChecking.set(true);
        return this._updateAvailable() ?? (await this.syncUpdateStatus());
      }

      this._isChecking.set(true);
      this._updateInProgress.set(false);
      this.resetDownloadStatus();

      const result = await this.invokeCommand<UpdateInfo | null>('fetch_update', {
        channel: this.updateChannel(),
      });

      this.processUpdateResult(result, { silent: false });
      return result;
    } catch (error) {
      console.error('Failed to check for updates:', error);
      this.notificationService.showError(this.translate.instant('updates.checkFailed'));
      return null;
    } finally {
      this._isChecking.set(false);
    }
  }

  private processUpdateResult(result: UpdateInfo | null, options: { silent: boolean }): void {
    if (result) {
      if (result.status === BackendUpdateStatus.ReadyToRestart) {
        this._readyToRestart.set(true);
        this._updateAvailable.set(result);
        return;
      }

      if (result.status === BackendUpdateStatus.Downloading) {
        this._updateAvailable.set(result);
        this._updateInProgress.set(true);
        this._hasUpdates.set(true);
        return;
      }

      if (this.isVersionSkipped(result.version)) {
        this._updateAvailable.set(null);
        this._hasUpdates.set(false);
        return;
      }

      this._updateAvailable.set(result);
      this._hasUpdates.set(true);

      if (!options.silent) {
        this.notificationService.showInfo(
          this.translate.instant('updates.availableNotification', { version: result.version }),
          this.translate.instant('common.ok'),
          10000
        );
      }
    } else {
      this._updateAvailable.set(null);
      this._hasUpdates.set(false);
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

      await this.invokeWithNotification('install_update', undefined, {
        errorKey: 'updates.installFailed',
        showSuccess: false,
      });
    } catch (error) {
      console.error('Failed to install update:', error);
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
    this._readyToRestart.set(false);
    this.resetDownloadStatus();
    this.notificationService.showInfo(
      this.translate.instant('updates.channelChanged', { channel })
    );
    void this.checkForUpdates();
  }

  // ---------------------------------------------------------------------------
  // Initialization & Sync
  // ---------------------------------------------------------------------------

  private async syncUpdateStatus(): Promise<UpdateInfo | null> {
    try {
      const info = await this.invokeCommand<UpdateInfo | null>('get_app_update_info');
      this.processUpdateResult(info, { silent: true });
      return info;
    } catch (error) {
      console.error('Failed to sync app update status:', error);
      return null;
    }
  }

  private async initialize(): Promise<void> {
    try {
      await this.initBaseSettings();
      this._buildType.set(await this.invokeCommand<string>('get_build_type'));

      // Sync status from backend on init (even if autoCheck is disabled) to pick
      // up any updates found by the backend startup check. Always silent here.
      await this.syncUpdateStatus();
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
        map(event => event.data as UpdateInfo)
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

    this.eventListenersService
      .listenToAppEvents()
      .pipe(
        takeUntil(this.destroy$),
        filter(event => event.status === 'download_progress' && !!event.data),
        map(event => event.data as DownloadStatus)
      )
      .subscribe(status => {
        this._downloadStatus.set(status);

        if (status.isFailed) {
          const msg = status.failureMessage ?? this.translate.instant('updates.installFailed');
          this.notificationService.showError(msg);
          this._updateInProgress.set(false);
          this.resetDownloadStatus();

          if (this.isStaleUpdateError(msg)) {
            this._updateAvailable.set(null);
            this._hasUpdates.set(false);
            void this.checkForUpdates();
          }
          return;
        }

        if (status.isComplete) {
          this._updateInProgress.set(false);
          this._updateAvailable.set(null);
          this._hasUpdates.set(false);
          this._readyToRestart.set(true);
          this.notificationService.showSuccess(this.translate.instant('updates.installSuccess'));
        }
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
  }
}
