import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { interval, Subject, Subscription, firstValueFrom } from 'rxjs';
import { map, takeWhile, filter, takeUntil } from 'rxjs/operators';
import { TranslateService } from '@ngx-translate/core';
import { DebugService, NotificationService } from '@app/services';
import { AppSettingsService } from '../settings/app-settings.service';
import { UpdateMetadata } from '@app/types';
import { TauriBaseService } from '../core/tauri-base.service';
import { UiStateService } from '../ui/ui-state.service';
import { EventListenersService } from './event-listeners.service';
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
export class AppUpdaterService extends TauriBaseService implements OnDestroy {
  private notificationService = inject(NotificationService);
  private appSettingsService = inject(AppSettingsService);
  private uiStateService = inject(UiStateService);
  private dialog = inject(MatDialog);
  private translate = inject(TranslateService);
  private eventListenersService = inject(EventListenersService);
  private debugService = inject(DebugService);

  private destroy$ = new Subject<void>();

  // Update state signals
  private readonly _buildType = signal<string | null>(null);
  private readonly _updatesDisabled = signal<boolean>(false);
  private readonly _hasUpdates = signal<boolean>(false);
  private readonly _updateInProgress = signal<boolean>(false);

  private readonly _updateAvailable = signal<UpdateMetadata | null>(null);
  private readonly _downloadStatus = signal<DownloadStatus>({
    downloadedBytes: 0,
    totalBytes: 0,
    percentage: 0,
    isComplete: false,
  });
  private readonly _skippedVersions = signal<string[]>([]);
  private readonly _updateChannel = signal<string>('stable');
  private readonly _restartRequired = signal<boolean>(false);

  // Public readonly signals
  public readonly buildType = this._buildType.asReadonly();
  public readonly updatesDisabled = this._updatesDisabled.asReadonly();
  public readonly hasUpdates = this._hasUpdates.asReadonly();
  public readonly updateInProgress = this._updateInProgress.asReadonly();
  public readonly updateAvailable = this._updateAvailable.asReadonly();
  public readonly downloadStatus = this._downloadStatus.asReadonly();
  public readonly skippedVersions = this._skippedVersions.asReadonly();
  public readonly updateChannel = this._updateChannel.asReadonly();
  public readonly restartRequired = this._restartRequired.asReadonly();

  private statusPollingInterval = 500;
  private pollingSubscription: Subscription | null = null;
  private initialized = false;

  async checkForUpdates(): Promise<UpdateMetadata | null> {
    try {
      await this.ensureInitialized();

      console.debug('Checking for updates on channel:', this._updateChannel());

      this._updateInProgress.set(false);
      this.resetDownloadStatus();

      // Check if updates are disabled (use cached value)
      if (this.areUpdatesDisabled()) {
        console.debug('Updates are disabled for this build type');
        return null;
      }

      const result = await this.invokeCommand<UpdateMetadata | null>('fetch_update', {
        channel: this._updateChannel(),
      });

      if (result) {
        console.debug('Update available:', result.version);

        if (result.restartRequired) {
          this._restartRequired.set(true);
          return null;
        }

        if (result.updateInProgress) {
          this._updateAvailable.set(result);
          this._updateInProgress.set(true);
          this._hasUpdates.set(true);
          this.startStatusPolling();
          return result;
        }

        if (this.isVersionSkipped(result.version)) {
          return null;
        }

        this._updateAvailable.set(result);
        this._hasUpdates.set(true);
        this.notificationService.showInfo(
          this.translate.instant('updates.availableNotification', { version: result.version }),
          this.translate.instant('common.ok'),
          10000
        );
      } else {
        this._updateAvailable.set(null);
      }

      return result;
    } catch (error) {
      console.error('Failed to check for updates:', error);
      this.notificationService.showError(this.translate.instant('updates.checkFailed'));
      return null;
    }
  }

