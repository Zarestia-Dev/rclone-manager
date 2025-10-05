import { Injectable, inject } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { BehaviorSubject, interval, Subscription } from 'rxjs';
import { debounceTime, takeWhile } from 'rxjs/operators';
import { NotificationService } from '../../shared/services/notification.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { UpdateStateService } from './update-state.service';
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
  private updateStateService = inject(UpdateStateService);

  private updateAvailableSubject = new BehaviorSubject<UpdateMetadata | null>(null);
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
  private initialized = false;

  public updateAvailable$ = this.updateAvailableSubject.asObservable();
  public updateInProgress$ = this.updateStateService.updateInProgress$;
  public downloadStatus$ = this.downloadStatusSubject.asObservable();
  public skippedVersions$ = this.skippedVersionsSubject.asObservable();
  public updateChannel$ = this.updateChannelSubject.asObservable();
  public updatesDisabled$ = this.updateStateService.updatesDisabled$;
  public buildType$ = this.updateStateService.buildType$;
  public updateState$ = this.updateStateService.updateState$;

  async checkForUpdates(): Promise<UpdateMetadata | null> {
    try {
      // Ensure initialization
      await this.ensureInitialized();

      console.log('Checking for updates on channel:', this.updateChannelSubject.value);

      this.updateStateService.setUpdateInProgress(false);
      this.resetDownloadStatus();

      // Check if updates are disabled (use cached value)
      if (this.areUpdatesDisabled()) {
        console.log('Updates are disabled for this build type');
        return null;
      }

      const result = await invoke<UpdateMetadata | null>('fetch_update', {
        channel: this.updateChannelSubject.value,
      });

      if (result) {
        console.log('Update available:', result.version, 'Release tag:', result.releaseTag);

        // Check if version is skipped before setting as available
        if (this.isVersionSkipped(result.version)) {
          console.log(`Update ${result.version} was skipped by user`);
          return null;
        }

        this.updateAvailableSubject.next(result);
        this.updateStateService.setHasUpdates(true);
        this.notificationService.showInfo(
          `Update available: ${result.version}. Please check the About dialog to install.`,
          'OK',
          10000
        );
      } else {
        console.log('No update available for channel:', this.updateChannelSubject.value);
        this.updateAvailableSubject.next(null);
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
      this.updateStateService.setUpdateInProgress(true);
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
      this.updateStateService.setUpdateInProgress(false);
    }
  }

  private startStatusPolling(): void {
    this.stopStatusPolling();

    this.pollingSubscription = interval(this.statusPollingInterval)
      .pipe(
        takeWhile(() => this.updateStateService.isUpdateInProgress()),
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
            this.updateStateService.setUpdateInProgress(false);
            this.updateAvailableSubject.next(null);
            this.updateStateService.setHasUpdates(false);
            this.stopStatusPolling();
            return;
          }

          if (status.isComplete) {
            this.notificationService.showSuccess('Update downloaded successfully. Restarting...');
            this.updateStateService.setUpdateInProgress(false);
            this.updateAvailableSubject.next(null);
            this.updateStateService.setHasUpdates(false);
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

  getUpdateAvailable(): UpdateMetadata | null {
    return this.updateAvailableSubject.value;
  }

  isUpdateInProgress(): boolean {
    return this.updateStateService.isUpdateInProgress();
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

      // Clear update status when channel is changed
      this.updateAvailableSubject.next(null);
      this.updateStateService.setHasUpdates(false);
      this.resetDownloadStatus();

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
    return this.ensureInitialized();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      // Load all initial state in parallel
      const [skippedVersions, channel, updatesDisabled, buildType] = await Promise.all([
        this.getSkippedVersions(),
        this.getChannel(),
        this.checkIfUpdatesDisabled(),
        invoke<string>('get_build_type'),
      ]);

      this.skippedVersionsSubject.next(skippedVersions);
      this.updateChannelSubject.next(channel);
      this.updateStateService.setUpdatesDisabled(updatesDisabled);
      this.updateStateService.setBuildType(buildType);

      this.initialized = true;
    } catch (error) {
      console.error('Failed to initialize updater service:', error);
      // Set defaults on error
      this.skippedVersionsSubject.next([]);
      this.updateChannelSubject.next('stable');
      this.updateStateService.setUpdatesDisabled(false);
      this.updateStateService.setBuildType(null);
    }
  }

  private async checkIfUpdatesDisabled(): Promise<boolean> {
    try {
      return await invoke<boolean>('are_updates_disabled');
    } catch (error) {
      console.error('Failed to check if updates are disabled:', error);
      return false; // Default to allowing updates if check fails
    }
  }

  public areUpdatesDisabled(): boolean {
    return this.updateStateService.areUpdatesDisabled();
  }

  public getBuildType(): string | null {
    return this.updateStateService.getBuildType();
  }
}
