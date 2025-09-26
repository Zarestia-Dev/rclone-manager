import { Injectable, inject } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { BehaviorSubject, interval, Subscription } from 'rxjs';
import { debounceTime, takeWhile } from 'rxjs/operators';
import { NotificationService } from '../../shared/services/notification.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { UpdateMetadata } from '@app/types';

export interface DownloadStatus {
  downloadedBytes: number;
  totalBytes: number;
  percentage: number;
  isComplete: boolean;
  isFailed?: boolean;
  failureMessage?: string | null;
}

@Injectable({
  providedIn: 'root',
})
export class AppUpdaterService {
  private notificationService = inject(NotificationService);
  private appSettingsService = inject(AppSettingsService);

  private updateAvailableSubject = new BehaviorSubject<UpdateMetadata | null>(null);
  private updateInProgressSubject = new BehaviorSubject<boolean>(false);
  private downloadStatusSubject = new BehaviorSubject<DownloadStatus>({
    downloadedBytes: 0,
    totalBytes: 0,
    percentage: 0,
    isComplete: false,
  });
  private skippedVersionsSubject = new BehaviorSubject<string[]>([]);
  private updateChannelSubject = new BehaviorSubject<string>('stable');

  private statusPollingInterval = 500; // Poll every 500ms instead of real-time events
  private pollingSubscription: Subscription | null = null;

  public updateAvailable$ = this.updateAvailableSubject.asObservable();
  public updateInProgress$ = this.updateInProgressSubject.asObservable();
  public downloadStatus$ = this.downloadStatusSubject.asObservable();
  public skippedVersions$ = this.skippedVersionsSubject.asObservable();
  public updateChannel$ = this.updateChannelSubject.asObservable();

  constructor() {
    this.initialize();
  }

  async checkForUpdates(): Promise<UpdateMetadata | null> {
    try {
      console.log('Checking for updates on channel:', this.updateChannelSubject.value);

      this.updateInProgressSubject.next(false);
      this.resetDownloadStatus();
      const result = await invoke<UpdateMetadata | null>('fetch_update', {
        channel: this.updateChannelSubject.value,
      });

      if (result) {
        console.log('Update available:', result.version, 'Release tag:', result.releaseTag);
      } else {
        console.log('No update available for channel:', this.updateChannelSubject.value);
      }

      if (result && this.isVersionSkipped(result.version)) {
        console.log(`Update ${result.version} was skipped by user`);
        return null;
      }

      this.updateAvailableSubject.next(result);

      if (result) {
        this.notificationService.showInfo(
          `Update available: ${result.version}. Please check the About dialog to install.`,
          'OK',
          10000
        );
      }

      return result;
    } catch (error) {
      console.error('Failed to check for updates:', error);
      this.notificationService.showError('Failed to check for updates');
      return null;
    }
  }

  async installUpdate(): Promise<void> {
    const update = this.updateAvailableSubject.value;
    if (!update) {
      this.notificationService.showWarning('No update available');
      return;
    }

    try {
      this.updateInProgressSubject.next(true);
      this.resetDownloadStatus();

      // Start polling for download status
      this.startStatusPolling();

      // Start the download/install process
      await invoke('install_update');

      // The polling will automatically detect when the download is complete
      // and handle the UI updates
    } catch (error) {
      console.error('Failed to install update:', error);
      this.notificationService.showError('Failed to install update');
      this.stopStatusPolling();
      this.updateInProgressSubject.next(false);
    }
  }

  private startStatusPolling(): void {
    this.stopStatusPolling();

    this.pollingSubscription = interval(this.statusPollingInterval)
      .pipe(
        takeWhile(() => this.updateInProgressSubject.value),
        debounceTime(100)
      )
      .subscribe(async () => {
        try {
          const status = await invoke<DownloadStatus>('get_download_status');
          this.downloadStatusSubject.next(status);

          // If backend reported a failure, stop polling and notify
          if (status.isFailed) {
            const msg = status.failureMessage || 'Update installation failed';
            this.notificationService.showError(msg);
            this.updateInProgressSubject.next(false);
            this.updateAvailableSubject.next(null);
            this.stopStatusPolling();
            return;
          }

          if (status.isComplete) {
            this.notificationService.showSuccess('Update downloaded successfully. Restarting...');
            this.updateInProgressSubject.next(false);
            this.updateAvailableSubject.next(null);
            this.stopStatusPolling();
          }
        } catch (error) {
          console.error('Error polling download status:', error);
        }
      });
  }

