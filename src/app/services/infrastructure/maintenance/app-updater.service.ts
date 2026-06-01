import { Injectable, inject, signal, computed } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { UiStateService } from '../../ui/state/ui-state.service';
import { EventListenersService } from '../system/event-listeners.service';
import { UpdateInfo, DownloadStatus, BackendUpdateStatus, DownloadStateStatus } from '@app/types';
import { AppSettingsService } from '../../settings/app-settings.service';
import { TauriBaseService } from '../platform/tauri-base.service';
import { UpdateSettingsManager } from './update-settings-manager';

const DEFAULT_DOWNLOAD_STATUS: DownloadStatus = {
  downloadedBytes: 0,
  totalBytes: 0,
  percentage: 0,
  state: {
    status: DownloadStateStatus.InProgress,
  },
};

@Injectable({ providedIn: 'root' })
export class AppUpdaterService extends TauriBaseService {
  private readonly uiStateService = inject(UiStateService);
  private readonly eventListenersService = inject(EventListenersService);
  private readonly appSettingsService = inject(AppSettingsService);

  private readonly settings = new UpdateSettingsManager(this.appSettingsService, {
    namespace: 'runtime',
    skippedVersionsKey: 'app_skipped_updates',
    updateChannelKey: 'app_update_channel',
    autoCheckKey: 'app_auto_check_updates',
  });

  private _latestCheckId = 0;

  // ---------------------------------------------------------------------------
  // State signals
  // ---------------------------------------------------------------------------

  private readonly _buildType = signal<string | null>(null);
  private readonly _updateState = signal<UpdateInfo | null>(null);
  private readonly _downloadStatus = signal<DownloadStatus>(DEFAULT_DOWNLOAD_STATUS);
  private readonly _isChecking = signal<boolean>(false);

  // Public readonly surface (Derived to prevent state tears)
  public readonly buildType = this._buildType.asReadonly();
  public readonly isChecking = this._isChecking.asReadonly();
  public readonly downloadStatus = this._downloadStatus.asReadonly();

  public readonly updateAvailable = computed(() => {
    const update = this._updateState();
    return update && !this.settings.isVersionSkipped(update.version) ? update : null;
  });

  public readonly hasUpdates = computed(() => !!this.updateAvailable());
  public readonly updateInProgress = computed(
    () => this._updateState()?.status === BackendUpdateStatus.Downloading
  );
  public readonly readyToRestart = computed(
    () => this._updateState()?.status === BackendUpdateStatus.ReadyToRestart
  );

  // Settings surface
  public readonly skippedVersions = this.settings.skippedVersions;
  public readonly updateChannel = this.settings.updateChannel;
  public readonly autoCheckEnabled = this.settings.autoCheckEnabled;