  async installUpdate(): Promise<void> {
    const update = this._updateAvailable();
    if (!update) {
      this.notificationService.showWarning(this.translate.instant('updates.noUpdateAvailable'));
      return;
    }

    try {
      if (this.uiStateService.platform === 'windows') {
        const dialogRef = this.dialog.open(ConfirmModalComponent, {
          data: {
            title: this.translate.instant('updates.confirmInstall.title'),
            message: this.translate.instant('updates.confirmInstall.message'),
            confirmText: this.translate.instant('updates.confirmInstall.confirm'),
            cancelText: this.translate.instant('updates.confirmInstall.cancel'),
            hideCancel: false,
          },
          disableClose: true,
        });

        const confirmed = await firstValueFrom(dialogRef.afterClosed());
        if (!confirmed) {
          return;
        }
      }

      this._updateInProgress.set(true);
      this.resetDownloadStatus();

      this.startStatusPolling();
      await this.invokeCommand('install_update');
    } catch (error) {
      console.error('Failed to install update:', error);
      this.notificationService.showError(this.translate.instant('updates.installFailed'));
      this.stopStatusPolling();
      this._updateInProgress.set(false);
      this.resetDownloadStatus();

      const errorMessage = this.extractErrorMessage(error);
      if (this.isStaleUpdateError(errorMessage)) {
        this._updateAvailable.set(null);
        this._hasUpdates.set(false);
        await this.checkForUpdates();
      }
    }
  }

