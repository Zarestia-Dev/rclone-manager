import { inject, Injectable, signal, effect } from '@angular/core';
import { WindowService } from './window.service';
import { platform } from '@tauri-apps/plugin-os';
import { AppTab, Remote } from '@app/types';
import { ApiClientService } from '../core/api-client.service';

/**
 * Service for managing UI state with focus on viewport settings
 */
@Injectable({
  providedIn: 'root',
})
export class UiStateService {
  // Window and platform
  public platform: string;
  private windowService = inject(WindowService);
  private apiClient = inject(ApiClientService);

  // Viewport state
  public isMaximized = this.windowService.isMaximized;

  // Tab management
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
    // Initialize platform safely for headless mode
    if (this.apiClient.isHeadless()) {
      this.platform = 'web';
    } else {
      try {
        this.platform = platform();
      } catch {
        this.platform = 'linux'; // Fallback
      }
    }

    effect(() => {
      this.applyViewportSettings(this.windowService.isMaximized());
    });
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

  // === Path Utilities ===
  /**
   * Extract filename from a path using OS-aware separators.
   * - On Windows: splits by both \ and /
   * - On Unix: splits by / only (\ can be valid in filenames)
   */
  extractFilename(path: string): string {
    if (!path) return '';
    const isWindows = this.platform === 'windows';
    const parts = isWindows ? path.split(/[/\\]/) : path.split('/');
    return parts[parts.length - 1] || path;
  }

  /**
   * Join path segments using OS-appropriate separator.
   * - On Windows: uses \
   * - On Unix: uses /
   */
  joinPath(...segments: string[]): string {
    const separator = this.platform === 'windows' ? '\\' : '/';
    return segments.filter(s => s).join(separator);
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
