import { inject, Injectable, NgZone } from '@angular/core';
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
 * Service for managing UI state with focus on viewport settings
 */
@Injectable({
  providedIn: 'root',
})
export class UiStateService {
  // Tab management
  private currentTab = new BehaviorSubject<AppTab>('general' as AppTab);
  public currentTab$ = this.currentTab.asObservable();

  // Selected remote state
  private selectedRemoteSource = new BehaviorSubject<any>(null);
  public selectedRemote$ = this.selectedRemoteSource.asObservable();

  // Viewport state
  private _isMaximized = new BehaviorSubject<boolean>(false);
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
        app: '0px',
      },
    },
    default: {
      radii: {
        app: '16px',
      },
    },
  };

  private ngZone = inject(NgZone);

  constructor() {
    this.initializeMaximizeListener();
    this.setupRemoteDeletionListener();
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
  private async initializeMaximizeListener(): Promise<void> {
    try {
      // Initial state
      await this.updateMaximizedState();

      // Listen for maximize/unmaximize events
      await listen('tauri://resize', async () => {
        this.ngZone.run(async () => {
          await this.updateMaximizedState();
        });
      });
    } catch (error) {
      console.warn('Tauri window events not available:', error);
    }
  }

  private async updateMaximizedState(): Promise<void> {
    if (this.platform === 'macos') {
      // macOS always gets zero-radius styling
      this._isMaximized.next(true);
      this.applyViewportSettings(true);
      return;
    }

    const isMaximized = await this.appWindow.isMaximized();
    this._isMaximized.next(isMaximized);
    this.applyViewportSettings(isMaximized);
  }

  private applyViewportSettings(isMaximized: boolean): void {
    const settings = isMaximized ? this.viewportSettings.maximized : this.viewportSettings.default;

    document.documentElement.style.setProperty('--app-border-radius', settings.radii.app);
  }

  // === Remote Deletion Listener ===
  private async setupRemoteDeletionListener(): Promise<void> {
    try {
      await listen<string>('remote_deleted', event => {
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
}
