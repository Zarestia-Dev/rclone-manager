import { inject, Injectable, NgZone } from '@angular/core';
import { WindowService } from './window.service';
import { BehaviorSubject } from 'rxjs';
import { EventListenersService } from '../system/event-listeners.service';
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
  public platform = platform();
  private windowService = inject(WindowService);

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

  private eventListenersService = inject(EventListenersService);

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
      await this.windowService.updateMaximizedState(
        this._isMaximized,
        this.applyViewportSettings.bind(this),
        this.platform
      );

      // Listen for maximize/unmaximize events
      this.eventListenersService.listenToWindowResize().subscribe(() => {
        this.ngZone.run(async () => {
          await this.windowService.updateMaximizedState(
            this._isMaximized,
            this.applyViewportSettings.bind(this),
            this.platform
          );
        });
      });
    } catch (error) {
      console.warn('Tauri window events not available:', error);
    }
  }

  private applyViewportSettings(isMaximized: boolean): void {
    const settings = isMaximized ? this.viewportSettings.maximized : this.viewportSettings.default;

    document.documentElement.style.setProperty('--app-border-radius', settings.radii.app);
  }

  // === Remote Deletion Listener ===
  private async setupRemoteDeletionListener(): Promise<void> {
    try {
      this.eventListenersService.listenToRemoteDeleted().subscribe(event => {
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
