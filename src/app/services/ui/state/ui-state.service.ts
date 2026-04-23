import { inject, Injectable, signal, effect } from '@angular/core';
import { platform } from '@tauri-apps/plugin-os';
import { AppTab, Remote } from '@app/types';
import { isHeadlessMode, PathService, WindowService } from '@app/services';

/**
 * Service for managing UI state with focus on viewport settings
 */
@Injectable({
  providedIn: 'root',
})
export class UiStateService {
  private pathService = inject(PathService);
  private windowService = inject(WindowService);

  public isMaximized = this.windowService.isMaximized;
  public readonly platform: string;

  private readonly _currentTab = signal<AppTab>('general' as AppTab);
  public readonly currentTab = this._currentTab.asReadonly();
  // Selected remote state
  private readonly _selectedRemote = signal<Remote | null>(null);
  public readonly selectedRemote = this._selectedRemote.asReadonly();
  // Viewport settings configuration
  private viewportSettings = {
    maximized: {
      radii: {
        app: '0px',
      },
    },
    default: {
      radii: {
        app: '16px',
      },
    },
  };

  constructor() {
    this.platform = this.initializePlatform();

    effect(() => {
      this.applyViewportSettings(this.windowService.isMaximized());
    });
  }

  private initializePlatform(): string {
    if (isHeadlessMode()) {
      return 'web';
    }
    try {
      return platform();
    } catch (error) {
      console.warn('Failed to detect platform, falling back to linux:', error);
      return 'linux';
    }
  }

  // === Tab Management ===
  setTab(tab: AppTab): void {
    this._currentTab.set(tab);
  }

  getCurrentTab(): AppTab {
    return this._currentTab();
  }

  // === Remote Selection ===
  setSelectedRemote(remote: Remote | null): void {
    this._selectedRemote.set(remote);
  }

  resetSelectedRemote(): void {
    this._selectedRemote.set(null);
  }

  extractFilename(path: string): string {
    return this.pathService.getFilename(path);
  }

  /**
   * Join path segments.
   */
  joinPath(...segments: string[]): string {
    return this.pathService.joinPath(...segments);
  }

  // === Viewport Management ===

  private applyViewportSettings(isMaximized: boolean): void {
    const shouldBeMaximized = this.platform === 'macos' || this.platform === 'web' || isMaximized;
    const settings = shouldBeMaximized
      ? this.viewportSettings.maximized
      : this.viewportSettings.default;

    document.documentElement.style.setProperty('--app-border-radius', settings.radii.app);
  }
}
