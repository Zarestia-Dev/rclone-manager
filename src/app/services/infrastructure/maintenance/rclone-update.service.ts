import { Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, map, firstValueFrom } from 'rxjs';
import { EventListenersService } from '../system/event-listeners.service';
import { UpdateInfo, UpdateStatus, UpdateResult, BackendUpdateStatus } from '@app/types';
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

  private readonly _updateStatus = signal<UpdateStatus>({
    checking: false,
    downloading: false,
    available: false,
    readyToRestart: false,
    error: null,
    lastCheck: null,
    updateInfo: null,
  });

  public readonly updateStatus = this._updateStatus.asReadonly();

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
    const status = this._updateStatus();

    if (status.checking || status.downloading || status.readyToRestart) {
      // Already active — just sync the current info.
      const info = await this.invokeCommand<UpdateInfo | null>('get_rclone_update_info');

      // Discard stale syncs
      if (checkId !== this._latestCheckId) return null;

      if (info) this.processUpdateResult(info);
      return info;
    }

    this.patchStatus({ checking: true, error: null });
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
      this.patchStatus({ checking: false, error: String(error), lastCheck: new Date() });
      return null;
    }
  }

  async performUpdate(): Promise<boolean> {
    this.patchStatus({ downloading: true, error: null });
    try {
      const result = await this.invokeWithNotification<UpdateResult>(
        'update_rclone',
        { channel: this.settings.updateChannel() },
        { errorKey: 'rcloneUpdate.failed', showSuccess: false }
      );

      if (result.success) {
        if (result.manual) {
          // Binary swapped on a remote host — user must restart it manually.
          this.patchStatus({
            downloading: false,
            available: false,
            readyToRestart: true,
            updateInfo: null,
          });
          this.notificationService.showWarning(
            this.translate.instant('rcloneUpdate.manualRestartRequired')
          );
        } else {
          this.patchStatus({ downloading: false, available: false, readyToRestart: true });
        }
        return true;
      }

      this.patchStatus({ downloading: false, error: result.message });
      return false;
    } catch (error) {
      console.error('Failed to update rclone:', error);
      this.patchStatus({ downloading: false, error: String(error) });
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

      this.patchStatus({ readyToRestart: false, updateInfo: null });
      return true;
    } catch (error) {
      console.error('Failed to apply rclone update:', error);
      this.patchStatus({ readyToRestart: false });
      return false;
    }
  }

  async setChannel(channel: string): Promise<void> {
    await this.settings.setChannel(channel);
    this.patchStatus({ available: false, updateInfo: null, error: null, lastCheck: null });
    this.notificationService.showInfo(
      this.translate.instant('rcloneUpdate.channelChanged', { channel })
    );
    void this.checkForUpdates();
  }

  async skipVersion(version: string): Promise<void> {
    await this.settings.skipVersion(version);
    this.notificationService.showInfo(this.translate.instant('rcloneUpdate.skipped', { version }));
    const info = this._updateStatus().updateInfo;
    if (info?.version === version) {
      this.patchStatus({ available: false, updateInfo: { ...info, updateAvailable: false } });
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
      .subscribe(() => this.patchStatus({ downloading: true }));

    this.eventListenersService
      .listenToEngineRestarted()
      .pipe(takeUntilDestroyed())
      .subscribe(event => {
        if (event.reason === 'rclone_update') {
          this.patchStatus({ downloading: false });
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
      this.patchStatus({
        available: false,
        readyToRestart: true,
        updateInfo: info,
        lastCheck: new Date(),
      });
      return;
    }

    if (info.status === BackendUpdateStatus.Downloading) {
      this.patchStatus({
        checking: false,
        downloading: true,
        available: true,
        updateInfo: info,
      });
      return;
    }

    const isSkipped = info.updateAvailable && this.settings.isVersionSkipped(info.version);

    this.patchStatus({
      checking: false,
      available: info.updateAvailable && !isSkipped,
      lastCheck: new Date(),
      updateInfo: isSkipped ? { ...info, updateAvailable: false } : info,
    });
  }

  private patchStatus(update: Partial<UpdateStatus>): void {
    this._updateStatus.update(current => ({ ...current, ...update }));
  }
}
