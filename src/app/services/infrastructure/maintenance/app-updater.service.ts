import { Injectable, inject, signal, computed } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
  private readonly eventListenersService = inject(EventListenersService);
  private readonly appSettingsService = inject(AppSettingsService);

  private readonly settings = new UpdateSettingsManager(this.appSettingsService, {
    namespace: 'runtime',
    skippedVersionsKey: 'app_skipped_updates',
    updateChannelKey: 'app_update_channel',
    autoCheckKey: 'app_auto_check_updates',
  });

  private _latestCheckId = 0;

  public readonly isUpdaterEnabled = signal<boolean>(true).asReadonly();
  private readonly _isCancelling = signal<boolean>(false);
  private readonly _buildType = signal<string | null>(null);
  private readonly _updateState = signal<UpdateInfo | null>(null);
  private readonly _canAutoInstall = signal<boolean>(true);
  private readonly _downloadStatus = signal<DownloadStatus>(DEFAULT_DOWNLOAD_STATUS);
  private readonly _isChecking = signal<boolean>(false);

  public readonly isCancelling = this._isCancelling.asReadonly();
  public readonly canAutoInstall = this._canAutoInstall.asReadonly();
  public readonly buildType = this._buildType.asReadonly();
  public readonly isChecking = this._isChecking.asReadonly();
  public readonly downloadStatus = this._downloadStatus.asReadonly();

  public readonly updateAvailable = computed(() => {
    const update = this._updateState();
    return update &&
      (update.status === BackendUpdateStatus.Downloading ||
        update.status === BackendUpdateStatus.ReadyToRestart ||
        !this.settings.isVersionSkipped(update.version))
      ? update
      : null;
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
  }

  async checkForUpdates(): Promise<UpdateInfo | null> {
    if (this.isChecking()) return this._updateState();
    if (this.updateInProgress() || this.readyToRestart()) return this.syncUpdateStatus();
    const checkId = ++this._latestCheckId;

    try {
      this._isChecking.set(true);
      this._downloadStatus.set(DEFAULT_DOWNLOAD_STATUS);

      const result = await this.invokeCommand<UpdateInfo | null>('fetch_update', {
        channel: this.settings.updateChannel(),
      });

      if (checkId !== this._latestCheckId) {
        return null;
      }

      this.processUpdateResult(result, { silent: false });
      return result;
    } catch (error) {
      if (checkId !== this._latestCheckId) return null;

      console.error('Failed to check for updates:', error);
      const translatedError = this.backendTranslation.translateBackendMessage(error);
      this.notificationService.showError(
        this.translate.instant('updates.checkFailed', {
          error: translatedError || this.translate.instant('common.error'),
        })
      );
      return null;
    } finally {
      if (checkId === this._latestCheckId) {
        this._isChecking.set(false);
      }
    }
  }

  private processUpdateResult(result: UpdateInfo | null, options: { silent: boolean }): void {
    if (
      !result ||
      (!result.updateAvailable &&
        result.status !== BackendUpdateStatus.Downloading &&
        result.status !== BackendUpdateStatus.ReadyToRestart)
    ) {
      this._updateState.set(null);
    } else {
      this._updateState.set(result);
    }
    this._downloadStatus.set(result?.download ?? DEFAULT_DOWNLOAD_STATUS);

    if (
      result &&
      result.updateAvailable &&
      !options.silent &&
      result.status !== BackendUpdateStatus.Downloading &&
      result.status !== BackendUpdateStatus.ReadyToRestart &&
      !this.settings.isVersionSkipped(result.version)
    ) {
      this.notificationService.showInfo(
        this.translate.instant('updates.availableNotification', { version: result.version }),
        this.translate.instant('common.ok')
      );
    }
  }

  async installUpdate(): Promise<void> {
    if (this.updateInProgress() || this.readyToRestart() || this.isChecking()) return;
    const update = this.updateAvailable();
    if (!update) {
      this.notificationService.showWarning(this.translate.instant('updates.noUpdateAvailable'));
      return;
    }

    try {
      ++this._latestCheckId;
      this._updateState.update(u => (u ? { ...u, status: BackendUpdateStatus.Downloading } : null));
      this._downloadStatus.set(DEFAULT_DOWNLOAD_STATUS);

      await this.invokeWithNotification('install_update', undefined, {
        errorKey: 'updates.installFailed',
      });
    } catch (error) {
      console.error('Failed to install update:', error);
    } finally {
      await this.syncUpdateStatus();
    }
  }

  async cancelUpdate(): Promise<void> {
    if (!this.updateInProgress() || this._isCancelling()) return;
    this._isCancelling.set(true);
    try {
      await this.invokeWithNotification('cancel_app_update', undefined, {
        errorKey: 'updates.cancelFailed',
      });
    } catch (error) {
      console.error('Failed to cancel app update:', error);
    } finally {
      this._isCancelling.set(false);
      await this.syncUpdateStatus();
    }
  }

  /** Restarts the app and applies the staged update. */
  async finishUpdate(): Promise<void> {
    try {
      const confirmed = await this.notificationService.confirmModal(
        'updates.confirmApply.title',
        'updates.confirmApply.message',
        'updates.confirmApply.confirm',
        'updates.confirmApply.cancel'
      );
      if (!confirmed) return;

      await this.invokeWithNotification('apply_app_update', undefined, {
        errorKey: 'updates.restartFailed',
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
    if (this.updateInProgress() || this.readyToRestart() || this.isChecking()) return;
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

  private async syncUpdateStatus(): Promise<UpdateInfo | null> {
    const request = ++this._latestCheckId;
    try {
      const info = await this.invokeCommand<UpdateInfo | null>('get_app_update_info');
      if (request !== this._latestCheckId) return this._updateState();
      this.processUpdateResult(info, { silent: true });
      return info;
    } catch (error) {
      console.error('Failed to sync app update status:', error);
      return this._updateState();
    } finally {
      if (request === this._latestCheckId) this._isChecking.set(false);
    }
  }

  async initialize(): Promise<void> {
    try {
      await this.syncUpdateStatus();
      await this.settings.initialize();
      this._buildType.set(await this.invokeCommand<string | null>('get_build_type'));

      try {
        const canAuto = await this.invokeCommand<boolean>('can_auto_install');
        this._canAutoInstall.set(canAuto);
      } catch {
        this._canAutoInstall.set(false);
      }
    } catch (error) {
      console.error('Failed to initialize updater service:', error);
    }
  }

  private setupEventListeners(): void {
    this.eventListenersService
      .listenToUpdaterStateChanged()
      .pipe(takeUntilDestroyed())
      .subscribe(event => {
        if (event.target === 'app') void this.syncUpdateStatus();
      });
    this.eventListenersService
      .listenToRcloneEngineReady()
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.syncUpdateStatus());
    this.eventListenersService
      .listenToAppUpdateFound()
      .pipe(takeUntilDestroyed())
      .subscribe(metadata => {
        const current = this._updateState();
        if (current?.version === metadata.version) return;

        ++this._latestCheckId;
        this._isChecking.set(false);
        this.processUpdateResult(metadata, { silent: false });
      });

    this.eventListenersService
      .listenToAppDownloadProgress()
      .pipe(takeUntilDestroyed())
      .subscribe(status => {
        if (!this.isUpdaterEnabled()) return;
        this._downloadStatus.set(status);

        if (status.state.status === DownloadStateStatus.InProgress) {
          this._updateState.update(update =>
            update ? { ...update, status: BackendUpdateStatus.Downloading } : null
          );
        } else {
          if (status.state.status === DownloadStateStatus.Failed) {
            this.notificationService.showError(
              this.backendTranslation.translateBackendMessage(status.state.data) ||
                this.translate.instant('updates.installFailed')
            );
          } else {
            this.notificationService.showSuccess(this.translate.instant('updates.installSuccess'));
          }
          void this.syncUpdateStatus();
        }
      });
  }
}
