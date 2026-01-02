import { inject, Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { NotificationService } from '@app/services';
import { BehaviorSubject, firstValueFrom, Observable } from 'rxjs';
import { map, distinctUntilChanged, filter, first } from 'rxjs/operators';
import { TranslateService } from '@ngx-translate/core';
import { CheckResult, SettingMetadata, SYSTEM_SETTINGS_CHANGED } from '@app/types';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

@Injectable({
  providedIn: 'root',
})
export class AppSettingsService extends TauriBaseService {
  private notificationService = inject(NotificationService);
  private translate = inject(TranslateService);

  private optionsState$ = new BehaviorSubject<Record<string, SettingMetadata> | null>(null);
  public options$ = this.optionsState$.asObservable();

  constructor() {
    super();

    this.listenToEvent<Record<string, Record<string, unknown>>>(SYSTEM_SETTINGS_CHANGED)
      .pipe(takeUntilDestroyed())
      .subscribe(payload => {
        this.updateStateFromEvent(payload as Record<string, Record<string, SettingMetadata>>);
      });
  }

  async loadSettings(): Promise<void> {
    if (this.optionsState$.getValue()) {
      return;
    }
    try {
      const response = await this.invokeCommand<{ options: Record<string, SettingMetadata> }>(
        'load_settings'
      );
      this.optionsState$.next(response.options);
    } catch (error) {
      console.error('Failed to load settings:', error);
      this.notificationService.showError(this.translate.instant('settings.loadFailed'));
    }
  }

  selectSetting(key: string): Observable<SettingMetadata | undefined> {
    return this.options$.pipe(
      filter((options): options is Record<string, SettingMetadata> => options !== null),
      map(options => options[key]),
      distinctUntilChanged()
    );
  }

  async getSettingValue<T = unknown>(key: string): Promise<T | undefined> {
    const setting$ = this.options$.pipe(
      filter(options => options !== null),
      first(),
      map(options => options?.[key]?.value as T)
    );
    return firstValueFrom(setting$);
  }

  async saveSetting(category: string, key: string, value: unknown): Promise<void> {
    const fullKey = `${category}.${key}`;
    const currentState = this.optionsState$.getValue();

    if (currentState && currentState[fullKey]) {
      const newState = {
        ...currentState,
        [fullKey]: {
          ...currentState[fullKey],
          value: value,
        },
      };
      this.optionsState$.next(newState);
    }

    return this.invokeCommand('save_setting', { category, key, value });
  }

  /**
   * Reset a single setting to its default value (backend command `reset_setting`).
   * Updates the local options state to reflect the default returned by the backend.
   */
  async resetSetting(category: string, key: string): Promise<unknown> {
    const fullKey = `${category}.${key}`;
    const currentState = this.optionsState$.getValue();

    try {
      // Backend returns the default value for the setting
      const defaultValue = await this.invokeCommand('reset_setting', { category, key });

      if (currentState && currentState[fullKey]) {
        const newState = {
          ...currentState,
          [fullKey]: {
            ...currentState[fullKey],
            value: defaultValue,
          },
        };
        this.optionsState$.next(newState);
      }

      return defaultValue;
    } catch (err) {
      console.error(`Failed to reset setting ${fullKey}:`, err);
      this.notificationService.showError(
        this.translate.instant('settings.resetFailed', { key: fullKey })
      );
      throw err;
    }
  }

  async resetSettings(): Promise<boolean> {
    const confirmed = await this.notificationService.confirmModal(
      'Reset Settings',
      'Are you sure you want to reset all app settings? This cannot be undone.'
    );

    if (confirmed) {
      await this.invokeCommand('reset_settings');
      this.optionsState$.next(null);
      await this.loadSettings();
      this.notificationService.showSuccess(this.translate.instant('settings.resetSuccess'));
      return true;
    }
    return false;
  }

  /**
   * Merges incoming changes from backend events into the current state.
   */
  private updateStateFromEvent(payload: Record<string, Record<string, SettingMetadata>>): void {
    const currentState = this.optionsState$.getValue();
    if (!currentState) return;

    const newState = { ...currentState };

    for (const category in payload) {
      for (const key in payload[category]) {
        const fullKey = `${category}.${key}`;
        const newValue = payload[category][key];

        if (newState[fullKey]) {
          newState[fullKey] = { ...newState[fullKey], value: newValue };
        }
      }
    }
    this.optionsState$.next(newState);
  }

  /**
   * Save remote-specific settings
   */
  async saveRemoteSettings(remoteName: string, settings: Record<string, unknown>): Promise<void> {
    return this.invokeCommand('save_remote_settings', { remoteName, settings });
  }

  /**
   * Get remote settings
   */
  async getRemoteSettings(): Promise<Record<string, Record<string, unknown>>> {
    return this.invokeCommand('get_settings');
  }

  /**
   * Reset settings for a specific remote
   */
  async resetRemoteSettings(remoteName: string): Promise<void> {
    await this.invokeCommand('delete_remote_settings', { remoteName });
    this.notificationService.showSuccess(
      this.translate.instant('settings.remoteResetSuccess', { remote: remoteName })
    );
  }

  /**
   * Check internet connectivity for links
   */
  async checkInternetLinks(
    links: string[],
    maxRetries: number,
    retryDelaySecs: number
  ): Promise<CheckResult> {
    return this.invokeCommand<CheckResult>('check_links', {
      links,
      maxRetries,
      retryDelaySecs,
    });
  }
}
