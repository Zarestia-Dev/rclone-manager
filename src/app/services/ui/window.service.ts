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
  private readonly systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');

  private readonly _isMaximized$ = new BehaviorSubject<boolean>(false);
  public readonly isMaximized$ = this._isMaximized$.asObservable();

  constructor() {
    super();
    // Reactively listen to settings changes
    this.appSettingsService.selectSetting('runtime.theme').subscribe(setting => {
      const theme = (setting?.value as Theme) || 'system';
      this.applyTheme(theme);
      this._theme$.next(theme);
    });

    // Listen for system theme changes
    this.systemThemeQuery.addEventListener('change', () => {
      if (this._theme$.value === 'system') {
        this.applyTheme('system');
      }
    });

    this.initWindowListeners();
  }

  private async initWindowListeners(): Promise<void> {
    if (this.isTauriEnvironment) {
      this.checkMaximizedState();
      this.listenToEvent('tauri://resize').subscribe(() => {
        this.checkMaximizedState();
      });
    }
  }

  private async checkMaximizedState(): Promise<void> {
    try {
      const isMaximized = await this.isWindowMaximized();
      if (this._isMaximized$.value !== isMaximized) {
        this._isMaximized$.next(isMaximized);
      }
    } catch (error) {
      console.error('Failed to check maximized state:', error);
    }
  }

  async quitApplication(): Promise<void> {
    try {
      await this.invokeCommand('handle_shutdown');
    } catch (error) {
      console.error('Failed to quit application:', error);
    }
  }

  async isWindowMaximized(): Promise<boolean> {
    try {
      if (!this.appWindow) return false;
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

  async setTheme(theme: Theme): Promise<void> {
    // Avoid unnecessary work if the theme is already active
    if (this._theme$.value === theme) {
      return;
    }

    try {
      await this.appSettingsService.saveSetting('runtime', 'theme', theme);
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
