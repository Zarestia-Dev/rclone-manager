import { Injectable, OnDestroy, inject } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { EventListenersService } from './event-listeners.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { NotificationService } from '../../shared/services/notification.service';
import { BehaviorSubject, Subject, takeUntil } from 'rxjs';

import { RcloneUpdateInfo, UpdateStatus, UpdateResult } from '@app/types';

@Injectable({
  providedIn: 'root',
})
export class RcloneUpdateService extends TauriBaseService implements OnDestroy {
  private updateStatusSubject = new BehaviorSubject<UpdateStatus>({
    checking: false,
    updating: false,
    available: false,
    error: null,
    lastCheck: null,
    updateInfo: null,
  });

  private skippedVersionsSubject = new BehaviorSubject<string[]>([]);
  private updateChannelSubject = new BehaviorSubject<string>('stable');
  private autoCheckSubject = new BehaviorSubject<boolean>(true);

  private destroy$ = new Subject<void>();
  private initialized = false;

  public updateStatus$ = this.updateStatusSubject.asObservable();
  public skippedVersions$ = this.skippedVersionsSubject.asObservable();
  public updateChannel$ = this.updateChannelSubject.asObservable();
  public autoCheck$ = this.autoCheckSubject.asObservable();

  private eventListenersService = inject(EventListenersService);
  private appSettingsService = inject(AppSettingsService);
  private notificationService = inject(NotificationService);

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

      this.skippedVersionsSubject.next(skippedVersions);
      this.updateChannelSubject.next(channel);
      this.autoCheckSubject.next(autoCheck);

      this.initialized = true;
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
            console.log('Rclone Engine updating started');
            this.updateStatus({ updating: true });
          } catch (error) {
            console.error('Error handling Rclone Engine updating event:', error);
          }
        },
      });

    // Listen for engine restarted (indicates update completion)
    this.eventListenersService.listenToEngineRestarted().subscribe(event => {
      if (event.reason === 'rclone_update') {
        this.updateStatus({ updating: false });
        this.checkForUpdates();
      }
    });
  }

  async checkForUpdates(): Promise<RcloneUpdateInfo | null> {
    this.updateStatus({ checking: true, error: null });

    try {
      // Ensure initialization
      await this.initialize();

      const channel = this.updateChannelSubject.value;
      const updateInfo = await this.invokeCommand<RcloneUpdateInfo>('check_rclone_update', {
        channel,
      });

      // Check if this version is skipped
      const isSkipped =
        updateInfo.update_available &&
        this.isVersionSkipped(updateInfo.latest_version_clean || updateInfo.latest_version);

      // If version is skipped, modify the updateInfo to reflect that
      const finalUpdateInfo = isSkipped ? { ...updateInfo, update_available: false } : updateInfo;

      this.updateStatus({
        checking: false,
        available: updateInfo.update_available && !isSkipped,
        lastCheck: new Date(),
        updateInfo: finalUpdateInfo,
      });

      if (updateInfo.update_available && !isSkipped) {
        console.log(`Rclone update available: ${updateInfo.latest_version} (${channel} channel)`);
      } else if (isSkipped) {
        console.log(`Rclone update ${updateInfo.latest_version} is skipped`);
      }

      return updateInfo;
    } catch (error) {
      console.error('Failed to check for updates:', error);
      this.updateStatus({
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
    this.updateStatus({ updating: true, error: null });

    try {
      const channel = this.updateChannelSubject.value;
      const result = await this.invokeCommand<UpdateResult>('update_rclone', {
        channel,
      });

      if (result.success) {
        this.updateStatus({
          updating: false,
          available: false,
          updateInfo: null,
        });

        // Log the successful update with path info if available
        if ('path' in result) {
          console.log(`Rclone updated successfully to ${channel} channel at:`, result.path);
        }

        this.notificationService.openSnackBar(
          `Rclone updated successfully (${channel} channel)`,
          'Close'
        );

        return true;
      } else {
        this.updateStatus({
          updating: false,
          error: result.message || 'Update failed',
        });
        return false;
      }
    } catch (error) {
      console.error('Failed to update rclone:', error);
      this.updateStatus({
        updating: false,
        error: error as string,
      });
      return false;
    }
  }

  private updateStatus(update: Partial<UpdateStatus>): void {
    const currentStatus = this.updateStatusSubject.value;
    this.updateStatusSubject.next({ ...currentStatus, ...update });
  }

  getCurrentStatus(): UpdateStatus {
    return this.updateStatusSubject.value;
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
      this.updateChannelSubject.next(channel);

      // Clear update status when channel is changed
      this.updateStatus({
        available: false,
        updateInfo: null,
        error: null,
        lastCheck: null,
      });

      this.notificationService.openSnackBar(`Rclone update channel changed to ${channel}`, 'Close');
    } catch (error) {
      console.error('Failed to save rclone update channel:', error);
      this.notificationService.openSnackBar('Failed to save rclone update channel', 'Close');
    }
  }

  getCurrentChannel(): string {
    return this.updateChannelSubject.value;
  }

  // Version skipping methods
  async getSkippedVersions(): Promise<string[]> {
    try {
      const skipped = await this.appSettingsService.getSettingValue<string[]>(
        'runtime.rclone_skipped_updates'
      );
      return Array.isArray(skipped) ? skipped : [];
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
        this.skippedVersionsSubject.next(newSkipped);

        // Immediately update the UI to hide the available update
        const currentStatus = this.updateStatusSubject.value;
        if (
          currentStatus.updateInfo?.latest_version === version ||
          currentStatus.updateInfo?.latest_version_clean === version
        ) {
          this.updateStatus({
            available: false,
            updateInfo: currentStatus.updateInfo
              ? { ...currentStatus.updateInfo, update_available: false }
              : null,
          });
        }

        this.notificationService.openSnackBar(`Rclone version ${version} skipped`, 'Close');
      }
    } catch (error) {
      console.error('Failed to skip rclone version:', error);
      this.notificationService.openSnackBar('Failed to skip rclone update', 'Close');
    }
  }

  async unskipVersion(version: string): Promise<void> {
    try {
      const currentSkipped = await this.getSkippedVersions();
      const newSkipped = currentSkipped.filter(v => v !== version);
      await this.appSettingsService.saveSetting('runtime', 'rclone_skipped_updates', newSkipped);
      this.skippedVersionsSubject.next(newSkipped);

      // Immediately check for updates to refresh the UI
      this.checkForUpdates();

      this.notificationService.openSnackBar(`Rclone version ${version} restored`, 'Close');
    } catch (error) {
      console.error('Failed to unskip rclone version:', error);
      this.notificationService.openSnackBar('Failed to restore rclone update', 'Close');
    }
  }

  isVersionSkipped(version: string): boolean {
    return this.skippedVersionsSubject.value.includes(version);
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
      this.autoCheckSubject.next(enabled);

      this.notificationService.openSnackBar(
        `Rclone auto-check updates ${enabled ? 'enabled' : 'disabled'}`,
        'Close'
      );
    } catch (error) {
      console.error('Failed to save rclone auto-check setting:', error);
      this.notificationService.openSnackBar('Failed to save rclone update settings', 'Close');
    }
  }
}