  private startStatusPolling(): void {
    this.stopStatusPolling();

    this.pollingSubscription = interval(this.statusPollingInterval)
      .pipe(takeWhile(() => this.isUpdateInProgress()))
      .subscribe(async () => {
        try {
          const status = await this.invokeCommand<DownloadStatus>('get_download_status');
          this._downloadStatus.set(status);

          // If backend reported a failure, stop polling and notify
          if (status.isFailed) {
            const msg = status.failureMessage || this.translate.instant('updates.installFailed');
            this.notificationService.showError(msg);
            this._updateInProgress.set(false);
            // Keep update metadata available so user can retry immediately
            this.stopStatusPolling();
            this.resetDownloadStatus();

            if (this.isStaleUpdateError(msg)) {
              this._updateAvailable.set(null);
              this._hasUpdates.set(false);
              await this.checkForUpdates();
            }
            return;
          }

          if (status.isComplete) {
            this.handleUpdateComplete();
          }
        } catch (error) {
          console.error('Error polling download status:', error);
          this.stopStatusPolling();
          this._updateInProgress.set(false);
          this.resetDownloadStatus();
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
    this._updateInProgress.set(false);
    this._updateAvailable.set(null);
    this._hasUpdates.set(false);
    this.stopStatusPolling();

    this._restartRequired.set(true);
    this.notificationService.showSuccess(this.translate.instant('updates.installSuccess'));
  }

  async finishUpdate(): Promise<void> {
    try {
      // Check if we are ready to restart with a pending app update
      if (this._restartRequired()) {
        await this.invokeCommand('apply_app_update');
      } else {
        this.debugService.restartApp();
      }
    } catch (error) {
      console.error('Failed to relaunch:', error);
      this.notificationService.showError(this.translate.instant('updates.restartFailed'));
    }
  }

  private resetDownloadStatus(): void {
    this._downloadStatus.set({
      downloadedBytes: 0,
      totalBytes: 0,
      percentage: 0,
      isComplete: false,
      isFailed: false,
      failureMessage: null,
    });
  }

  private extractErrorMessage(error: unknown): string {
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  private isStaleUpdateError(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes('bekleyen güncelleme yok') ||
      normalized.includes('no pending update') ||
      normalized.includes('update unavailable') ||
      normalized.includes('no longer available')
    );
  }

  getUpdateAvailable(): UpdateMetadata | null {
    return this._updateAvailable();
  }

  isUpdateInProgress(): boolean {
    return this._updateInProgress() && !this._updatesDisabled();
  }

  async skipVersion(version: string): Promise<void> {
    try {
      const currentSkipped = await this.getSkippedVersions();
      if (!currentSkipped.includes(version)) {
        const newSkipped = [...currentSkipped, version];
        await this.appSettingsService.saveSetting('runtime', 'app_skipped_updates', newSkipped);
        this._skippedVersions.set(newSkipped);
        this._updateAvailable.set(null);
        this.notificationService.showInfo(
          this.translate.instant('updates.skipVersion', { version })
        );
      }
    } catch (error) {
      console.error('Failed to skip version:', error);
      this.notificationService.showError(this.translate.instant('updates.skipFailed'));
    }
  }

  async unskipVersion(version: string): Promise<void> {
    try {
      const currentSkipped = await this.getSkippedVersions();
      const newSkipped = currentSkipped.filter(v => v !== version);
      await this.appSettingsService.saveSetting('runtime', 'app_skipped_updates', newSkipped);
      this._skippedVersions.set(newSkipped);
      await this.checkForUpdates();
    } catch (error) {
      console.error('Failed to unskip version:', error);
      this.notificationService.showError(this.translate.instant('updates.unskipFailed'));
    }
  }

  isVersionSkipped(version: string): boolean {
    return this._skippedVersions().includes(version);
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
      this.notificationService.showError(this.translate.instant('updates.saveSettingsFailed'));
    }
  }

  getCurrentChannel(): string {
    return this._updateChannel();
  }

  async setChannel(channel: string): Promise<void> {
    try {
      await this.appSettingsService.saveSetting('runtime', 'app_update_channel', channel);
      this._updateChannel.set(channel);

      // Clear update status when channel is changed
      this._updateAvailable.set(null);
      this._hasUpdates.set(false);
      this.resetDownloadStatus();

      this.notificationService.showInfo(
        this.translate.instant('updates.channelChanged', { channel })
      );
    } catch (error) {
      console.error('Failed to save update channel:', error);
      this.notificationService.showError(this.translate.instant('updates.saveChannelFailed'));
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

      this._buildType.set(await this.getBuildType());
      this._skippedVersions.set(skippedVersions);
      this._updateChannel.set(channel);
      this._updatesDisabled.set(updatesDisabled);

      this.initialized = true;

      if (!updatesDisabled) {
        // Attempt to pick up an update check on startup if auto-check is enabled
        const autoCheck = await this.getAutoCheckEnabled();
        if (autoCheck) {
          const cachedUpdate = await this.invokeCommand<UpdateMetadata | null>('fetch_update', {
            channel,
          });
          if (cachedUpdate && !this.isVersionSkipped(cachedUpdate.version)) {
            if (cachedUpdate.restartRequired) {
              this._restartRequired.set(true);
            } else {
              this._updateAvailable.set(cachedUpdate);
              this._hasUpdates.set(true);
              if (cachedUpdate.updateInProgress) {
                this._updateInProgress.set(true);
                this.startStatusPolling();
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('Failed to initialize updater service:', error);
      // Set defaults on error
      this._skippedVersions.set([]);
      this._updateChannel.set('stable');
      this._updatesDisabled.set(false);
      this._buildType.set(null);
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
    return this._updatesDisabled();
  }

  constructor() {
    super();
    this.setupEventListeners();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.stopStatusPolling();
  }

  private setupEventListeners(): void {
    this.eventListenersService
      .listenToAppEvents()
      .pipe(
        takeUntil(this.destroy$),
        filter(event => event.status === 'update_found' && !!event.data),
        map(event => event.data as UpdateMetadata)
      )
      .subscribe(metadata => {
        console.debug('Received update found event:', metadata);
        // Only trigger if we haven't already processed this update
        const current = this._updateAvailable();
        if (!current || current.version !== metadata.version) {
          // Check if skipped
          if (this.isVersionSkipped(metadata.version)) {
            console.debug(`Skipping update ${metadata.version} as requested by user.`);
            return;
          }

          this._updateAvailable.set(metadata);
          this._hasUpdates.set(true);

          // Show notification if not already shown
          this.notificationService.showInfo(
            this.translate.instant('updates.availableNotification', {
              version: metadata.version,
            }),
            this.translate.instant('common.ok'),
            10000
          );
        }
      });
  }

  public async getBuildType(): Promise<string> {
    const currentBuildType = this._buildType();
    if (currentBuildType) {
      return currentBuildType;
    }
    return this.invokeCommand<string>('get_build_type');
  }
}
