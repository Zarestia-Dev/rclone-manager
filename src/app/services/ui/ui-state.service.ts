import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { platform } from '@tauri-apps/plugin-os';
import { AppTab } from '../../shared/components/types';

export interface ToastMessage {
  message: string;
  type: 'success' | 'error' | 'info' | 'warning';
}

/**
 * Service for managing UI state and viewport settings
 * Handles window state, responsive design, and UI notifications
 */
@Injectable({
  providedIn: 'root'
})
export class UiStateService {

  // Tab management
  private currentTab = new BehaviorSubject<AppTab>('general' as AppTab);
  public currentTab$ = this.currentTab.asObservable();

  // Selected remote state
  private selectedRemoteSource = new BehaviorSubject<any>(null);
  public selectedRemote$ = this.selectedRemoteSource.asObservable();

  // Viewport state
  private _isMobile = new BehaviorSubject<boolean>(window.innerWidth <= 600);
  private _isMaximized = new BehaviorSubject<boolean>(false);
  public isMobile$ = this._isMobile.asObservable();
  public isMaximized$ = this._isMaximized.asObservable();

  // Toast notifications
  private _showToast$ = new BehaviorSubject<ToastMessage | null>(null);
  public showToast$ = this._showToast$.asObservable();

  // Window and platform
  private appWindow = getCurrentWindow();
  public platform = platform();

  // Viewport settings configuration
  private viewportSettings = {
    maximized: {
      radii: {
        homeBottom: '0px',
        titleBar: '0px',
        tabBarBottom: '0px',
      },
    },
    mobile: {
      radii: {
        homeBottom: '0px',
        titleBar: '16px',
        tabBarBottom: '16px',
      },
    },
    default: {
      radii: {
        homeBottom: '16px',
        titleBar: '16px',
        tabBarBottom: '0px',
      },
    },
  };

  constructor(private ngZone: NgZone) {
    this.initializeWindowListeners();
    this.updateViewportSettings();
    this.setupRemoteDeletionListener();
    this.setupResizeListener();
    this.setupResetListener();
  }

  // === Tab Management ===
  setTab(tab: AppTab): void {
    this.currentTab.next(tab);
  }

  getCurrentTab(): AppTab {
    return this.currentTab.value;
  }

  // === Remote Selection ===
  setSelectedRemote(remote: any): void {
    this.selectedRemoteSource.next(remote);
  }

  resetSelectedRemote(): void {
    this.selectedRemoteSource.next(null);
  }

  // === Toast Notifications ===
  showToast(message: string, type: ToastMessage['type']): void {
    this._showToast$.next({ message, type });
  }

  clearToast(): void {
    this._showToast$.next(null);
  }

  // === State Reset ===
  resetAppState(): void {
    this.resetSelectedRemote();
    this.clearToast();
    this.setTab('mount');
  }

  // === Viewport Management ===
  async updateViewportOnBannerChange(): Promise<void> {
    await this.updateViewportSettings();
  }

  // === Private Methods ===
  private setupResizeListener(): void {
    window.addEventListener('resize', () => {
      this.ngZone.run(() => {
        this._isMobile.next(window.innerWidth <= 600);
        this.updateViewportSettings();
      });
    });
  }

  private setupResetListener(): void {
    this.appWindow.listen('reset-ui', () => {
      this.ngZone.run(() => this.resetAppState());
    });
  }

  private async setupRemoteDeletionListener(): Promise<void> {
    try {
      await listen<string>('remote_deleted', (event) => {
        this.ngZone.run(() => {
          const deletedRemoteName = event.payload;
          const currentRemote = this.selectedRemoteSource.value;

          if (currentRemote?.remoteSpecs?.name === deletedRemoteName) {
            this.resetSelectedRemote();
            this.showToast(`Remote ${deletedRemoteName} deleted`, 'success');
          }
        });
      });
    } catch (error) {
      console.warn('Failed to setup remote deletion listener:', error);
    }
  }

  private async initializeWindowListeners(): Promise<void> {
    try {
      await listen('tauri://resize', () => {
        this.ngZone.run(() => {
          this.updateWindowState();
        });
      });

      await this.updateWindowState();
    } catch (error) {
      console.warn('Tauri window events not available:', error);
    }
  }

  private async updateWindowState(): Promise<void> {
    let isMaximized = false;

    if (this.platform === 'macos') {
      // On macOS, always set maximized to true and set all radii to 0
      isMaximized = true;
      this._isMaximized.next(isMaximized);
      this.setMacOSStyles();
      return;
    }

    isMaximized = await this.appWindow.isMaximized();
    this._isMaximized.next(isMaximized);
    this.updateViewportSettings();
  }

  private setMacOSStyles(): void {
    document.documentElement.style.setProperty('--home-bottom-radius', '0px');
    document.documentElement.style.setProperty('--title-bar-radius', '0px');
    document.documentElement.style.setProperty('--tab-bar-bottom-radius', '0px');
  }

  private async updateViewportSettings(): Promise<void> {
    const isMobile = this._isMobile.value;
    const isMaximized = this._isMaximized.value;

    let settings = this.viewportSettings.default;

    if (isMaximized) {
      settings = this.viewportSettings.maximized;
    } else if (isMobile) {
      settings = this.viewportSettings.mobile;
    }

    // Apply the settings
    document.documentElement.style.setProperty(
      '--home-bottom-radius',
      settings.radii.homeBottom
    );
    document.documentElement.style.setProperty(
      '--title-bar-radius',
      settings.radii.titleBar
    );
    document.documentElement.style.setProperty(
      '--tab-bar-bottom-radius',
      settings.radii.tabBarBottom
    );

    // Calculate and apply app height
    const height = isMobile
      ? `calc(100vh - ((var(--titlebar-height) + var(--title-bar-padding)) + 48px))`
      : `calc(100vh - (var(--titlebar-height) + var(--title-bar-padding)))`;

    document.documentElement.style.setProperty('--app-height', height);
  }
}
