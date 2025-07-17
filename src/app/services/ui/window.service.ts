import { Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';

@Injectable({
  providedIn: 'root',
})
export class WindowService extends TauriBaseService {
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

  applyTheme(theme: 'light' | 'dark'): void {
    try {
      document.documentElement.setAttribute('class', theme);
      this.invokeCommand('set_theme', { theme });
    } catch (error) {
      console.error('Failed to apply theme:', error);
    }
  }
}
