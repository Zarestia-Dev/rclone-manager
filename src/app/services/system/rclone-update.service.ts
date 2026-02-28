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
    // Auto-check will be handled by initialization and settings
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Load settings
      const [skippedVersions, channel, autoCheck] = await Promise.all([
        this.getSkippedVersions(),
        this.getChannel(),
        this.getAutoCheckEnabled(),
      ]);

      this._skippedVersions.set(skippedVersions);
      this._updateChannel.set(channel);
      this._autoCheck.set(autoCheck);

      this.initialized = true;
      console.debug('Rclone update service initialized');
    } catch (error) {
      console.error('Failed to initialize rclone update service:', error);
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private setupEventListeners(): void {
    // Listen for engine update started
    this.eventListenersService
      .listenToRcloneEngineUpdating()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          try {
            console.debug('Rclone Engine updating started');
            this.patchUpdateStatus({ updating: true });
          } catch (error) {
            console.error('Error handling Rclone Engine updating event:', error);
          }
        },
      });

    // Listen for engine restarted (indicates update completion)
    this.eventListenersService.listenToEngineRestarted().subscribe(event => {
      if (event.reason === 'rclone_update') {
        this.patchUpdateStatus({ updating: false });
        this.checkForUpdates();
      }
    });

    // Listen to auto-updater results
    this.eventListenersService
      .listenToAppEvents()
      .pipe(
        takeUntil(this.destroy$),
        filter(event => event.status === 'rclone_update_found' && !!event.data),
        map(event => event.data as unknown as object)
      )
      .subscribe(data => {
        console.debug('Received rclone update found event:', data);
        this.processUpdateResult(data as RcloneUpdateInfo);
      });
  }

  async checkForUpdates(): Promise<RcloneUpdateInfo | null> {
    this.patchUpdateStatus({ checking: true, error: null });

    try {
      // Ensure initialization
      await this.initialize();

      const channel = this._updateChannel();
      const updateInfo = await this.invokeCommand<RcloneUpdateInfo>('check_rclone_update', {
        channel,
      });

      this.processUpdateResult(updateInfo);

      return updateInfo;
    } catch (error) {
      console.error('Failed to check for updates:', error);
      this.patchUpdateStatus({
        checking: false,
        error: error as string,
        lastCheck: new Date(),
      });
      return null;
    }
  }

  async getDetailedUpdateInfo(): Promise<RcloneUpdateInfo> {
    try {
      return await this.invokeCommand<RcloneUpdateInfo>('get_rclone_update_info');
    } catch (error) {
      console.error('Failed to get detailed update info:', error);
      throw error;
    }
  }

  async performUpdate(): Promise<boolean> {
    this.patchUpdateStatus({ updating: true, error: null });

    try {
      const channel = this._updateChannel();
      const result = await this.invokeCommand<UpdateResult>('update_rclone', {
        channel,
      });

      if (result.success) {
        this.patchUpdateStatus({
          updating: false,
          available: false,
          updateInfo: null,
        });

        // Log the successful update with path info if available
        if ('path' in result) {
          console.debug(`Rclone updated successfully to ${channel} channel at:`, result.path);
        }

        this.notificationService.openSnackBar(
          this.translate.instant('rcloneUpdate.success', { channel }),
          'Close'
        );

        return true;
      } else {
        this.patchUpdateStatus({
          updating: false,
          error: result.message || this.translate.instant('rcloneUpdate.failed'),
        });
        return false;
      }
    } catch (error) {
      console.error('Failed to update rclone:', error);
      this.patchUpdateStatus({
        updating: false,
        error: error as string,
      });
      return false;
    }
  }

  private patchUpdateStatus(update: Partial<UpdateStatus>): void {
    this._updateStatus.update(current => ({ ...current, ...update }));
  }

  getCurrentStatus(): UpdateStatus {
    return this._updateStatus();
  }

  // Channel management methods
  async getChannel(): Promise<string> {
    try {
      const channel = await this.appSettingsService.getSettingValue<string>(
        'runtime.rclone_update_channel'
      );
      return channel || 'stable';
    } catch (error) {
      console.error('Failed to load rclone update channel:', error);
      return 'stable';
    }
  }

  async setChannel(channel: string): Promise<void> {
    try {
      await this.appSettingsService.saveSetting('runtime', 'rclone_update_channel', channel);
      this._updateChannel.set(channel);

      // Clear update status when channel is changed
      this.patchUpdateStatus({
        available: false,
        updateInfo: null,
        error: null,
        lastCheck: null,
      });

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

  getCurrentChannel(): string {
    return this._updateChannel();
  }

  // Version skipping methods
  async getSkippedVersions(): Promise<string[]> {
    try {
      const skipped = await this.appSettingsService.getSettingValue<string[]>(
        'runtime.rclone_skipped_updates'
      );
      console.debug('Skipped rclone versions:', skipped);
      return skipped || [];
    } catch (error) {
      console.error('Failed to load skipped rclone versions:', error);
      return [];
    }
  }

  async skipVersion(version: string): Promise<void> {
    try {
      const currentSkipped = await this.getSkippedVersions();
      if (!currentSkipped.includes(version)) {
        const newSkipped = [...currentSkipped, version];
        await this.appSettingsService.saveSetting('runtime', 'rclone_skipped_updates', newSkipped);
        this._skippedVersions.set(newSkipped);

        // Immediately update the UI to hide the available update
        const currentStatus = this._updateStatus();
        if (
          currentStatus.updateInfo?.latest_version === version ||
          currentStatus.updateInfo?.latest_version_clean === version
        ) {
          this.patchUpdateStatus({
            available: false,
            updateInfo: currentStatus.updateInfo
              ? { ...currentStatus.updateInfo, update_available: false }
              : null,
          });
        }

        this.notificationService.openSnackBar(
          this.translate.instant('rcloneUpdate.skipped', { version }),
          'Close'
        );
      }
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
      const currentSkipped = await this.getSkippedVersions();
      const newSkipped = currentSkipped.filter(v => v !== version);
      await this.appSettingsService.saveSetting('runtime', 'rclone_skipped_updates', newSkipped);
      this._skippedVersions.set(newSkipped);

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

  isVersionSkipped(version: string): boolean {
    return this._skippedVersions().includes(version);
  }

  // Auto-check methods
  async getAutoCheckEnabled(): Promise<boolean> {
    try {
      const enabled = await this.appSettingsService.getSettingValue<boolean>(
        'runtime.rclone_auto_check_updates'
      );
      return enabled ?? true;
    } catch (error) {
      console.error('Failed to load rclone auto-check setting:', error);
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

  private processUpdateResult(updateInfo: RcloneUpdateInfo): void {
    const channel = this._updateChannel();
    // Check if this version is skipped
    const isSkipped =
      updateInfo.update_available &&
      this.isVersionSkipped(updateInfo.latest_version_clean || updateInfo.latest_version);

    // If version is skipped, modify the updateInfo to reflect that
    const finalUpdateInfo = isSkipped ? { ...updateInfo, update_available: false } : updateInfo;

    this.patchUpdateStatus({
      checking: false,
      available: updateInfo.update_available && !isSkipped,
      lastCheck: new Date(),
      updateInfo: finalUpdateInfo,
    });

    if (updateInfo.update_available && !isSkipped) {
      console.debug(`Rclone update available: ${updateInfo.latest_version} (${channel} channel)`);
    }
  }
}
