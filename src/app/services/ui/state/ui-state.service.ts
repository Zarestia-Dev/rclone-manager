import { inject, Injectable, signal, effect, computed, Injector, type Signal } from '@angular/core';
import { platform } from '@tauri-apps/plugin-os';
import { AppTab, Remote, APP_TABS, MainView } from '@app/types';
import { isHeadlessMode } from 'src/app/services/infrastructure/platform/api-client.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
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
  private pathService = inject(PathService);
  private windowService = inject(WindowService);
  private localStorage = inject(LocalStorageService);
  private readonly injector = inject(Injector);

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

  // Main view state ('main_menu' | 'nautilus' | 'flow')
  private readonly _defaultView = signal<MainView>('main_menu');
  public readonly defaultView = this._defaultView.asReadonly();

  private readonly _selectedMainView = signal<MainView>('main_menu');
  public readonly selectedMainView = this._selectedMainView.asReadonly();

  // ── Mobile Sidebar (centralized) ────────────────────────────────────────
  private readonly _mobileSidebarRegistrations = signal<Map<MainView, MobileSidebarRegistration>>(
    new Map()
  );

  /**
   * Reactive flag consumed by `TabsButtonsComponent` to hide the floating
   * mobile tab bar whenever the topmost view's sidebar drawer is open in
   * overlay ('over') mode.
   *
   * The value is computed from the active registrations plus the overlay
   * signals injected lazily via `setOverlaySignals()`.
   */
  public readonly mobileSidebarOpen = computed(() => {
    const registrations = this._mobileSidebarRegistrations();

    // Determine the topmost view from overlay signals (if available).
    const mainOverlay = this._mainOverlayOpen();
    const flowOverlay = this._flowOverlayOpen();
    const nautilusOverlay = this._nautilusOverlayOpen();

    if (mainOverlay || flowOverlay || nautilusOverlay) {
      return true;
    }

    const topView = this._selectedMainView();
    const reg = registrations.get(topView);
    if (!reg) return false;
    return reg.isOver() && reg.isOpen();
  });

  // Overlay open signals — set lazily to avoid circular DI.
  private readonly _mainOverlayOpen = signal(false);
  private readonly _flowOverlayOpen = signal(false);
  private readonly _nautilusOverlayOpen = signal(false);
  private _overlayEffectInitialized = false;

  /**
   * Called once (typically by AppComponent) to wire overlay signals into
   * the mobile-sidebar computation without creating circular imports.
   *
   * The effects are bound to this service's own injector so their lifecycle
   * tracks UiStateService, not the caller's injection context.
   */
  setOverlaySignals(signals: {
    mainOverlay: Signal<boolean>;
    flowOverlay: Signal<boolean>;
    nautilusOverlay: Signal<boolean>;
  }): void {
    if (this._overlayEffectInitialized) return;
    this._overlayEffectInitialized = true;

    effect(() => this._mainOverlayOpen.set(signals.mainOverlay()), { injector: this.injector });
    effect(() => this._flowOverlayOpen.set(signals.flowOverlay()), { injector: this.injector });
    effect(() => this._nautilusOverlayOpen.set(signals.nautilusOverlay()), {
      injector: this.injector,
    });
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