  constructor() {
    super();
    this.setupEventListeners();
    void this.initialize();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async checkForUpdates(): Promise<UpdateInfo | null> {
    const checkId = ++this._latestCheckId;

    try {
      // If we're already updating, just sync and return current state.
      if (this.updateInProgress() || this.readyToRestart()) {
        this._isChecking.set(true);
        const result = this._updateState() ?? (await this.syncUpdateStatus());

        // Even in the "already updating" branch, we should check for staleness.
        if (checkId !== this._latestCheckId) return null;

        return result;
      }

      this._isChecking.set(true);
      this._downloadStatus.set(DEFAULT_DOWNLOAD_STATUS);

      const result = await this.invokeCommand<UpdateInfo | null>('fetch_update', {
        channel: this.settings.updateChannel(),
      });

      // Discard stale results
      if (checkId !== this._latestCheckId) {
        return null;
      }

      this.processUpdateResult(result, { silent: false });
      return result;
    } catch (error) {
      if (checkId !== this._latestCheckId) return null;

      console.error('Failed to check for updates:', error);
      this.notificationService.showError(this.translate.instant('updates.checkFailed'));
      return null;
    } finally {
      if (checkId === this._latestCheckId) {
        this._isChecking.set(false);
      }
    }
  }

  private processUpdateResult(result: UpdateInfo | null, options: { silent: boolean }): void {
    this._updateState.set(result);

    if (
      result &&
      !options.silent &&
      result.status !== BackendUpdateStatus.Downloading &&
      result.status !== BackendUpdateStatus.ReadyToRestart &&
      !this.settings.isVersionSkipped(result.version)
    ) {
      this.notificationService.showInfo(
        this.translate.instant('updates.availableNotification', { version: result.version }),
        this.translate.instant('common.ok'),
        10000
      );
    }
  }

  async installUpdate(): Promise<void> {
    const update = this.updateAvailable();
    if (!update) {
      this.notificationService.showWarning(this.translate.instant('updates.noUpdateAvailable'));
      return;
    }

    try {
      if (this.uiStateService.platform === 'windows') {
        const confirmed = await this.notificationService.confirmModal(
          'updates.confirmInstall.title',
          'updates.confirmInstall.message',
          'updates.confirmInstall.confirm',
          'updates.confirmInstall.cancel'
        );
        if (!confirmed) return;
      }

      this._updateState.update(u => (u ? { ...u, status: BackendUpdateStatus.Downloading } : null));
      this._downloadStatus.set(DEFAULT_DOWNLOAD_STATUS);

      await this.invokeWithNotification('install_update', undefined, {
        errorKey: 'updates.installFailed',
        showSuccess: false,
      });
    } catch (error) {
      console.error('Failed to install update:', error);
      this._downloadStatus.set(DEFAULT_DOWNLOAD_STATUS);

      if (this.isStaleUpdateError(String(error))) {
        this._updateState.set(null);
        await this.checkForUpdates();
      } else {
        this._updateState.update(u => (u ? { ...u, status: BackendUpdateStatus.Available } : null));
      }
    }
  }

  async cancelUpdate(): Promise<void> {
    if (!this.updateInProgress()) return;

    try {
      await this.invokeCommand('cancel_app_update');
      this._downloadStatus.set(DEFAULT_DOWNLOAD_STATUS);

      this._updateState.update(u => (u ? { ...u, status: BackendUpdateStatus.Available } : null));

      // Optionally sync status to ensure we match backend exactly
      await this.syncUpdateStatus();
    } catch (error) {
      console.error('Failed to cancel app update:', error);
      this.notificationService.showError(this.translate.instant('updates.cancelFailed'));
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

  async skipVersion(version: string): Promise<void> {
    await this.settings.skipVersion(version);
    this.notificationService.showInfo(this.translate.instant('updates.skipVersion', { version }));
  }

  async unskipVersion(version: string): Promise<void> {
    await this.settings.unskipVersion(version);
    await this.checkForUpdates();
  }

  async setChannel(channel: string): Promise<void> {
    await this.settings.setChannel(channel);
    this._updateState.set(null);
    this._downloadStatus.set(DEFAULT_DOWNLOAD_STATUS);
    this.notificationService.showInfo(
      this.translate.instant('updates.channelChanged', { channel })
    );
    void this.checkForUpdates();
  }

  async setAutoCheckEnabled(enabled: boolean): Promise<void> {
    await this.settings.setAutoCheckEnabled(enabled);
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
      await this.settings.initialize();
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
      .listenToAppUpdateFound()
      .pipe(takeUntilDestroyed())
      .subscribe(metadata => {
        const current = this._updateState();
        if (current?.version === metadata.version) return;

        this._updateState.set(metadata);

        if (this.settings.isVersionSkipped(metadata.version)) return;

        this.notificationService.showInfo(
          this.translate.instant('updates.availableNotification', { version: metadata.version }),
          this.translate.instant('common.ok'),
          10000
        );
      });

    this.eventListenersService
      .listenToAppDownloadProgress()
      .pipe(takeUntilDestroyed())
      .subscribe(status => {
        this._downloadStatus.set(status);

        if (status.state.status === DownloadStateStatus.Failed) {
          const msg = status.state.data ?? this.translate.instant('updates.installFailed');
          this.notificationService.showError(msg);
          this._downloadStatus.set(DEFAULT_DOWNLOAD_STATUS);

          if (this.isStaleUpdateError(msg)) {
            this._updateState.set(null);
            void this.checkForUpdates();
          } else {
            this._updateState.update(u =>
              u ? { ...u, status: BackendUpdateStatus.Available } : null
            );
          }
          return;
        }

        if (status.state.status === DownloadStateStatus.Complete) {
          this._updateState.update(u =>
            u ? { ...u, status: BackendUpdateStatus.ReadyToRestart } : null
          );

          this.notificationService.showSuccess(this.translate.instant('updates.installSuccess'));
        }
      });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** True when the error message indicates the staged update is no longer valid. */
  private isStaleUpdateError(message: string): boolean {
    const msg = message.toLowerCase();
    return (
      msg.includes('no pending update') ||
      msg.includes('update unavailable') ||
      msg.includes('no longer available')
    );
  }
}
