import { Injectable, inject } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { BehaviorSubject } from 'rxjs';
import { NotificationService } from '../../shared/services/notification.service';
import { AppSettingsService } from '../settings/app-settings.service';

export interface UpdateMetadata {
  version: string;
  currentVersion: string;
}

export interface DownloadEvent {
  event: 'Started' | 'Progress' | 'Finished';
  data?: {
    contentLength?: number;
    chunkLength?: number;
  };
}

@Injectable({
  providedIn: 'root',
})
export class AppUpdaterService {
  private notificationService = inject(NotificationService);
  private appSettingsService = inject(AppSettingsService);

  private updateAvailableSubject = new BehaviorSubject<UpdateMetadata | null>(null);
  private updateInProgressSubject = new BehaviorSubject<boolean>(false);
  private downloadProgressSubject = new BehaviorSubject<number>(0);
  private skippedVersionsSubject = new BehaviorSubject<string[]>([]);
  private updateChannelSubject = new BehaviorSubject<string>('stable');

  public updateAvailable$ = this.updateAvailableSubject.asObservable();
  public updateInProgress$ = this.updateInProgressSubject.asObservable();
  public downloadProgress$ = this.downloadProgressSubject.asObservable();
  public skippedVersions$ = this.skippedVersionsSubject.asObservable();
  public updateChannel$ = this.updateChannelSubject.asObservable();

  constructor() {
    this.initialize();
  }

  async checkForUpdates(): Promise<UpdateMetadata | null> {
    try {
      this.updateInProgressSubject.next(false);
      this.downloadProgressSubject.next(0);

      const result = await invoke<UpdateMetadata | null>('fetch_update', {
        channel: this.updateChannelSubject.value,
      });

      // Check if this version was skipped
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
      this.downloadProgressSubject.next(0);

      await invoke('install_update', {
        onEvent: (event: DownloadEvent) => {
          console.log('Download event:', event);

          switch (event.event) {
            case 'Started':
              this.notificationService.showInfo(
                `Downloading update... (${event.data?.contentLength} bytes)`
              );
              break;
            case 'Progress':
              if (event.data?.chunkLength) {
                const currentProgress = this.downloadProgressSubject.value;
                this.downloadProgressSubject.next(currentProgress + event.data.chunkLength);
              }
              break;
            case 'Finished':
              this.notificationService.showSuccess('Update downloaded successfully. Restarting...');
              this.updateInProgressSubject.next(false);
              this.updateAvailableSubject.next(null);
              break;
          }
        },
      });
    } catch (error) {
      console.error('Failed to install update:', error);
      this.notificationService.showError('Failed to install update');
      this.updateInProgressSubject.next(false);
    }
  }

  getUpdateAvailable(): UpdateMetadata | null {
    return this.updateAvailableSubject.value;
  }

  isUpdateInProgress(): boolean {
    return this.updateInProgressSubject.value;
  }

  getDownloadProgress(): number {
    return this.downloadProgressSubject.value;
  }

  // Skip version functionality
  async skipVersion(version: string): Promise<void> {
    try {
      const currentSkipped = await this.getSkippedVersions();
      if (!currentSkipped.includes(version)) {
        const newSkipped = [...currentSkipped, version];
        await this.appSettingsService.saveSetting('general', 'skipped_updates', newSkipped);
        this.skippedVersionsSubject.next(newSkipped);
        this.updateAvailableSubject.next(null); // Clear current update if it was skipped
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

  // Auto-check settings
  async getAutoCheckEnabled(): Promise<boolean> {
    try {
      const enabled = await this.appSettingsService.loadSettingValue(
        'general',
        'auto_check_updates'
      );
      return enabled ?? true; // Default to true
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

  // Channel management
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
      return channel || 'stable'; // Default to stable
    } catch (error) {
      console.error('Failed to load update channel:', error);
      return 'stable';
    }
  }

  // Initialize skipped versions on service creation
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
