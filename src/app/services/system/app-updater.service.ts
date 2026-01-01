import { Injectable, inject } from '@angular/core';
import {
  BehaviorSubject,
  Observable,
  combineLatest,
  interval,
  Subscription,
  firstValueFrom,
} from 'rxjs';
import { map, takeWhile } from 'rxjs/operators';
import { NotificationService } from '@app/services';
import { AppSettingsService } from '../settings/app-settings.service';
import { UpdateMetadata } from '@app/types';
import { TauriBaseService } from '../core/tauri-base.service';
import { UiStateService } from '../ui/ui-state.service';
import { MatDialog } from '@angular/material/dialog';
import { ConfirmModalComponent } from '../../shared/modals/confirm-modal/confirm-modal.component';

export interface DownloadStatus {
  downloadedBytes: number;
  totalBytes: number;
  percentage: number;
  isComplete: boolean;
  isFailed?: boolean;
  failureMessage?: string | null;
}

export interface UpdateState {
  isSupported: boolean;
  buildType: string | null;
  hasUpdates: boolean;
  isUpdateInProgress: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class AppUpdaterService extends TauriBaseService {
  private notificationService = inject(NotificationService);
  private appSettingsService = inject(AppSettingsService);
  private uiStateService = inject(UiStateService);
  private dialog = inject(MatDialog);

  // Update state subjects (previously in UpdateStateService)
  private buildTypeSubject = new BehaviorSubject<string | null>(null);
  private updatesDisabledSubject = new BehaviorSubject<boolean>(false);
  private hasUpdatesSubject = new BehaviorSubject<boolean>(false);
  private updateInProgressSubject = new BehaviorSubject<boolean>(false);

  private updateAvailableSubject = new BehaviorSubject<UpdateMetadata | null>(null);
  private downloadStatusSubject = new BehaviorSubject<DownloadStatus>({
    downloadedBytes: 0,
    totalBytes: 0,
    percentage: 0,
    isComplete: false,
  });
  private skippedVersionsSubject = new BehaviorSubject<string[]>([]);
  private updateChannelSubject = new BehaviorSubject<string>('stable');
  private restartRequiredSubject = new BehaviorSubject<boolean>(false);

  private statusPollingInterval = 500;
  private pollingSubscription: Subscription | null = null;
  private initialized = false;

  // Public observables
  public buildType$ = this.buildTypeSubject.asObservable();
  public updatesDisabled$ = this.updatesDisabledSubject.asObservable();
  public hasUpdates$ = this.hasUpdatesSubject.asObservable();
  public updateInProgress$ = this.updateInProgressSubject.asObservable();
  public updateAvailable$ = this.updateAvailableSubject.asObservable();
  public downloadStatus$ = this.downloadStatusSubject.asObservable();
  public skippedVersions$ = this.skippedVersionsSubject.asObservable();
  public updateChannel$ = this.updateChannelSubject.asObservable();
  public restartRequired$ = this.restartRequiredSubject.asObservable();

  /**
   * Combined state observable that provides all update-related information
   */
  public updateState$: Observable<UpdateState> = combineLatest([
    this.buildType$,
    this.updatesDisabled$,
    this.hasUpdates$,
    this.updateInProgress$,
  ]).pipe(
    map(([buildType, updatesDisabled, hasUpdates, updateInProgress]) => ({
      isSupported: !updatesDisabled,
      buildType,
      hasUpdates: hasUpdates && !updatesDisabled,
      isUpdateInProgress: updateInProgress && !updatesDisabled,
    }))
  );

  async checkForUpdates(): Promise<UpdateMetadata | null> {
    try {
      await this.ensureInitialized();

      console.debug('Checking for updates on channel:', this.updateChannelSubject.value);

      this.updateInProgressSubject.next(false);
      this.resetDownloadStatus();

      // Check if updates are disabled (use cached value)
      if (this.areUpdatesDisabled()) {
        console.debug('Updates are disabled for this build type');
        return null;
      }

      const result = await this.invokeCommand<UpdateMetadata | null>('fetch_update', {
        channel: this.updateChannelSubject.value,
      });

      if (result) {
        console.debug('Update available:', result.version, 'Release tag:', result.releaseTag);

        // If restart is required, set flag and return
        if (result.restartRequired) {
          console.debug('Restart is required');
          this.restartRequiredSubject.next(true);
          return null;
        }

        // If update is already in progress, restore the UI state
        if (result.updateInProgress) {
          console.debug('Update is already in progress, restoring UI state');
          this.updateAvailableSubject.next(result);
          this.updateInProgressSubject.next(true);
          this.hasUpdatesSubject.next(true);
          this.startStatusPolling();
          return result;
        }

        // Check if version is skipped before setting as available
        if (this.isVersionSkipped(result.version)) {
          console.debug(`Update ${result.version} was skipped by user`);
          return null;
        }

        this.updateAvailableSubject.next(result);
        this.hasUpdatesSubject.next(true);
        this.notificationService.showInfo(
          `Update available: ${result.version}. Please check the About dialog to install.`,
          'OK',
          10000
        );
      } else {
        console.debug('No update available for channel:', this.updateChannelSubject.value);
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
      if (this.uiStateService.platform === 'windows') {
        const dialogRef = this.dialog.open(ConfirmModalComponent, {
          data: {
            title: 'Install Update',
            message:
              'Installing this update will restart the application automatically. Do you want to continue?',
            confirmText: 'Install',
            cancelText: 'Cancel',
            hideCancel: false,
          },
          disableClose: true,
        });

        const confirmed = await firstValueFrom(dialogRef.afterClosed());
        if (!confirmed) {
          return;
        }
      }

      this.updateInProgressSubject.next(true);
      this.resetDownloadStatus();

      // Start polling for download status
      this.startStatusPolling();

      // Start the download/install process
      await this.invokeCommand('install_update');

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
      .pipe(takeWhile(() => this.isUpdateInProgress()))
      .subscribe(async () => {
        try {
          const status = await this.invokeCommand<DownloadStatus>('get_download_status');
          this.downloadStatusSubject.next(status);

          // If backend reported a failure, stop polling and notify
          if (status.isFailed) {
            const msg = status.failureMessage || 'Update installation failed';
            this.notificationService.showError(msg);
            this.updateInProgressSubject.next(false);
            this.updateAvailableSubject.next(null);
            this.hasUpdatesSubject.next(false);
            this.stopStatusPolling();
            return;
          }

          if (status.isComplete) {
            this.handleUpdateComplete();
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

  private handleUpdateComplete(): void {
    this.updateInProgressSubject.next(false);
    this.updateAvailableSubject.next(null);
    this.hasUpdatesSubject.next(false);
    this.stopStatusPolling();

    if (this.uiStateService.platform !== 'windows') {
      // Linux/MacOS: Set flag and show notification
      this.restartRequiredSubject.next(true);
      this.notificationService.showSuccess('Update installed. Please restart the app.');
    } else {
      // Windows: the updater will auto-restart the application; no need for a modal here
      // Optionally, we could show a brief toast if required but we don't display a dialog now.
    }
  }

  async relaunchApp(): Promise<void> {
    try {
      await this.invokeCommand('relaunch_app');
    } catch (error) {
      console.error('Failed to relaunch:', error);
      this.notificationService.showError('Failed to restart application');
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
    return this.updateInProgressSubject.value && !this.updatesDisabledSubject.value;
  }

  async skipVersion(version: string): Promise<void> {
    try {
      const currentSkipped = await this.getSkippedVersions();
      if (!currentSkipped.includes(version)) {
        const newSkipped = [...currentSkipped, version];
        await this.appSettingsService.saveSetting('runtime', 'app_skipped_updates', newSkipped);
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
      await this.appSettingsService.saveSetting('runtime', 'app_skipped_updates', newSkipped);
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
      const skipped = await this.appSettingsService.getSettingValue<string[]>(
        'runtime.app_skipped_updates'
      );
      return Array.isArray(skipped) ? skipped : [];
    } catch (error) {
      console.error('Failed to load skipped versions:', error);
      return [];
    }
  }

  async getAutoCheckEnabled(): Promise<boolean> {
    try {
      const enabled = await this.appSettingsService.getSettingValue<boolean>(
        'runtime.app_auto_check_updates'
      );
      return enabled ?? true;
    } catch (error) {
      console.error('Failed to load auto-check setting:', error);
      return true;
    }
  }

  async setAutoCheckEnabled(enabled: boolean): Promise<void> {
    try {
      await this.appSettingsService.saveSetting('runtime', 'app_auto_check_updates', enabled);
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
      await this.appSettingsService.saveSetting('runtime', 'app_update_channel', channel);
      this.updateChannelSubject.next(channel);

      // Clear update status when channel is changed
      this.updateAvailableSubject.next(null);
      this.hasUpdatesSubject.next(false);
      this.resetDownloadStatus();

      this.notificationService.showInfo(`Update channel changed to ${channel}`);
    } catch (error) {
      console.error('Failed to save update channel:', error);
      this.notificationService.showError('Failed to save update channel');
    }
  }

  async getChannel(): Promise<string> {
    try {
      const channel = await this.appSettingsService.getSettingValue<string>(
        'runtime.app_update_channel'
      );
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
      const [skippedVersions, channel, updatesDisabled] = await Promise.all([
        this.getSkippedVersions(),
        this.getChannel(),
        this.checkIfUpdatesDisabled(),
      ]);

      this.buildTypeSubject.next(await this.getBuildType());
      this.skippedVersionsSubject.next(skippedVersions);
      this.updateChannelSubject.next(channel);
      this.updatesDisabledSubject.next(updatesDisabled);

      this.initialized = true;

      const autoCheck = await this.getAutoCheckEnabled();
      if (autoCheck && !updatesDisabled) {
        console.debug('Auto-check enabled, checking for app updates...');
        this.checkForUpdates();
      }
    } catch (error) {
      console.error('Failed to initialize updater service:', error);
      // Set defaults on error
      this.skippedVersionsSubject.next([]);
      this.updateChannelSubject.next('stable');
      this.updatesDisabledSubject.next(false);
      this.buildTypeSubject.next(null);
    }
  }

  private async checkIfUpdatesDisabled(): Promise<boolean> {
    try {
      return await this.invokeCommand<boolean>('are_updates_disabled');
    } catch (error) {
      console.error('Failed to check if updates are disabled:', error);
      return false; // Default to allowing updates if check fails
    }
  }

  public areUpdatesDisabled(): boolean {
    return this.updatesDisabledSubject.value;
  }

  public async getBuildType(): Promise<string> {
    return this.invokeCommand<string>('get_build_type');
  }
}
