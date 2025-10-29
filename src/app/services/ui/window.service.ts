import { inject, Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { BehaviorSubject } from 'rxjs';
import { Theme } from '@app/types';
import { AppSettingsService } from '../settings/app-settings.service';

@Injectable({
  providedIn: 'root',
})
export class WindowService extends TauriBaseService {
  private readonly _theme$ = new BehaviorSubject<Theme>('system');
  public readonly theme$ = this._theme$.asObservable();
  appSettingsService = inject(AppSettingsService);

  constructor() {
    super();
    this.initializeTheme();
  }

  async quitApplication(): Promise<void> {
    try {
      await this.invokeCommand('handle_shutdown');
    } catch (error) {
      console.error('Failed to quit application:', error);
    }
  }
  /**
   * Updates maximized state and applies viewport settings.
   * @param maximizedSubject BehaviorSubject<boolean> to update
   * @param applyViewportSettings Callback to apply viewport settings
   * @param platform Platform string
   */
  async updateMaximizedState(
    maximizedSubject: { next: (val: boolean) => void },
    applyViewportSettings: (isMax: boolean) => void,
    platform: string
  ): Promise<void> {
    if (platform === 'macos') {
      maximizedSubject.next(true);
      applyViewportSettings(true);
      return;
    }
    try {
      const isMaximized = await this.isWindowMaximized();
      maximizedSubject.next(isMaximized);
      applyViewportSettings(isMaximized);
    } catch (error) {
      console.error('Failed to get window maximized state:', error);
      maximizedSubject.next(false);
      applyViewportSettings(false);
    }
  }
  async isWindowMaximized(): Promise<boolean> {
    try {
      return await this.appWindow.isMaximized();
    } catch (error) {
      console.error('Failed to get window maximized state:', error);
      return false;
    }
  }

  private appWindow = this.getCurrentTauriWindow();

  async minimize(): Promise<void> {
    try {
      await this.appWindow.minimize();
    } catch (error) {
      console.error('Failed to minimize window:', error);
    }
  }

  async maximize(): Promise<void> {
    try {
      await this.appWindow.toggleMaximize();
    } catch (error) {
      console.error('Failed to toggle maximize:', error);
    }
  }

  async close(): Promise<void> {
    try {
      await this.appWindow.close();
    } catch (error) {
      console.error('Failed to close window:', error);
    }
  }

  async initializeTheme(): Promise<void> {
    try {
      const savedTheme = await this.appSettingsService.loadSettingValue('general', 'theme');

      await this.applyTheme(savedTheme);

      this._theme$.next(savedTheme);
    } catch (error) {
      console.error('Failed to initialize theme:', error);
      await this.applyTheme('system');
      this._theme$.next('system');
    }
  }

  async setTheme(theme: Theme): Promise<void> {
    // Avoid unnecessary work if the theme is already active
    if (this._theme$.value === theme) {
      return;
    }

    try {
      await this.applyTheme(theme);
      this._theme$.next(theme);
      await this.appSettingsService.saveSetting('general', 'theme', theme);
    } catch (error) {
      console.error(`Failed to set and save theme "${theme}":`, error);
    }
  }

  async applyTheme(theme: 'light' | 'dark' | 'system'): Promise<void> {
    try {
      let _theme: 'light' | 'dark' = theme as 'light' | 'dark';
      if (theme === 'system') {
        _theme = await this.getSystemTheme();
      }

      document.documentElement.setAttribute('class', _theme);
      await this.invokeCommand('set_theme', { theme: _theme });
    } catch (error) {
      console.error('Failed to apply theme:', error);
    }
  }

  getSystemTheme(): Promise<'light' | 'dark'> {
    return this.invokeCommand<'light' | 'dark'>('get_system_theme');
  }
}
