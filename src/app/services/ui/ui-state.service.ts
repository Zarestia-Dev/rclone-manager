import { inject, Injectable, NgZone } from '@angular/core';
import { WindowService } from './window.service';
import { BehaviorSubject, Subject } from 'rxjs';
import { EventListenersService } from '../system/event-listeners.service';
import { platform } from '@tauri-apps/plugin-os';
import { AppTab, ToastMessage, Remote } from '@app/types';
import { ApiClientService } from '../core/api-client.service';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { NautilusComponent } from '../../features/nautilus/nautilus.component';
import { take } from 'rxjs/operators';

// ToastMessage moved to shared types
export interface FilePickerOptions {
  selectFolders?: boolean;
  selectFiles?: boolean;
  multiSelection?: boolean;
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
  private selectedRemoteSource = new BehaviorSubject<Remote | null>(null);
  public selectedRemote$ = this.selectedRemoteSource.asObservable();

  // Viewport state
  private _isMaximized = new BehaviorSubject<boolean>(false);
  public isMaximized$ = this._isMaximized.asObservable();

  // Nautilus / Browser overlay
  private _isNautilusOverlayOpen = new BehaviorSubject<boolean>(false);
  public isNautilusOverlayOpen$ = this._isNautilusOverlayOpen.asObservable();

  // File Picker state
  private _filePickerState = new BehaviorSubject<{
    isOpen: boolean;
    options?: FilePickerOptions;
  }>({ isOpen: false });
  public filePickerState$ = this._filePickerState.asObservable();
  private _filePickerResult = new Subject<string[] | null>();
  public filePickerResult$ = this._filePickerResult.asObservable();

  // Toast notifications
  private _showToast$ = new BehaviorSubject<ToastMessage | null>(null);
  public showToast$ = this._showToast$.asObservable();

  // Window and platform
  public platform: string;
  private windowService = inject(WindowService);
  private apiClient = inject(ApiClientService);

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
  private overlay = inject(Overlay);
  private overlayRef: OverlayRef | null = null;

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
    this.initializeMaximizeListener();
  }

  toggleNautilusOverlay(): void {
    if (this.overlayRef) {
      this.closeFilePicker(null);
    } else {
      this._filePickerState.next({ isOpen: false });
      this._isNautilusOverlayOpen.next(true);
      this.createNautilusOverlay();
    }
  }

  // === File Picker Management ===
  openFilePicker(options: FilePickerOptions): void {
    if (this.overlayRef) return;
    this._filePickerState.next({ isOpen: true, options });
    this._isNautilusOverlayOpen.next(true);
    this.createNautilusOverlay();
  }

  closeFilePicker(result: string[] | null): void {
    this._filePickerResult.next(result);
    this._filePickerState.next({ isOpen: false });
    this._isNautilusOverlayOpen.next(false);
    if (this.overlayRef) {
      this.overlayRef.dispose();
      this.overlayRef = null;
    }
  }

  private createNautilusOverlay(): void {
    this.overlayRef = this.overlay.create({
      hasBackdrop: true,
      positionStrategy: this.overlay.position().global().centerHorizontally().centerVertically(),
      scrollStrategy: this.overlay.scrollStrategies.block(),
    });

    const portal = new ComponentPortal(NautilusComponent);
    const componentRef: import('@angular/core').ComponentRef<NautilusComponent> =
      this.overlayRef.attach(portal);

    componentRef.instance.closeOverlay.pipe(take(1)).subscribe(() => {
      this.closeFilePicker(null);
    });

    this.overlayRef
      .backdropClick()
      .pipe(take(1))
      .subscribe(() => {
        this.closeFilePicker(null);
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
}
