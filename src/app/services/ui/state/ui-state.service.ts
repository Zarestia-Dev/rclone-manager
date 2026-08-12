import { inject, Injectable, signal, computed, effect, type Signal } from '@angular/core';
import { platform } from '@tauri-apps/plugin-os';
import { AppTab, Remote, APP_TABS, MainView } from '@app/types';
import { isHeadlessMode } from 'src/app/services/infrastructure/platform/api-client.service';
import { WindowService } from 'src/app/services/ui/window.service';
import { LocalStorageService } from './local-storage.service';

/** Shape each sidebar-owning component passes to registerMobileSidebar. */
export interface MobileSidebarRegistration {
  /** View identifier so the service knows which registration is topmost. */
  view: MainView;
  /** Signal that is `true` when the sidebar drawer uses 'over' mode (mobile). */
  isOver: Signal<boolean>;
  /** Signal that is `true` when the sidebar drawer is open. */
  isOpen: Signal<boolean>;
}

/**
 * Service for managing UI state with focus on viewport settings
 */
@Injectable({
  providedIn: 'root',
})
export class UiStateService {
  private windowService = inject(WindowService);
  private localStorage = inject(LocalStorageService);

  public isMaximized = this.windowService.isMaximized;
  public readonly platform: string;

  private readonly _currentTab = signal<AppTab>(this.getInitialTab());
  public readonly currentTab = this._currentTab.asReadonly();

  // JSON Editor mode state
  private readonly _showJsonMode = signal<boolean>(
    this.localStorage.get<boolean>('ui.showJsonMode', false)
  );
  public readonly showJsonMode = this._showJsonMode.asReadonly();

  // Selected remote state
  private readonly _selectedRemote = signal<Remote | null>(null);
  public readonly selectedRemote = this._selectedRemote.asReadonly();

  // Main view state ('main_menu' | 'nautilus' | 'flow')
  private readonly _defaultView = signal<MainView>('main_menu');
  public readonly defaultView = this._defaultView.asReadonly();

  private readonly _selectedMainView = signal<MainView>('main_menu');
  public readonly selectedMainView = this._selectedMainView.asReadonly();

  // Mobile Sidebar registrations
  private readonly _mobileSidebarRegistrations = signal<Map<MainView, MobileSidebarRegistration>>(
    new Map()
  );

  // Overlay signals set lazily to avoid circular dependencies
  private _overlaySignals?: {
    mainOverlay: Signal<boolean>;
    flowOverlay: Signal<boolean>;
    nautilusOverlay: Signal<boolean>;
  };

  /**
   * Reactive flag consumed by `TabsButtonsComponent` to hide the floating
   * mobile tab bar whenever the topmost view's sidebar drawer is open in
   * overlay ('over') mode.
   *
   * The value is computed from the active registrations plus the overlay
   * signals injected lazily via `setOverlaySignals()`.
   */
  public readonly mobileSidebarOpen = computed(() => {
    if (
      this._overlaySignals?.mainOverlay() ||
      this._overlaySignals?.flowOverlay() ||
      this._overlaySignals?.nautilusOverlay()
    ) {
      return true;
    }

    const registrations = this._mobileSidebarRegistrations();
    const topView = this._selectedMainView();
    const reg = registrations.get(topView);
    if (!reg) return false;
    return reg.isOver() && reg.isOpen();
  });

  setOverlaySignals(signals: {
    mainOverlay: Signal<boolean>;
    flowOverlay: Signal<boolean>;
    nautilusOverlay: Signal<boolean>;
  }): void {
    this._overlaySignals = signals;
  }

  private getInitialTab(): AppTab {
    const stored = this.localStorage.get<string>('ui.currentTab', 'general');
    if (APP_TABS.includes(stored as AppTab)) {
      return stored as AppTab;
    }
    if (stored === 'sync') {
      return 'operations';
    }
    return 'general';
  }

  /**
   * Register a sidebar-owning component so the mobile-sidebar computation
   * can track its drawer state. Call from the component constructor.
   */
  registerMobileSidebar(reg: MobileSidebarRegistration): void {
    this._mobileSidebarRegistrations.update(m => {
      const next = new Map(m);
      next.set(reg.view, reg);
      return next;
    });
  }

  /**
   * Unregister when the component is destroyed. Call from `destroyRef.onDestroy`.
   */
  unregisterMobileSidebar(view: MainView): void {
    this._mobileSidebarRegistrations.update(m => {
      const next = new Map(m);
      next.delete(view);
      return next;
    });
  }

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

  // === Main View Management ===
  setDefaultView(view: MainView): void {
    this._defaultView.set(view);
    this._selectedMainView.set(view);
  }

  setMainView(view: MainView): void {
    this._selectedMainView.set(view);
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

  // === Viewport Management ===

  private applyViewportSettings(isMaximized: boolean): void {
    const shouldBeMaximized = this.platform === 'macos' || this.platform === 'web' || isMaximized;
    const settings = shouldBeMaximized
      ? this.viewportSettings.maximized
      : this.viewportSettings.default;

    document.documentElement.style.setProperty('--app-border-radius', settings.radii.app);
  }
}
