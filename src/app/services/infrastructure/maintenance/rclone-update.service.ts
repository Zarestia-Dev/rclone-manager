import { Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, map, firstValueFrom } from 'rxjs';
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

  private readonly _isChecking = signal<boolean>(false);
  private readonly _downloading = signal<boolean>(false);
  private readonly _readyToRestart = signal<boolean>(false);
  private readonly _updateAvailable = signal<UpdateInfo | null>(null);
  private readonly _hasUpdates = signal<boolean>(false);
  private readonly _error = signal<string | null>(null);
  private readonly _lastCheck = signal<Date | null>(null);

  // Public readonly surface
  public readonly isChecking = this._isChecking.asReadonly();
  public readonly downloading = this._downloading.asReadonly();
  public readonly readyToRestart = this._readyToRestart.asReadonly();
  public readonly updateAvailable = this._updateAvailable.asReadonly();
  public readonly hasUpdates = this._hasUpdates.asReadonly();
  public readonly error = this._error.asReadonly();
  public readonly lastCheck = this._lastCheck.asReadonly();

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

    if (this._isChecking() || this._downloading() || this._readyToRestart()) {
      // Already active — just sync the current info.
      const info = await this.invokeCommand<UpdateInfo | null>('get_rclone_update_info');

      // Discard stale syncs
      if (checkId !== this._latestCheckId) return null;

      if (info) this.processUpdateResult(info);
      return info;
    }

    this._isChecking.set(true);
    this._error.set(null);

    try {
      const info = await this.invokeCommand<UpdateInfo>('check_rclone_update', {
        channel: this.settings.updateChannel(),
      });

      // Discard stale results
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
    this._downloading.set(true);
    this._error.set(null);

    try {
      const result = await this.invokeWithNotification<UpdateResult>(
        'update_rclone',
        { channel: this.settings.updateChannel() },
        { errorKey: 'rcloneUpdate.failed', showSuccess: false }
      );

      if (result.success) {
        if (result.manual) {
          // Binary swapped on a remote host — user must restart it manually.
          this._downloading.set(false);
          this._updateAvailable.set(null);
          this._hasUpdates.set(false);
          this._readyToRestart.set(true);

          this.notificationService.showWarning(
            this.translate.instant('rcloneUpdate.manualRestartRequired')
          );
        } else {
          this._downloading.set(false);
          this._updateAvailable.set(null);
          this._hasUpdates.set(false);
          this._readyToRestart.set(true);
        }
        return true;
      }

      this._downloading.set(false);
      this._error.set(result.message ?? null);
      return false;
    } catch (error) {
      console.error('Failed to update rclone:', error);
      this._downloading.set(false);
      this._error.set(String(error));
      return false;
    }
  }

  async applyUpdate(): Promise<boolean> {
    try {
      await this.invokeWithNotification<void>('apply_rclone_update', undefined, {
        errorKey: 'rcloneUpdate.failed',
        showSuccess: false,
      });

      await firstValueFrom(
        this.eventListenersService
          .listenToEngineRestarted()
          .pipe(filter(event => event.reason === 'rclone_update'))
      );

      this._readyToRestart.set(false);
      this._updateAvailable.set(null);
      this._hasUpdates.set(false);
      return true;
    } catch (error) {
      console.error('Failed to apply rclone update:', error);
      this._readyToRestart.set(false);
      return false;
    }
  }

  async setChannel(channel: string): Promise<void> {
    await this.settings.setChannel(channel);
    this._updateAvailable.set(null);
    this._hasUpdates.set(false);
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
    const info = this._updateAvailable();
    if (info?.version === version) {
      this._updateAvailable.set(null);
      this._hasUpdates.set(false);
    }
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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async initialize(): Promise<void> {
    try {
      await this.settings.initialize();
      if (this.settings.autoCheckEnabled()) {
        await this.restoreUpdateState();
      }
    } catch (error) {
      console.error('Failed to initialize rclone updater service:', error);
    }
  }

  private setupEventListeners(): void {
    this.eventListenersService
      .listenToRcloneEngineUpdating()
      .pipe(takeUntilDestroyed())
      .subscribe(() => this._downloading.set(true));

    this.eventListenersService
      .listenToEngineRestarted()
      .pipe(takeUntilDestroyed())
      .subscribe(event => {
        if (event.reason === 'rclone_update') {
          this._downloading.set(false);
          void this.checkForUpdates();
        }
      });

    this.eventListenersService
      .listenToAppEvents()
      .pipe(
        takeUntilDestroyed(),
        filter(event => event.status === 'rclone_update_found' && !!event.data),
        map(event => event.data as unknown as UpdateInfo)
      )
      .subscribe(data => this.processUpdateResult(data));
  }

  private async restoreUpdateState(): Promise<void> {
    try {
      const cached = await this.invokeCommand<UpdateInfo | null>('get_rclone_update_info');
      if (cached) this.processUpdateResult(cached);
    } catch (error) {
      console.error('Failed to restore rclone update state:', error);
    }
  }

  private processUpdateResult(info: UpdateInfo): void {
    if (info.status === BackendUpdateStatus.ReadyToRestart) {
      this._readyToRestart.set(true);
      this._updateAvailable.set(info);
      this._hasUpdates.set(false);
      this._lastCheck.set(new Date());
      return;
    }

    if (info.status === BackendUpdateStatus.Downloading) {
      this._isChecking.set(false);
      this._downloading.set(true);
      this._updateAvailable.set(info);
      this._hasUpdates.set(true);
      return;
    }

    const isSkipped = info.updateAvailable && this.settings.isVersionSkipped(info.version);

    this._isChecking.set(false);
    if (info.updateAvailable && !isSkipped) {
      this._updateAvailable.set(info);
      this._hasUpdates.set(true);
    } else {
      this._updateAvailable.set(null);
      this._hasUpdates.set(false);
    }
    this._lastCheck.set(new Date());
  }
}
