import { Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, map, take, firstValueFrom, timeout, catchError, EMPTY } from 'rxjs';
import { BaseUpdateService } from '../maintenance/base-update.service';
import { EventListenersService } from '../system/event-listeners.service';
import { RcloneUpdateInfo, UpdateStatus, UpdateResult } from '@app/types';

@Injectable({ providedIn: 'root' })
export class RcloneUpdateService extends BaseUpdateService {
  private readonly eventListenersService = inject(EventListenersService);

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

  // ---------------------------------------------------------------------------
  // BaseUpdateService keys
  // ---------------------------------------------------------------------------

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
      if (this.autoCheckEnabled()) void this.restoreUpdateState();
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async checkForUpdates(): Promise<RcloneUpdateInfo | null> {
    this.patchStatus({ checking: true, error: null });
    try {
      const info = await this.invokeCommand<RcloneUpdateInfo>('check_rclone_update', {
        channel: this.updateChannel(),
      });
      this.processUpdateResult(info);
      return info;
    } catch (error) {
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
        { channel: this.updateChannel() },
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
    // Listen for the engine restart confirmation with a 30 s timeout.
    const restartConfirmed$ = this.eventListenersService.listenToEngineRestarted().pipe(
      filter(event => event.reason === 'rclone_update'),
      take(1),
      timeout(30_000),
      catchError(() => {
        console.warn('Timed out waiting for rclone engine restart');
        return EMPTY;
      })
    );

    try {
      await this.invokeWithNotification<void>('apply_rclone_update', undefined, {
        errorKey: 'rcloneUpdate.failed',
        showSuccess: false,
      });

      await firstValueFrom(restartConfirmed$, { defaultValue: null });

      this.patchStatus({ readyToRestart: false, updateInfo: null });
      return true;
    } catch (error) {
      console.error('Failed to apply rclone update:', error);
      this.patchStatus({ readyToRestart: false });
      return false;
    }
  }

  override async setChannel(channel: string): Promise<void> {
    await super.setChannel(channel);
    this.patchStatus({ available: false, updateInfo: null, error: null, lastCheck: null });
    this.notificationService.showInfo(
      this.translate.instant('rcloneUpdate.channelChanged', { channel })
    );
  }

  override async skipVersion(version: string): Promise<void> {
    await super.skipVersion(version);
    this.notificationService.showInfo(this.translate.instant('rcloneUpdate.skipped', { version }));
    const info = this._updateStatus().updateInfo;
    if (info?.latest_version === version || info?.latest_version_clean === version) {
      this.patchStatus({ available: false, updateInfo: { ...info, update_available: false } });
    }
  }

  override async unskipVersion(version: string): Promise<void> {
    await super.unskipVersion(version);
    this.notificationService.showInfo(this.translate.instant('rcloneUpdate.restored', { version }));
    void this.checkForUpdates();
  }

  override async setAutoCheckEnabled(enabled: boolean): Promise<void> {
    await super.setAutoCheckEnabled(enabled);
    this.notificationService.showInfo(
      this.translate.instant(
        enabled ? 'rcloneUpdate.autoCheckEnabled' : 'rcloneUpdate.autoCheckDisabled'
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

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

  private processUpdateResult(info: RcloneUpdateInfo): void {
    if (info.ready_to_restart) {
      this.patchStatus({
        available: false,
        readyToRestart: true,
        updateInfo: info,
        lastCheck: new Date(),
      });
      return;
    }

    const isSkipped =
      info.update_available &&
      this.isVersionSkipped(info.latest_version_clean ?? info.latest_version);

    this.patchStatus({
      checking: false,
      available: info.update_available && !isSkipped,
      lastCheck: new Date(),
      updateInfo: isSkipped ? { ...info, update_available: false } : info,
    });
  }

  private patchStatus(update: Partial<UpdateStatus>): void {
    this._updateStatus.update(current => ({ ...current, ...update }));
  }
}
