import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { EventListenersService } from './event-listeners.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { NotificationService } from '@app/services';
import { Subject, takeUntil, filter, map } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';

import { RcloneUpdateInfo, UpdateStatus, UpdateResult } from '@app/types';

@Injectable({
  providedIn: 'root',
})
export class RcloneUpdateService extends TauriBaseService implements OnDestroy {
  private readonly _updateStatus = signal<UpdateStatus>({
    checking: false,
    updating: false,
    available: false,
    readyToRestart: false,
    error: null,
    lastCheck: null,
    updateInfo: null,
  });

  private readonly _skippedVersions = signal<string[]>([]);
  private readonly _updateChannel = signal<string>('stable');
  private readonly _autoCheck = signal<boolean>(true);

  private destroy$ = new Subject<void>();
  private initialized = false;

  public readonly updateStatus = this._updateStatus.asReadonly();
  public readonly skippedVersions = this._skippedVersions.asReadonly();
  public readonly updateChannel = this._updateChannel.asReadonly();
  public readonly autoCheck = this._autoCheck.asReadonly();

  private eventListenersService = inject(EventListenersService);
  private appSettingsService = inject(AppSettingsService);
  private notificationService = inject(NotificationService);
  private translate = inject(TranslateService);

  constructor() {
    super();
    this.setupEventListeners();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const [skippedVersions, channel, autoCheck] = await Promise.all([
        this.getSkippedVersions(),
        this.getChannel(),
        this.getAutoCheckEnabled(),
      ]);

      this._skippedVersions.set(skippedVersions);
      this._updateChannel.set(channel);
      this._autoCheck.set(autoCheck);

      this.initialized = true;

      if (autoCheck) {
        await this.restoreUpdateState();
      }

      console.debug('Rclone update service initialized');
    } catch (error) {
      console.error('Failed to initialize rclone update service:', error);
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // -------------------------------------------------------------------------
  // Update checks
  // -------------------------------------------------------------------------

  async checkForUpdates(): Promise<RcloneUpdateInfo | null> {
    this.patchUpdateStatus({ checking: true, error: null });

    try {
      await this.initialize();

      const updateInfo = await this.invokeCommand<RcloneUpdateInfo>('check_rclone_update', {
        channel: this._updateChannel(),
      });

      this.processUpdateResult(updateInfo);
      return updateInfo;
    } catch (error) {
      console.error('Failed to check for updates:', error);
      this.patchUpdateStatus({ checking: false, error: error as string, lastCheck: new Date() });
      return null;
    }
  }

  async performUpdate(): Promise<boolean> {
    this.patchUpdateStatus({ updating: true, error: null });

    try {
      const result = await this.invokeCommand<UpdateResult>('update_rclone', {
        channel: this._updateChannel(),
      });

      if (result.success) {
        this.patchUpdateStatus({ updating: false, available: false, readyToRestart: true });
        return true;
      }

      const errorMsg = result.message || this.translate.instant('rcloneUpdate.failed');
      this.patchUpdateStatus({
        updating: false,
        error: errorMsg,
      });
      this.notificationService.showError(errorMsg, undefined, undefined);
      return false;
    } catch (error) {
      console.error('Failed to update rclone:', error);
      const errorMsg = this.translate.instant('rcloneUpdate.failed') + ': ' + (error as string);
      this.patchUpdateStatus({ updating: false, error: errorMsg });
      this.notificationService.showError(errorMsg, undefined, undefined);
      return false;
    }
  }

  async applyUpdate(): Promise<boolean> {
    try {
      await this.invokeCommand<void>('apply_rclone_update');
      this.patchUpdateStatus({ readyToRestart: false, updateInfo: null });
      return true;
    } catch (error) {
      console.error('Failed to apply rclone update:', error);
      this.notificationService.showError(
        this.translate.instant('rcloneUpdate.failed') + ': ' + (error as string)
      );
      this.patchUpdateStatus({ readyToRestart: false });
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Channel management
  // -------------------------------------------------------------------------

  async getChannel(): Promise<string> {
    try {
      return (
        (await this.appSettingsService.getSettingValue<string>('runtime.rclone_update_channel')) ||
        'stable'
      );
    } catch {
      return 'stable';
    }
  }

  async setChannel(channel: string): Promise<void> {
    try {
      await this.appSettingsService.saveSetting('runtime', 'rclone_update_channel', channel);
      this._updateChannel.set(channel);
      this.patchUpdateStatus({ available: false, updateInfo: null, error: null, lastCheck: null });
      this.notificationService.openSnackBar(
        this.translate.instant('rcloneUpdate.channelChanged', { channel }),
        'Close'
      );
    } catch (error) {
      console.error('Failed to save rclone update channel:', error);
      this.notificationService.openSnackBar(
        this.translate.instant('rcloneUpdate.channelSaveFailed'),
        'Close'
      );
    }
  }

  // -------------------------------------------------------------------------
  // Version skipping
  // -------------------------------------------------------------------------

  async getSkippedVersions(): Promise<string[]> {
    try {
      return (
        (await this.appSettingsService.getSettingValue<string[]>(
          'runtime.rclone_skipped_updates'
        )) || []
      );
    } catch {
      return [];
    }
  }

  isVersionSkipped(version: string): boolean {
    return this._skippedVersions().includes(version);
  }

  async skipVersion(version: string): Promise<void> {
    try {
      const current = await this.getSkippedVersions();
      if (current.includes(version)) return;

      const updated = [...current, version];
      await this.appSettingsService.saveSetting('runtime', 'rclone_skipped_updates', updated);
      this._skippedVersions.set(updated);

      const info = this._updateStatus().updateInfo;
      if (info?.latest_version === version || info?.latest_version_clean === version) {
        this.patchUpdateStatus({
          available: false,
          updateInfo: { ...info, update_available: false },
        });
      }

      this.notificationService.openSnackBar(
        this.translate.instant('rcloneUpdate.skipped', { version }),
        'Close'
      );
    } catch (error) {
      console.error('Failed to skip rclone version:', error);
      this.notificationService.openSnackBar(
        this.translate.instant('rcloneUpdate.skipFailed'),
        'Close'
      );
    }
  }

  async unskipVersion(version: string): Promise<void> {
    try {
      const updated = (await this.getSkippedVersions()).filter(v => v !== version);
      await this.appSettingsService.saveSetting('runtime', 'rclone_skipped_updates', updated);
      this._skippedVersions.set(updated);
      this.checkForUpdates();
      this.notificationService.openSnackBar(
        this.translate.instant('rcloneUpdate.restored', { version }),
        'Close'
      );
    } catch (error) {
      console.error('Failed to unskip rclone version:', error);
      this.notificationService.openSnackBar(
        this.translate.instant('rcloneUpdate.restoreFailed'),
        'Close'
      );
    }
  }

  // -------------------------------------------------------------------------
  // Auto-check
  // -------------------------------------------------------------------------

  async getAutoCheckEnabled(): Promise<boolean> {
    try {
      return (
        (await this.appSettingsService.getSettingValue<boolean>(
          'runtime.rclone_auto_check_updates'
        )) ?? true
      );
    } catch {
      return true;
    }
  }

  async setAutoCheckEnabled(enabled: boolean): Promise<void> {
    try {
      await this.appSettingsService.saveSetting('runtime', 'rclone_auto_check_updates', enabled);
      this._autoCheck.set(enabled);
      this.notificationService.openSnackBar(
        this.translate.instant(
          enabled ? 'rcloneUpdate.autoCheckEnabled' : 'rcloneUpdate.autoCheckDisabled'
        ),
        'Close'
      );
    } catch (error) {
      console.error('Failed to save rclone auto-check setting:', error);
      this.notificationService.openSnackBar(
        this.translate.instant('rcloneUpdate.settingsSaveFailed'),
        'Close'
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private setupEventListeners(): void {
    this.eventListenersService
      .listenToRcloneEngineUpdating()
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        console.debug('Rclone engine update applying');
        this.patchUpdateStatus({ updating: true });
      });

    this.eventListenersService
      .listenToEngineRestarted()
      .pipe(takeUntil(this.destroy$))
      .subscribe(event => {
        if (event.reason === 'rclone_update') {
          this.patchUpdateStatus({ updating: false });
          this.checkForUpdates();
        }
      });

    this.eventListenersService
      .listenToAppEvents()
      .pipe(
        takeUntil(this.destroy$),
        filter(event => event.status === 'rclone_update_found' && !!event.data),
        map(event => event.data as unknown as RcloneUpdateInfo)
      )
      .subscribe(data => {
        console.debug('Received rclone_update_found event:', data);
        this.processUpdateResult(data);
      });
  }

  /**
   * On startup, ask the backend for whatever update state it already holds
   * so the UI can restore the correct phase without re-downloading.
   *
   * Backend returns one of:
   *  - null                                    → nothing pending
   *  - { update_available, ready_to_restart }  → .new file exists, waiting to apply
   *  - { update_available, latest_version }    → update downloaded, not yet staged
   */
  private async restoreUpdateState(): Promise<void> {
    try {
      const cached = await this.invokeCommand<RcloneUpdateInfo | null>('get_rclone_update_info');
      if (!cached?.update_available) return;

      if (cached.ready_to_restart) {
        // Binary is already staged as .new — go straight to the apply prompt
        this.patchUpdateStatus({
          available: false,
          readyToRestart: true,
          updateInfo: cached,
          lastCheck: new Date(),
        });
        return;
      }

      // Normal pending update — run it through the skip filter
      if (!this.isVersionSkipped(cached.latest_version_clean ?? cached.latest_version)) {
        this.processUpdateResult(cached);
      }
    } catch (error) {
      console.error('Failed to restore rclone update state:', error);
    }
  }

  private processUpdateResult(updateInfo: RcloneUpdateInfo): void {
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
