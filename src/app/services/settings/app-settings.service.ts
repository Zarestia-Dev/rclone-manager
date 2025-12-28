import { inject, Injectable, OnDestroy } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { NotificationService } from '../../shared/services/notification.service';
import { BehaviorSubject, firstValueFrom, Observable, Subject } from 'rxjs';
import { map, distinctUntilChanged, filter, takeUntil, first } from 'rxjs/operators';
import { CheckResult, SettingMetadata, SYSTEM_SETTINGS_CHANGED } from '@app/types';

@Injectable({
  providedIn: 'root',
})
export class AppSettingsService extends TauriBaseService implements OnDestroy {
  private notificationService = inject(NotificationService);

  private optionsState$ = new BehaviorSubject<Record<string, SettingMetadata> | null>(null);
  public options$ = this.optionsState$.asObservable();

  protected destroyed$ = new Subject<void>();

  constructor() {
    super();

    this.listenToEvent<Record<string, Record<string, any>>>(SYSTEM_SETTINGS_CHANGED)
      .pipe(takeUntil(this.destroyed$))
      .subscribe(payload => {
        console.log('Received settings change from backend:', payload);
        this.updateStateFromEvent(payload);
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
      console.log('Loaded settings from backend:', response);

      this.optionsState$.next(response.options);
    } catch (error) {
      console.error('Failed to load settings:', error);
      this.notificationService.showError('Could not load application settings.');
    }
  }

  selectSetting(key: string): Observable<SettingMetadata | undefined> {
    return this.options$.pipe(
      filter((options): options is Record<string, SettingMetadata> => options !== null),
      map(options => options[key]),
      distinctUntilChanged()
    );
  }

  async getSettingValue<T = any>(key: string): Promise<T | undefined> {
    const setting$ = this.options$.pipe(
      filter(options => options !== null),
      first(),
      map(options => options![key]?.value as T)
    );
    return firstValueFrom(setting$);
  }

  async saveSetting(category: string, key: string, value: any): Promise<void> {
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
  async resetSetting(category: string, key: string): Promise<any> {
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
      this.notificationService.showError(`Failed to reset ${fullKey} to default.`);
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
      this.notificationService.showSuccess('Settings reset successfully');
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
  async saveRemoteSettings(remoteName: string, settings: any): Promise<void> {
    return this.invokeCommand('save_remote_settings', { remoteName, settings });
  }

  /**
   * Get remote settings
   */
  async getRemoteSettings(): Promise<any> {
    return this.invokeCommand('get_settings');
  }

  /**
   * Reset settings for a specific remote
   */
  async resetRemoteSettings(remoteName: string): Promise<void> {
    await this.invokeCommand('delete_remote_settings', { remoteName });
    this.notificationService.showSuccess(`Settings for ${remoteName} reset successfully`);
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

  ngOnDestroy(): void {
    this.destroyed$.next();
    this.destroyed$.complete();
  }
}
