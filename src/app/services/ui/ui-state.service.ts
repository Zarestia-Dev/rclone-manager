import { inject, Injectable } from '@angular/core';
import { WindowService } from './window.service';
import { BehaviorSubject } from 'rxjs';
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
  public isMaximized$ = this.windowService.isMaximized$;

  // Tab management
  private currentTab = new BehaviorSubject<AppTab>('general' as AppTab);
  public currentTab$ = this.currentTab.asObservable();

  // Selected remote state
  private selectedRemoteSource = new BehaviorSubject<Remote | null>(null);
  public selectedRemote$ = this.selectedRemoteSource.asObservable();

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

    this.windowService.isMaximized$.subscribe(isMaximized => {
      this.applyViewportSettings(isMaximized);
    });
  }

  // === Tab Management ===
  setTab(tab: AppTab): void {
    this.currentTab.next(tab);
  }

  getCurrentTab(): AppTab {
    return this.currentTab.value;
  }

  // === Remote Selection ===
  setSelectedRemote(remote: Remote | null): void {
    this.selectedRemoteSource.next(remote);
  }

  resetSelectedRemote(): void {
    this.selectedRemoteSource.next(null);
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
