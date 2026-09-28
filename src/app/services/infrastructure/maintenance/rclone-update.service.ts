import { Injectable, inject, signal, computed } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EventListenersService } from '../system/event-listeners.service';
import { UpdateInfo, UpdateResult, BackendUpdateStatus } from '@app/types';
import { AppSettingsService } from '../../settings/app-settings.service';
import { TauriBaseService } from '../platform/tauri-base.service';
import { UpdateSettingsManager } from './update-settings-manager';

@Injectable({ providedIn: 'root' })
export class RcloneUpdateService extends TauriBaseService {
  private readonly eventListenersService = inject(EventListenersService);
  private readonly appSettingsService = inject(AppSettingsService);

  private readonly settings = new UpdateSettingsManager(this.appSettingsService, {
    namespace: 'runtime',
    skippedVersionsKey: 'rclone_skipped_updates',
    updateChannelKey: 'rclone_update_channel',
    autoCheckKey: 'rclone_auto_check_updates',
  });

  private _latestCheckId = 0;

  private readonly _isUpdaterEnabled = signal<boolean>(true);
  private readonly _isChecking = signal<boolean>(false);
  private readonly _isCancelling = signal<boolean>(false);
  private readonly _updateState = signal<UpdateInfo | null>(null);
  private readonly _error = signal<string | null>(null);
  private readonly _lastCheck = signal<Date | null>(null);

  public readonly isUpdaterEnabled = this._isUpdaterEnabled.asReadonly();
  public readonly isChecking = this._isChecking.asReadonly();
  public readonly isCancelling = this._isCancelling.asReadonly();
  public readonly error = this._error.asReadonly();
  public readonly lastCheck = this._lastCheck.asReadonly();

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
  public readonly downloading = computed(
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
    if (this.downloading() || this.readyToRestart()) return this.restoreUpdateState();
    const checkId = ++this._latestCheckId;

    this._isChecking.set(true);
    this._error.set(null);

    try {
      const info = await this.invokeCommand<UpdateInfo>('check_rclone_update', {
        channel: this.settings.updateChannel(),
      });

      if (checkId !== this._latestCheckId) {
        return null;
      }

      this.processUpdateResult(info);
      return info;
    } catch (error) {
      if (checkId !== this._latestCheckId) return null;

      console.error('Failed to check for rclone updates:', error);
      this._isChecking.set(false);
      this._error.set(String(error));
      this._lastCheck.set(new Date());
      return null;
    } finally {
      if (checkId === this._latestCheckId) {
        this._isChecking.set(false);
      }
    }
  }

  async performUpdate(): Promise<boolean> {
    if (this.downloading() || this.readyToRestart() || this.isChecking()) return false;
    ++this._latestCheckId;
    this._updateState.update(u => (u ? { ...u, status: BackendUpdateStatus.Downloading } : null));
    this._error.set(null);

    try {
      const result = await this.invokeWithNotification<UpdateResult>(
        'update_rclone',
        { channel: this.settings.updateChannel() },
        { errorKey: 'rcloneUpdate.failed' }
      );

      if (result.success) {
        if (result.manual) {
          this.notificationService.showWarning(
            this.translate.instant('rcloneUpdate.manualRestartRequired')
          );
        }
        return true;
      }

      this._error.set(result.message ?? null);
      return false;
    } catch (error) {
      console.error('Failed to update rclone:', error);
      this._error.set(String(error));
      return false;
    } finally {
      await this.restoreUpdateState();
    }
  }

  async cancelUpdate(): Promise<void> {
    if (!this.downloading() || this._isCancelling()) return;

    this._isCancelling.set(true);
    try {
      await this.invokeWithNotification('cancel_rclone_update', undefined, {
        successKey: 'rcloneUpdate.cancelled',
        errorKey: 'rcloneUpdate.cancelFailed',
      });
      this._error.set(null);
    } catch (error) {
      console.error('Failed to cancel rclone update:', error);
    } finally {
      this._isCancelling.set(false);
      await this.restoreUpdateState();
    }
  }

