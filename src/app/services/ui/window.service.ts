import { effect, inject, Injectable, Injector, signal } from '@angular/core';
import { platform } from '@tauri-apps/plugin-os';
import { Theme } from '@app/types';
import { AppSettingsService } from '../settings/app-settings.service';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { isHeadlessMode } from '../infrastructure/platform/api-client.service';

export type ResizeDirection =
  'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West';

@Injectable({
  providedIn: 'root',
})
export class WindowService extends TauriBaseService {
  private readonly _theme = signal<Theme>('system');
  public readonly theme = this._theme.asReadonly();
  appSettingsService = inject(AppSettingsService);
  private readonly injector = inject(Injector);
  private readonly systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');

  private readonly _isMaximized = signal<boolean>(false);
  public readonly isMaximized = this._isMaximized.asReadonly();

  constructor() {
    super();
    // Reactively listen to settings changes
    this.appSettingsService.selectSetting('runtime.theme').subscribe(setting => {
      const theme = (setting?.value as Theme) || 'system';
      this.applyTheme(theme);
      this._theme.set(theme);
    });

    // Listen for system theme changes
    this.systemThemeQuery.addEventListener('change', () => {
      if (this._theme() === 'system') {
        this.applyTheme('system');
      }
    });

    this.initWindowListeners();
    this.initLinuxResizeHandles();
  }

  private async initWindowListeners(): Promise<void> {
    if (this.isTauri) {
      this.checkMaximizedState();
      this.listenToEvent('tauri://resize').subscribe(() => {
        this.checkMaximizedState();
      });
    }
  }

  private initLinuxResizeHandles(): void {
    if (!this.isTauri || isHeadlessMode() || platform() !== 'linux') return;

    const createHandles = (): void => {
      if (document.getElementById('linux-resize-handles')) return;

      const targetContainer = document.querySelector('.app-wrapper') || document.body;

      const container = document.createElement('div');
      container.id = 'linux-resize-handles';

      const directions: ResizeDirection[] = [
        'North',
        'South',
        'East',
        'West',
        'NorthWest',
        'NorthEast',
        'SouthWest',
        'SouthEast',
      ];

      const dirClassMap: Record<ResizeDirection, string> = {
        North: 'n',
        South: 's',
        East: 'e',
        West: 'w',
        NorthWest: 'nw',
        NorthEast: 'ne',
        SouthWest: 'sw',
        SouthEast: 'se',
      };

      for (const dir of directions) {
        const handle = document.createElement('div');
        handle.className = `resize-handle ${dirClassMap[dir]}`;
        handle.addEventListener('mousedown', (e: MouseEvent) => {
          if (e.button !== 0) return;
          e.preventDefault();
          void this.startResizeDragging(dir);
        });
        container.appendChild(handle);
      }

      targetContainer.appendChild(container);

      effect(
        () => {
          container.style.display = this.isMaximized() ? 'none' : 'block';
        },
        { injector: this.injector }
      );
    };

    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', createHandles);
    } else {
      setTimeout(createHandles, 0);
    }
  }

  private async checkMaximizedState(): Promise<void> {
    try {
      const isMaximized = await this.isWindowMaximized();
      if (this._isMaximized() !== isMaximized) {
        this._isMaximized.set(isMaximized);
      }
    } catch (error) {
      console.error('Failed to check maximized state:', error);
    }
  }

  async quitApplication(): Promise<void> {
    try {
      await this.invokeCommand('shutdown_app');
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
      await this.appWindow?.minimize();
    } catch (error) {
      console.error('Failed to minimize window:', error);
    }
  }

  async maximize(): Promise<void> {
    try {
      await this.appWindow?.toggleMaximize();
    } catch (error) {
      console.error('Failed to toggle maximize:', error);
    }
  }

  async close(): Promise<void> {
    try {
      await this.appWindow?.close();
    } catch (error) {
      console.error('Failed to close window:', error);
    }
  }

  async startResizeDragging(direction: ResizeDirection): Promise<void> {
    try {
      await this.appWindow?.startResizeDragging(direction);
    } catch (error) {
      console.error('Failed to start resize dragging:', error);
    }
  }

  async setTheme(theme: Theme): Promise<void> {
    // Avoid unnecessary work if the theme is already active
    if (this._theme() === theme) {
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
