import { DestroyRef, effect, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { platform } from '@tauri-apps/plugin-os';
import { SYSTEM_THEME_CHANGED, Theme } from '@app/types';
import { AppSettingsService } from '../settings/app-settings.service';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';

export type ResizeDirection =
  'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West';

@Injectable({
  providedIn: 'root',
})
export class WindowService extends TauriBaseService {
  private readonly _theme = signal<Theme>('system');
  public readonly theme = this._theme.asReadonly();
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly systemThemeQuery: MediaQueryList | null =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;

  private readonly _isMaximized = signal<boolean>(false);
  public readonly isMaximized = this._isMaximized.asReadonly();

  constructor() {
    super();

    this.appSettingsService
      .selectSetting('runtime.theme')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(setting => {
        const theme = (setting?.value as Theme) || 'system';
        this.applyTheme(theme);
        this._theme.set(theme);
      });

    const handleSystemThemeChange = (): void => {
      if (this._theme() === 'system') {
        this.applyTheme('system');
      }
    };
    this.systemThemeQuery?.addEventListener('change', handleSystemThemeChange);
    this.destroyRef.onDestroy(() => {
      this.systemThemeQuery?.removeEventListener('change', handleSystemThemeChange);
    });

    if (this.isTauri) {
      effect(() => {
        const isMax = this.isMaximized();
        const container = document.getElementById('linux-resize-handles');
        if (container) {
          container.style.display = isMax ? 'none' : 'block';
        }
      });

      this.listenToEvent<boolean>(SYSTEM_THEME_CHANGED)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(isDark => {
          if (this._theme() === 'system') {
            const resolvedTheme: 'light' | 'dark' = isDark ? 'dark' : 'light';
            document.documentElement.setAttribute('class', resolvedTheme);
            this.updateNativeBridge(isDark);
          }
        });

      this.initWindowListeners();
      this.initLinuxResizeHandles();
    }
  }

  private async initWindowListeners(): Promise<void> {
    this.checkMaximizedState();
    this.listenToEvent('tauri://resize')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.checkMaximizedState();
      });
  }

  private initLinuxResizeHandles(): void {
    try {
      if (platform() !== 'linux') return;
    } catch {
      return;
    }

    const createHandles = (): void => {
      if (document.getElementById('linux-resize-handles')) return;

      const targetContainer = document.querySelector('.app-wrapper') || document.body;

      const container = document.createElement('div');
      container.id = 'linux-resize-handles';
      container.style.display = this.isMaximized() ? 'none' : 'block';

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
      await this.invokeCommand('request_app_exit');
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
      const isSystemDark = this.systemThemeQuery?.matches ?? false;
      const resolvedTheme: 'light' | 'dark' =
        theme === 'system' ? (isSystemDark ? 'dark' : 'light') : theme;

      document.documentElement.setAttribute('class', resolvedTheme);
      this.updateNativeBridge(resolvedTheme === 'dark');

      await this.invokeCommand('set_theme', {
        theme,
        systemIsDark: isSystemDark,
      });
    } catch (error) {
      console.error('Failed to apply theme:', error);
    }
  }

  private updateNativeBridge(isDark: boolean): void {
    const bridge = (
      window as Window & {
        __rclone__?: {
          setSystemTheme?: (isDark: boolean) => void;
        };
      }
    ).__rclone__;

    bridge?.setSystemTheme?.(isDark);
  }
}
