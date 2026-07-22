import { inject, Injectable, signal, effect } from '@angular/core';
import { platform } from '@tauri-apps/plugin-os';
import { AppTab, Remote, APP_TABS } from '@app/types';
import { isHeadlessMode } from 'src/app/services/infrastructure/platform/api-client.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { WindowService } from 'src/app/services/ui/window.service';
import { LocalStorageService } from './local-storage.service';

/**
 * Service for managing UI state with focus on viewport settings
 */
@Injectable({
  providedIn: 'root',
})
export class UiStateService {
  private pathService = inject(PathService);
  private windowService = inject(WindowService);
  private localStorage = inject(LocalStorageService);

  public isMaximized = this.windowService.isMaximized;
  public readonly platform: string;

  private readonly _currentTab = signal<AppTab>(
    ((): AppTab => {
      const stored = this.localStorage.get<string>('ui.currentTab', 'general');
      const validTabs = APP_TABS;
      if (validTabs.includes(stored as AppTab)) {
        return stored as AppTab;
      }
      if (stored === 'sync') {
        return 'operations';
      }
      return 'general';
    })()
  );
  public readonly currentTab = this._currentTab.asReadonly();

  // JSON Editor mode state
  private readonly _showJsonMode = signal<boolean>(
    this.localStorage.get<boolean>('ui.showJsonMode', false)
  );
  public readonly showJsonMode = this._showJsonMode.asReadonly();

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
    this.localStorage.set('ui.currentTab', tab);
  }

  getCurrentTab(): AppTab {
    return this._currentTab();
  }

  // === JSON Editor Mode ===
  setShowJsonMode(value: boolean): void {
    this._showJsonMode.set(value);
    this.localStorage.set('ui.showJsonMode', value);
  }

  toggleShowJsonMode(): void {
    this.setShowJsonMode(!this._showJsonMode());
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
