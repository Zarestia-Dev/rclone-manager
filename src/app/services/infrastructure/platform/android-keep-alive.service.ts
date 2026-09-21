import { DestroyRef, effect, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TauriBaseService } from './tauri-base.service';
import { isAndroid } from './api-client.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { MountManagementService } from '../../operations/mount-management.service';
import { JobManagementService } from '../../operations/job-management.service';
import { ServeManagementService } from '../../operations/serve-management.service';

export interface AndroidNativeKeepAliveBridge {
  isBatteryOptimizationIgnored?: () => boolean;
  requestIgnoreBatteryOptimizations?: () => void;
  startKeepAliveService?: (force?: boolean) => void;
  stopKeepAliveService?: (force?: boolean) => void;
  isKeepAliveServiceRunning?: () => boolean;
  updateKeepAliveNotification?: (title: string, text: string) => void;
}

const getBridge = (): AndroidNativeKeepAliveBridge | undefined =>
  (window as Window & { __rclone__?: AndroidNativeKeepAliveBridge }).__rclone__;

@Injectable({
  providedIn: 'root',
})
export class AndroidKeepAliveService extends TauriBaseService {
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly mountManagement = inject(MountManagementService);
  private readonly jobManagement = inject(JobManagementService);
  private readonly serveManagement = inject(ServeManagementService);
  private readonly destroyRef = inject(DestroyRef);

  readonly isKeepAliveSettingEnabled = signal<boolean>(true);
  readonly isBatteryOptimizationIgnored = signal<boolean>(true);
  private _isServiceRunning = false;

  isServiceRunning(): boolean {
    return this._isServiceRunning;
  }

  private initialized = false;
  private lastSyncedShouldRun: boolean | null = null;
  private lastSyncedKeepAliveSetting: boolean | null = null;
  private lastSyncedNotificationText: string | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();

    this.destroyRef.onDestroy(() => {
      if (this.syncTimer) {
        clearTimeout(this.syncTimer);
        this.syncTimer = null;
      }
    });

    effect(() => {
      if (!this.initialized) return;

      const keepAliveSetting = this.isKeepAliveSettingEnabled();
      const mountsCount = this.mountManagement.mountedRemotes().length;
      const jobsCount = this.jobManagement.activeJobs().length;
      const servesCount = this.serveManagement.runningServes().length;

      const shouldRun = keepAliveSetting || mountsCount > 0 || jobsCount > 0 || servesCount > 0;
      this.scheduleSyncServiceState(
        shouldRun,
        keepAliveSetting,
        mountsCount,
        jobsCount,
        servesCount
      );
    });
  }

  initialize(): void {
    if (!this.isTauri || !isAndroid() || this.initialized) {
      return;
    }
    this.initialized = true;

    this.refreshBatteryOptimizationStatus();

    this.appSettingsService
      .selectSetting('general.keep_alive')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(setting => {
        if (setting?.value !== undefined) {
          this.isKeepAliveSettingEnabled.set(Boolean(setting.value));
        }
      });
  }

  refreshBatteryOptimizationStatus(): void {
    const bridge = getBridge();
    if (bridge?.isBatteryOptimizationIgnored) {
      try {
        const ignored = bridge.isBatteryOptimizationIgnored();
        this.isBatteryOptimizationIgnored.set(ignored);
      } catch (err) {
        console.error('[AndroidKeepAliveService] Failed to check battery optimization:', err);
      }
    }
  }

  requestIgnoreBatteryOptimizations(): void {
    const bridge = getBridge();
    if (bridge?.requestIgnoreBatteryOptimizations) {
      try {
        bridge.requestIgnoreBatteryOptimizations();
      } catch (err) {
        console.error(
          '[AndroidKeepAliveService] Failed to request battery optimization ignore:',
          err
        );
      }
    }
  }

  async toggleKeepAliveSetting(enabled: boolean): Promise<void> {
    this.isKeepAliveSettingEnabled.set(enabled);
    try {
      await this.appSettingsService.saveSetting('general', 'keep_alive', enabled);
    } catch (err) {
      console.error('[AndroidKeepAliveService] Failed to save keep_alive setting:', err);
    }
  }

  private buildNotificationText(
    mountsCount: number,
    jobsCount: number,
    servesCount: number
  ): string {
    const summaryParts: string[] = [];
    if (jobsCount > 0) {
      summaryParts.push(`${jobsCount} active jobs`);
    }
    if (mountsCount > 0) {
      summaryParts.push(`${mountsCount} mounted`);
    }
    if (servesCount > 0) {
      summaryParts.push(`${servesCount} serves`);
    }

    const defaultLabel =
      this.translate.instant('settings.general.keep_alive.label') || 'Running in background';
    return summaryParts.length > 0 ? summaryParts.join(' • ') : defaultLabel;
  }

  private scheduleSyncServiceState(
    shouldRun: boolean,
    keepAliveSetting: boolean,
    mountsCount: number,
    jobsCount: number,
    servesCount: number
  ): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }

    // On initial synchronization, execute immediately
    if (this.lastSyncedShouldRun === null) {
      this.syncServiceState(shouldRun, keepAliveSetting, mountsCount, jobsCount, servesCount);
      return;
    }

    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.syncServiceState(shouldRun, keepAliveSetting, mountsCount, jobsCount, servesCount);
    }, 500);
  }

  private syncServiceState(
    shouldRun: boolean,
    keepAliveSetting: boolean,
    mountsCount: number,
    jobsCount: number,
    servesCount: number
  ): void {
    const bridge = getBridge();
    if (!bridge) return;

    const notificationText = this.buildNotificationText(mountsCount, jobsCount, servesCount);

    const shouldRunChanged = this.lastSyncedShouldRun !== shouldRun;
    const keepAliveSettingChanged = this.lastSyncedKeepAliveSetting !== keepAliveSetting;
    const notificationChanged = this.lastSyncedNotificationText !== notificationText;

    if (!shouldRunChanged && !keepAliveSettingChanged && !notificationChanged) {
      return;
    }

    if (shouldRun) {
      try {
        if (shouldRunChanged || keepAliveSettingChanged) {
          bridge.startKeepAliveService?.(keepAliveSetting);
          this._isServiceRunning = true;
          this.lastSyncedKeepAliveSetting = keepAliveSetting;
        }

        if (notificationChanged) {
          bridge.updateKeepAliveNotification?.('RClone Manager', notificationText);
          this.lastSyncedNotificationText = notificationText;
        }
      } catch (err) {
        console.error('[AndroidKeepAliveService] Error starting keep-alive service:', err);
      }
    } else {
      try {
        if (shouldRunChanged) {
          bridge.stopKeepAliveService?.(true);
          this._isServiceRunning = false;
          this.lastSyncedNotificationText = null;
          this.lastSyncedKeepAliveSetting = null;
        }
      } catch (err) {
        console.error('[AndroidKeepAliveService] Error stopping keep-alive service:', err);
      }
    }

    this.lastSyncedShouldRun = shouldRun;
  }
}
