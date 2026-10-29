import { computed, DestroyRef, effect, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { fromEvent } from 'rxjs';
import { TauriBaseService } from './tauri-base.service';
import { isAndroid } from './api-client.service';
import { LocalStorageService } from '../../ui/state/local-storage.service';
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

const BATTERY_PROMPT_DISMISSED_KEY = 'android.batteryPromptDismissed';

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
  private readonly localStorage = inject(LocalStorageService);

  private readonly isKeepAliveSettingEnabled = signal<boolean>(true);
  readonly isBatteryOptimizationIgnored = signal<boolean>(true);
  private readonly batteryPromptDismissed = signal<boolean>(
    this.localStorage.get<boolean>(BATTERY_PROMPT_DISMISSED_KEY, false)
  );

  // Doze suspends the network and timers of apps that are not exempt, which stops background
  // work even while the foreground service is running.
  readonly showBatteryOptimizationPrompt = computed(
    () =>
      this.isKeepAliveSettingEnabled() &&
      !this.isBatteryOptimizationIgnored() &&
      !this.batteryPromptDismissed()
  );

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

    // The system dialog leaves the app, so the answer is only known once it is shown again.
    fromEvent(document, 'visibilitychange')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (!document.hidden) {
          this.refreshBatteryOptimizationStatus();
        }
      });

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

  dismissBatteryOptimizationPrompt(): void {
    this.batteryPromptDismissed.set(true);
    this.localStorage.set(BATTERY_PROMPT_DISMISSED_KEY, true);
  }

  private buildNotificationText(
    mountsCount: number,
    jobsCount: number,
    servesCount: number
  ): string {
    const key = 'settings.general.keep_alive.notification';
    const summaryParts = (
      [
        ['jobs', jobsCount],
        ['mounts', mountsCount],
        ['serves', servesCount],
      ] as const
    )
      .filter(([, count]) => count > 0)
      .map(([part, count]) => this.translate.instant(`${key}.${part}`, { count }));

    return summaryParts.length > 0
      ? summaryParts.join(' • ')
      : this.translate.instant('settings.general.keep_alive.label');
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
