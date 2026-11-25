import { DestroyRef, effect, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { combineLatest, ReplaySubject } from 'rxjs';
import { platform } from '@tauri-apps/plugin-os';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { Theme } from '@app/types';
import {
  accentPalette,
  DEFAULT_WINDOW_BUTTON_LAYOUT,
  parseWindowButtonLayout,
  WindowButtonLayout,
} from 'src/app/shared/utils';
import { AppSettingsService } from '../settings/app-settings.service';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { isMobile } from '../infrastructure/platform/api-client.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';

export type ResizeDirection =
  'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West';

/** Desktops whose accent colour the backend can read. */
const ACCENT_COLOR_PLATFORMS = new Set<string>(['linux', 'windows', 'macos']);

@Injectable({
  providedIn: 'root',
})
export class WindowService extends TauriBaseService {
  private readonly _theme = signal<Theme>('system');
  public readonly theme = this._theme.asReadonly();
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly eventListeners = inject(EventListenersService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly systemThemeQuery: MediaQueryList | null =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;

  private readonly _isMaximized = signal<boolean>(false);
  public readonly isMaximized = this._isMaximized.asReadonly();

  private readonly _buttonLayout = signal<WindowButtonLayout>(DEFAULT_WINDOW_BUTTON_LAYOUT);
  /** Which window buttons the title bar shows, and on which side. */
  public readonly buttonLayout = this._buttonLayout.asReadonly();

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

      this.eventListeners
        .listenToSystemThemeChanged()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(isDark => {
          if (this._theme() === 'system') {
            const resolvedTheme: 'light' | 'dark' = isDark ? 'dark' : 'light';
            document.documentElement.setAttribute('class', resolvedTheme);
            this.updateNativeBridge(isDark);
          }
        });

      if (this.appWindow) {
        this.initWindowListeners();
        this.initLinuxResizeHandles();
        this.loadButtonLayout();
        this.followInterfaceScale();
        this.followSystemAccentColor();
      }
    }
  }

  /**
   * Zooms this window's webview to the Interface scale setting. Desktops with fractional
   * scaling (KDE under Wayland, for example) can render the WebKitGTK interface too large;
   * the browser in headless mode has its own zoom.
   */
  private followInterfaceScale(): void {
    this.appSettingsService
      .selectSetting('general.ui_scale')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(setting => {
        const percent = Number(setting?.value);
        if (!Number.isFinite(percent) || percent <= 0) return;
        this.setWebviewZoom(Math.min(Math.max(percent, 50), 200) / 100).catch(error =>
          console.error('Failed to apply the interface scale:', error)
        );
      });
  }

  private setWebviewZoom(factor: number): Promise<void> {
    return getCurrentWebview().setZoom(factor);
  }

  private async initWindowListeners(): Promise<void> {
    this.checkMaximizedState();
    this.eventListeners
      .listenToWindowResize()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.checkMaximizedState();
      });
  }

  /**
   * On Linux, follow the desktop's button layout (for example GNOME's default close-only),
   * including later changes, which apply without a reload.
   */
  private async loadButtonLayout(): Promise<void> {
    try {
      if (platform() !== 'linux') return;
      // Subscribe first, so a change made while the first read is pending is not lost, and
      // a change that arrives before that read returns wins over the older value.
      let changed = false;
      this.eventListeners
        .listenToWindowButtonLayoutChanged()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(layout => {
          changed = true;
          this._buttonLayout.set(parseWindowButtonLayout(layout));
        });
      const layout = await this.invokeCommand<string | null>('get_window_button_layout');
      if (!changed) this._buttonLayout.set(parseWindowButtonLayout(layout));
    } catch (error) {
      console.error('Failed to read the window button layout:', error);
    }
  }

  /**
   * On Linux, Windows and macOS, use the system accent colour as the primary colour while
   * `general.system_accent_color` is on, including later changes.
   */
  private async followSystemAccentColor(): Promise<void> {
    try {
      if (!ACCENT_COLOR_PLATFORMS.has(platform())) return;
      const accent = new ReplaySubject<string | null>(1);
      // As with the button layout, a change that arrives before the first read wins.
      let changed = false;
      this.eventListeners
        .listenToSystemAccentColorChanged()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(color => {
          changed = true;
          accent.next(color);
        });
      combineLatest([accent, this.appSettingsService.selectSetting('general.system_accent_color')])
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(([color, setting]) =>
          this.applyAccentColor(setting?.value === true ? color : null)
        );
      const color = await this.invokeCommand<string | null>('get_system_accent_color');
      if (!changed) accent.next(color);
    } catch (error) {
      console.error('Failed to read the system accent color:', error);
    }
  }

  private applyAccentColor(color: string | null): void {
    const root = document.documentElement;
    const palette = accentPalette(color);
    if (!palette) {
      root.removeAttribute('data-system-accent');
      return;
    }
    root.style.setProperty('--system-accent-bg', palette.background);
    root.style.setProperty('--system-accent-bg-rgb', palette.backgroundRgb);
    root.style.setProperty('--system-accent-fg', palette.foreground);
    root.style.setProperty('--system-accent-light', palette.light);
    root.style.setProperty('--system-accent-dark', palette.dark);
    root.setAttribute('data-system-accent', '');
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

  // Mobile Tauri windows do not implement desktop maximize/resize operations.
  private readonly appWindow =
    this.isTauri && !isMobile() ? this.getCurrentTauriWindow() : undefined;

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
