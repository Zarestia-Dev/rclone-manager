import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { fromEvent } from 'rxjs';
import { TauriBaseService } from './tauri-base.service';
import { isAndroid } from './api-client.service';
import { LocalStorageService } from '../../ui/state/local-storage.service';
import { AppSettingsService } from '../../settings/app-settings.service';

export interface AndroidNativeKeepAliveBridge {
  isBatteryOptimizationIgnored?: () => boolean;
  requestIgnoreBatteryOptimizations?: () => void;
}

const BATTERY_PROMPT_DISMISSED_KEY = 'android.batteryPromptDismissed';

const getBridge = (): AndroidNativeKeepAliveBridge | undefined =>
  (window as Window & { __rclone__?: AndroidNativeKeepAliveBridge }).__rclone__;

/**
 * The foreground service and its notification are driven by the backend, which also runs
 * without this page. This only asks the user to exempt the app from battery optimization.
 */
@Injectable({
  providedIn: 'root',
})
export class AndroidKeepAliveService extends TauriBaseService {
  private readonly appSettingsService = inject(AppSettingsService);
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
}