  private stopStatusPolling(): void {
    if (this.pollingSubscription) {
      this.pollingSubscription.unsubscribe();
      this.pollingSubscription = null;
    }
  }

  private resetDownloadStatus(): void {
    this.downloadStatusSubject.next({
      downloadedBytes: 0,
      totalBytes: 0,
      percentage: 0,
      isComplete: false,
    });
  }

  // Keep all your existing methods (skipVersion, getChannel, etc.) unchanged
  getUpdateAvailable(): UpdateMetadata | null {
    return this.updateAvailableSubject.value;
  }

  isUpdateInProgress(): boolean {
    return this.updateInProgressSubject.value;
  }

  async skipVersion(version: string): Promise<void> {
    try {
      const currentSkipped = await this.getSkippedVersions();
      if (!currentSkipped.includes(version)) {
        const newSkipped = [...currentSkipped, version];
        await this.appSettingsService.saveSetting('general', 'skipped_updates', newSkipped);
        this.skippedVersionsSubject.next(newSkipped);
        this.updateAvailableSubject.next(null);
        this.notificationService.showInfo(`Update ${version} will be skipped`);
      }
    } catch (error) {
      console.error('Failed to skip version:', error);
      this.notificationService.showError('Failed to skip update');
    }
  }

  async unskipVersion(version: string): Promise<void> {
    try {
      const currentSkipped = await this.getSkippedVersions();
      const newSkipped = currentSkipped.filter(v => v !== version);
      await this.appSettingsService.saveSetting('general', 'skipped_updates', newSkipped);
      this.skippedVersionsSubject.next(newSkipped);
    } catch (error) {
      console.error('Failed to unskip version:', error);
      this.notificationService.showError('Failed to unskip update');
    }
  }

  isVersionSkipped(version: string): boolean {
    return this.skippedVersionsSubject.value.includes(version);
  }

  async getSkippedVersions(): Promise<string[]> {
    try {
      const skipped = await this.appSettingsService.loadSettingValue('general', 'skipped_updates');
      return Array.isArray(skipped) ? skipped : [];
    } catch (error) {
      console.error('Failed to load skipped versions:', error);
      return [];
    }
  }

  async getAutoCheckEnabled(): Promise<boolean> {
    try {
      const enabled = await this.appSettingsService.loadSettingValue(
        'general',
        'auto_check_updates'
      );
      return enabled ?? true;
    } catch (error) {
      console.error('Failed to load auto-check setting:', error);
      return true;
    }
  }

  async setAutoCheckEnabled(enabled: boolean): Promise<void> {
    try {
      await this.appSettingsService.saveSetting('general', 'auto_check_updates', enabled);
    } catch (error) {
      console.error('Failed to save auto-check setting:', error);
      this.notificationService.showError('Failed to save update settings');
    }
  }

  getCurrentChannel(): string {
    return this.updateChannelSubject.value;
  }

  async setChannel(channel: string): Promise<void> {
    try {
      await this.appSettingsService.saveSetting('general', 'update_channel', channel);
      this.updateChannelSubject.next(channel);
      this.notificationService.showInfo(`Update channel changed to ${channel}`);
    } catch (error) {
      console.error('Failed to save update channel:', error);
      this.notificationService.showError('Failed to save update channel');
    }
  }

  async getChannel(): Promise<string> {
    try {
      const channel = await this.appSettingsService.loadSettingValue('general', 'update_channel');
      return channel || 'stable';
    } catch (error) {
      console.error('Failed to load update channel:', error);
      return 'stable';
    }
  }

  async initialize(): Promise<void> {
    try {
      const skippedVersions = await this.getSkippedVersions();
      this.skippedVersionsSubject.next(skippedVersions);

      const channel = await this.getChannel();
      this.updateChannelSubject.next(channel);
    } catch (error) {
      console.error('Failed to initialize skipped versions:', error);
    }
  }
}
