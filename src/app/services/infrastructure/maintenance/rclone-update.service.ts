import { Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, map, take, firstValueFrom } from 'rxjs';
import { BaseUpdateService } from '../maintenance/base-update.service';
import { EventListenersService } from '../system/event-listeners.service';
import { RcloneUpdateInfo, UpdateStatus, UpdateResult } from '@app/types';

@Injectable({ providedIn: 'root' })
export class RcloneUpdateService extends BaseUpdateService {
  private eventListenersService = inject(EventListenersService);

  private readonly _updateStatus = signal<UpdateStatus>({
    checking: false,
    downloading: false,
    available: false,
    readyToRestart: false,
    error: null,
    lastCheck: null,
    updateInfo: null,
  });

  readonly updateStatus = this._updateStatus.asReadonly();

  protected override get settingNamespace(): string {
    return 'runtime';
  }
  protected override get skippedVersionsKey(): string {
    return 'rclone_skipped_updates';
  }
  protected override get updateChannelKey(): string {
    return 'rclone_update_channel';
  }
  protected override get autoCheckKey(): string {
    return 'rclone_auto_check_updates';
  }

  constructor() {
    super();
    this.setupEventListeners();
    void this.initBaseSettings().then(() => {
      if (this.autoCheckEnabled()) {
        void this.restoreUpdateState();
      }
    });
  }

  async checkForUpdates(): Promise<RcloneUpdateInfo | null> {
    this.patchUpdateStatus({ checking: true, error: null });
    try {
      const updateInfo = await this.invokeCommand<RcloneUpdateInfo>('check_rclone_update', {
        channel: this.updateChannel(),
      });
      this.processUpdateResult(updateInfo);
      return updateInfo;
    } catch (error) {
      console.error('Failed to check for updates:', error);
      this.patchUpdateStatus({
        checking: false,
        error: String(error),
        lastCheck: new Date(),
      });
      return null;
    }
  }

  async performUpdate(): Promise<boolean> {
    this.patchUpdateStatus({ downloading: true, error: null });
    try {
      const result = await this.invokeWithNotification<UpdateResult>(
        'update_rclone',
        {
          channel: this.updateChannel(),
        },
        {
          errorKey: 'rcloneUpdate.failed',
          showSuccess: false,
        }
      );

      if (result.success) {
        if (result.immediate) {
          // Remote in-place update: already applied and restarted, no activation step.
          this.patchUpdateStatus({
            downloading: false,
            available: false,
            readyToRestart: false,
            updateInfo: null,
          });
        } else {
          this.patchUpdateStatus({ downloading: false, available: false, readyToRestart: true });
        }
        return true;
      }

      this.patchUpdateStatus({ downloading: false, error: result.message });
      return false;
    } catch (error) {
      console.error('Failed to update rclone:', error);
      this.patchUpdateStatus({ downloading: false, error: String(error) });
      return false;
    }
  }

  async applyUpdate(): Promise<boolean> {
    const restartPromise = firstValueFrom(
      this.eventListenersService.listenToEngineRestarted().pipe(
        filter(event => event.reason === 'rclone_update'),
        take(1)
      )
    );

    try {
      await this.invokeWithNotification<void>('apply_rclone_update', undefined, {
        errorKey: 'rcloneUpdate.failed',
        showSuccess: false,
      });

      // Wait for the engine to actually be back up before resolving
      await restartPromise;

      this.patchUpdateStatus({ readyToRestart: false, updateInfo: null });
      return true;
    } catch (error) {
      console.error('Failed to apply rclone update:', error);
      this.patchUpdateStatus({ readyToRestart: false });
      return false;
    }
  }

  override async setChannel(channel: string): Promise<void> {
    await super.setChannel(channel);
    this.patchUpdateStatus({ available: false, updateInfo: null, error: null, lastCheck: null });
    this.notificationService.showInfo(
      this.translate.instant('rcloneUpdate.channelChanged', { channel })
    );
  }

  override async skipVersion(version: string): Promise<void> {
    await super.skipVersion(version);
    this.notificationService.showInfo(this.translate.instant('rcloneUpdate.skipped', { version }));
    const info = this._updateStatus().updateInfo;
    if (info?.latest_version === version || info?.latest_version_clean === version) {
      this.patchUpdateStatus({
        available: false,
        updateInfo: { ...info, update_available: false },
      });
    }
  }

  override async unskipVersion(version: string): Promise<void> {
    await super.unskipVersion(version);
    void this.checkForUpdates();
    this.notificationService.showInfo(this.translate.instant('rcloneUpdate.restored', { version }));
  }

  override async setAutoCheckEnabled(enabled: boolean): Promise<void> {
    await super.setAutoCheckEnabled(enabled);
    this.notificationService.showInfo(
      this.translate.instant(
        enabled ? 'rcloneUpdate.autoCheckEnabled' : 'rcloneUpdate.autoCheckDisabled'
      )
    );
  }

  private setupEventListeners(): void {
    this.eventListenersService
      .listenToRcloneEngineUpdating()
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.patchUpdateStatus({ downloading: true }));

    this.eventListenersService
      .listenToEngineRestarted()
      .pipe(takeUntilDestroyed())
      .subscribe(event => {
        if (event.reason === 'rclone_update') {
          this.patchUpdateStatus({ downloading: false });
          void this.checkForUpdates();
        }
      });

    this.eventListenersService
      .listenToAppEvents()
      .pipe(
        takeUntilDestroyed(),
        filter(event => event.status === 'rclone_update_found' && !!event.data),
        map(event => event.data as unknown as RcloneUpdateInfo)
      )
      .subscribe(data => this.processUpdateResult(data));
  }

  private async restoreUpdateState(): Promise<void> {
    try {
      const cached = await this.invokeCommand<RcloneUpdateInfo | null>('get_rclone_update_info');
      if (cached) this.processUpdateResult(cached);
    } catch (error) {
      console.error('Failed to restore rclone update state:', error);
    }
  }

  private processUpdateResult(updateInfo: RcloneUpdateInfo): void {
    if (updateInfo.ready_to_restart) {
      this.patchUpdateStatus({
        available: false,
        readyToRestart: true,
        updateInfo,
        lastCheck: new Date(),
      });
      return;
    }

    const isSkipped =
      updateInfo.update_available &&
      this.isVersionSkipped(updateInfo.latest_version_clean ?? updateInfo.latest_version);

    this.patchUpdateStatus({
      checking: false,
      available: updateInfo.update_available && !isSkipped,
      lastCheck: new Date(),
      updateInfo: isSkipped ? { ...updateInfo, update_available: false } : updateInfo,
    });
  }

  private patchUpdateStatus(update: Partial<UpdateStatus>): void {
    this._updateStatus.update(current => ({ ...current, ...update }));
  }
}
