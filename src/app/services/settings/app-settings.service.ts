import { inject, Injectable, signal } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { NotificationService } from '@app/services';
import { firstValueFrom, Observable } from 'rxjs';
import { map, distinctUntilChanged, filter, first } from 'rxjs/operators';
import { TranslateService } from '@ngx-translate/core';
import { CheckResult, SettingMetadata } from '@app/types';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { EventListenersService } from '../system/event-listeners.service';

@Injectable({
  providedIn: 'root',
})
export class AppSettingsService extends TauriBaseService {
  private notificationService = inject(NotificationService);
  private translate = inject(TranslateService);
  private eventListeners = inject(EventListenersService);

  private readonly _options = signal<Record<string, SettingMetadata> | null>(null);
  public readonly options = this._options.asReadonly();
  public readonly options$ = toObservable(this._options);

  constructor() {
    super();

    this.eventListeners
      .listenToSystemSettingsChanged()
      .pipe(takeUntilDestroyed())
      .subscribe(payload => {
        this.updateStateFromEvent(payload as Record<string, Record<string, SettingMetadata>>);
      });

    this.setupLanguageChangeListener();
  }

  async loadSettings(): Promise<void> {
    if (this._options()) {
      return;
    }
    try {
      const response = await this.invokeCommand<{ options: Record<string, SettingMetadata> }>(
        'load_settings'
      );
      console.debug(response);

      this._options.set(response.options);
    } catch (error) {
      console.error('Failed to load settings:', error);
      this.notificationService.showError(this.translate.instant('settings.loadFailed'));
    }
  }

  /**
   * Apply the saved UI language to the translation service
   */
  async applySavedLanguage(defaultLang = 'en-US'): Promise<string> {
    const savedLang = (await this.getSettingValue<string>('general.language')) || defaultLang;

    if (!this.translate.getCurrentLang() || savedLang !== this.translate.getCurrentLang()) {
      this.translate.use(savedLang);
    }

    return savedLang;
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
    const currentState = this._options();

    if (currentState && currentState[fullKey]) {
      const newState = {
        ...currentState,
        [fullKey]: {
          ...currentState[fullKey],
          value: value,
        },
      };
      this._options.set(newState);
    }

    return this.invokeCommand('save_setting', { category, key, value });
  }

  /**
   * Reset a single setting to its default value (backend command `reset_setting`).
   * Updates the local options state to reflect the default returned by the backend.
   */
  async resetSetting(category: string, key: string): Promise<unknown> {
    const fullKey = `${category}.${key}`;
    const currentState = this._options();

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
        this._options.set(newState);
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
      this.translate.instant('settings.resetAll.title'),
      this.translate.instant('settings.resetAll.message'),
      undefined,
      undefined,
      {
        icon: 'rotate-right',
        iconColor: 'warn',
        iconClass: 'destructive',
        confirmButtonColor: 'warn',
      }
    );

    if (confirmed) {
      await this.invokeCommand('reset_settings');
      this._options.set(null);
      await this.loadSettings();
      this.notificationService.showSuccess(this.translate.instant('settings.resetSuccess'));
      return true;
    }
    return false;
  }

  /**
   * Merges incoming changes from backend events into the current state.
   */
  private updateStateFromEvent(payload: Record<string, Record<string, unknown>>): void {
    const currentState = this._options();
    if (!currentState) return;
    const newState = { ...currentState };
    let hasChanges = false;

    for (const category in payload) {
      for (const key in payload[category]) {
        const fullKey = `${category}.${key}`;
        const newValue = payload[category][key];

        if (newState[fullKey]) {
          // Only update if the value actually changed
          if (newState[fullKey].value !== newValue) {
            newState[fullKey] = { ...newState[fullKey], value: newValue };
            hasChanges = true;
          }
        }
      }
    }

    // Only emit new state if something actually changed
    if (hasChanges) {
      this._options.set(newState);
    } else {
      console.debug('No actual changes detected, skipping state update');
    }
  }

  private setupLanguageChangeListener(): void {
    this.eventListeners
      .listenToAppEvents()
      .pipe(takeUntilDestroyed())
      .subscribe(event => {
        if (typeof event !== 'object' || event?.status !== 'language_changed') {
          return;
        }

        const lang = event.language as string | undefined;
        if (lang && lang !== this.translate.getCurrentLang()) {
          this.translate.use(lang);
        }
      });
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
