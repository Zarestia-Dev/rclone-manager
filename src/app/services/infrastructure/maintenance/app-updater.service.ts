import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { interval, Subject, Subscription, firstValueFrom } from 'rxjs';
import { map, takeWhile, filter, takeUntil } from 'rxjs/operators';
import { UiStateService } from '../../ui/state/ui-state.service';
import { EventListenersService } from '../system/event-listeners.service';
import { DebugService } from '@app/services';
import { UpdateMetadata } from '@app/types';
import { BaseUpdateService } from '../maintenance/base-update.service';
import { MatDialog } from '@angular/material/dialog';
import { ConfirmModalComponent } from '../../../shared/modals/confirm-modal/confirm-modal.component';

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
export class AppUpdaterService extends BaseUpdateService implements OnDestroy {
  private uiStateService = inject(UiStateService);
  private dialog = inject(MatDialog);
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
  private readonly _restartRequired = signal<boolean>(false);

  // Public readonly signals
  public readonly buildType = this._buildType.asReadonly();
  public readonly updatesDisabled = this._updatesDisabled.asReadonly();
  public readonly hasUpdates = this._hasUpdates.asReadonly();
  public readonly updateInProgress = this._updateInProgress.asReadonly();
  public readonly updateAvailable = this._updateAvailable.asReadonly();
  public readonly downloadStatus = this._downloadStatus.asReadonly();
  public readonly restartRequired = this._restartRequired.asReadonly();

  protected override get skippedVersionsKey(): string { return 'runtime.app_skipped_updates'; }
  protected override get updateChannelKey(): string { return 'runtime.app_update_channel'; }
  protected override get autoCheckKey(): string { return 'runtime.app_auto_check_updates'; }

  private statusPollingInterval = 500;
  private pollingSubscription: Subscription | null = null;
  private initialized = false;

  async checkForUpdates(): Promise<UpdateMetadata | null> {
    try {
      await this.ensureInitialized();
      console.debug('Checking for updates on channel:', this.updateChannel());

      this._updateInProgress.set(false);
      this.resetDownloadStatus();

      if (this.areUpdatesDisabled()) {
        console.debug('Updates are disabled for this build type');
        return null;
      }

      const result = await this.invokeCommand<UpdateMetadata | null>('fetch_update', {
        channel: this.updateChannel(),
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
        if (!confirmed) return;
      }

      this._updateInProgress.set(true);
      this.resetDownloadStatus();
      this.startStatusPolling();

      await this.invokeWithNotification('install_update', undefined, {
        errorKey: 'updates.installFailed',
        showSuccess: false,
      });
    } catch (error) {
      console.error('Failed to install update:', error);
      this.stopStatusPolling();
      this._updateInProgress.set(false);
      this.resetDownloadStatus();

      const errorMessage = String(error);
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
      if (this._restartRequired()) {
        await this.invokeWithNotification('apply_app_update', undefined, {
          errorKey: 'updates.restartFailed',
          showSuccess: false,
        });
      } else {
        await this.debugService.restartApp();
      }
    } catch (error) {
      console.error('Failed to relaunch:', error);
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

  override async skipVersion(version: string): Promise<void> {
    await super.skipVersion(version, 'updates.skipVersion');
    this._updateAvailable.set(null);
  }

  override async unskipVersion(version: string): Promise<void> {
    await super.unskipVersion(version);
    await this.checkForUpdates();
  }

  getCurrentChannel(): string {
    return this.updateChannel();
  }

  override async setChannel(channel: string): Promise<void> {
    await super.setChannel(channel, 'updates.channelChanged');

    // Clear update status when channel is changed
    this._updateAvailable.set(null);
    this._hasUpdates.set(false);
    this.resetDownloadStatus();
  }

  async initialize(): Promise<void> {
    return this.ensureInitialized();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      // Initialize base settings
      await this.initBaseSettings();

      this._buildType.set(await this.getBuildType());
      this._updatesDisabled.set(await this.checkIfUpdatesDisabled());

      this.initialized = true;

      if (!this._updatesDisabled()) {
        // Attempt to pick up an update check on startup if auto-check is enabled
        const autoCheck = this.autoCheckEnabled();
        if (autoCheck) {
          const cachedUpdate = await this.invokeCommand<UpdateMetadata | null>('fetch_update', {
            channel: this.updateChannel(),
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
