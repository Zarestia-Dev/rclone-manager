import { Injectable, inject, signal, computed } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EventListenersService } from '../system/event-listeners.service';
import { UpdateInfo, UpdateResult, BackendUpdateStatus, UpdaterSnapshot } from '@app/types';
import { AppSettingsService } from '../../settings/app-settings.service';
import { TauriBaseService } from '../platform/tauri-base.service';
import { UpdateSettingsManager, isUpdateInFlight } from './update-settings-manager';

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
  /** A check started by this viewer, until the backend reports it. */
  private readonly _isChecking = signal<boolean>(false);
  private readonly _isCancelling = signal<boolean>(false);
  private readonly _snapshot = signal<UpdaterSnapshot | null>(null);

  public readonly isUpdaterEnabled = this._isUpdaterEnabled.asReadonly();
  public readonly isChecking = computed(() => this._isChecking() || !!this._snapshot()?.checking);
  public readonly isCancelling = this._isCancelling.asReadonly();
  /** The last check or update failure, translated; kept by the backend across reloads. */
  public readonly error = computed(() => this.translateBackend(this._snapshot()?.error));
  /** A note such as "restart the remote rclone", kept by the backend across reloads. */
  public readonly notice = computed(() => this.translateBackend(this._snapshot()?.notice));
  public readonly lastCheckedAt = computed(() => this._snapshot()?.lastCheckedAt ?? null);

  private readonly _updateState = computed(() => {
    const info = this._snapshot()?.update ?? null;
    return info && (info.updateAvailable || isUpdateInFlight(info.status)) ? info : null;
  });

  public readonly updateAvailable = computed(() =>
    this.settings.computeAvailableUpdate(this._updateState())
  );

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
    this._isChecking.set(true);
    try {
      // The backend records the outcome, including failures, in the snapshot.
      await this.invokeCommand<UpdateInfo>('check_rclone_update', {
        channel: this.settings.updateChannel(),
      });
    } catch (error) {
      console.error('Failed to check for rclone updates:', error);
    } finally {
      this._isChecking.set(false);
    }
    return this.restoreUpdateState();
  }

  async performUpdate(): Promise<boolean> {
    if (this.downloading() || this.readyToRestart() || this.isChecking()) return false;
    ++this._latestCheckId;
    this._snapshot.update(snapshot =>
      snapshot?.update
        ? {
            ...snapshot,
            update: { ...snapshot.update, status: BackendUpdateStatus.Downloading },
          }
        : snapshot
    );

    try {
      const result = await this.invokeWithNotification<UpdateResult>(
        'update_rclone',
        { channel: this.settings.updateChannel() },
        { errorKey: 'rcloneUpdate.failed' }
      );
      if (result.success && result.manual) {
        this.notificationService.showWarning(
          this.translate.instant('backendSuccess.rclone.remoteRestartRequired')
        );
      } else if (!result.success && result.message && !this._isCancelling()) {
        // e.g. no update to install; a cancellation is reported by cancelUpdate.
        this.notificationService.showWarning(
          this.backendTranslation.translateBackendMessage(result.message)
        );
      }
      return result.success;
    } catch (error) {
      console.error('Failed to update rclone:', error);
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
    this._snapshot.update(snapshot => (snapshot ? { ...snapshot, update: null } : snapshot));

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
        this._snapshot.update(snapshot => ({
          ...(snapshot ?? { checking: false }),
          update: info,
        }));
      });
  }

  /** Reads the backend snapshot; a newer read or update replaces an older answer. */
  private async restoreUpdateState(): Promise<UpdateInfo | null> {
    const request = ++this._latestCheckId;
    try {
      const snapshot = await this.invokeCommand<UpdaterSnapshot>('get_rclone_update_info');
      if (request === this._latestCheckId) this._snapshot.set(snapshot);
    } catch (error) {
      console.error('Failed to restore rclone update state:', error);
    }
    return this._updateState();
  }

  private translateBackend(message: string | null | undefined): string {
    return message ? this.backendTranslation.translateBackendMessage(message) : '';
  }
}