  async applyUpdate(): Promise<boolean> {
    try {
      await this.invokeWithNotification<void>('apply_rclone_update', undefined, {
        errorKey: 'rcloneUpdate.failed',
      });

      return true;
    } catch (error) {
      console.error('Failed to apply rclone update:', error);
      return false;
    } finally {
      await this.restoreUpdateState();
    }
  }

  async setChannel(channel: string): Promise<void> {
    if (this.downloading() || this.readyToRestart() || this.isChecking()) return;
    await this.settings.setChannel(channel);
    this._updateState.set(null);
    this._error.set(null);
    this._lastCheck.set(null);

    this.notificationService.showInfo(
      this.translate.instant('rcloneUpdate.channelChanged', { channel })
    );
    void this.checkForUpdates();
  }

  async skipVersion(version: string): Promise<void> {
    await this.settings.skipVersion(version);
    this.notificationService.showInfo(this.translate.instant('rcloneUpdate.skipped', { version }));
  }

  async unskipVersion(version: string): Promise<void> {
    await this.settings.unskipVersion(version);
    this.notificationService.showInfo(this.translate.instant('rcloneUpdate.restored', { version }));
    void this.checkForUpdates();
  }

  async setAutoCheckEnabled(enabled: boolean): Promise<void> {
    await this.settings.setAutoCheckEnabled(enabled);
    this.notificationService.showInfo(
      this.translate.instant(
        enabled ? 'rcloneUpdate.autoCheckEnabled' : 'rcloneUpdate.autoCheckDisabled'
      )
    );
  }

  async initialize(): Promise<void> {
    try {
      const isLibrclone = await this.invokeCommand<boolean>('is_librclone');
      this._isUpdaterEnabled.set(!isLibrclone);
      if (isLibrclone) {
        return;
      }
      await this.settings.initialize();
      await this.restoreUpdateState();
    } catch (error) {
      console.error('Failed to initialize rclone updater service:', error);
    }
  }

  private setupEventListeners(): void {
    this.eventListenersService
      .listenToUpdaterStateChanged()
      .pipe(takeUntilDestroyed())
      .subscribe(event => {
        if (event.target === 'rclone' && this.isUpdaterEnabled()) void this.restoreUpdateState();
      });
    this.eventListenersService
      .listenToRcloneEngineReady()
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        if (this.isUpdaterEnabled()) void this.restoreUpdateState();
      });
    this.eventListenersService
      .listenToEngineRestarted('rclone_update')
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.restoreUpdateState());
    this.eventListenersService
      .listenToRcloneUpdateFound()
      .pipe(takeUntilDestroyed())
      .subscribe(info => {
        if (!this.isUpdaterEnabled()) return;
        ++this._latestCheckId;
        this.processUpdateResult(info);
      });
  }

  private async restoreUpdateState(): Promise<UpdateInfo | null> {
    const request = ++this._latestCheckId;
    try {
      const info = await this.invokeCommand<UpdateInfo | null>('get_rclone_update_info');
      if (request !== this._latestCheckId) return this._updateState();
      this.processUpdateResult(info);
      return info;
    } catch (error) {
      console.error('Failed to restore rclone update state:', error);
      return this._updateState();
    } finally {
      if (request === this._latestCheckId) this._isChecking.set(false);
    }
  }

  private processUpdateResult(info: UpdateInfo | null): void {
    if (
      !info ||
      (!info.updateAvailable &&
        info.status !== BackendUpdateStatus.Downloading &&
        info.status !== BackendUpdateStatus.ReadyToRestart)
    ) {
      this._updateState.set(null);
    } else {
      this._updateState.set(info);
    }

    this._isChecking.set(false);
    this._lastCheck.set(new Date());
  }
}
