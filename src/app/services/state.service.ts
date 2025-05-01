import { HostListener, Injectable, NgZone } from "@angular/core";
import { BehaviorSubject } from "rxjs/internal/BehaviorSubject";
import { RcloneService } from "./rclone.service";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";


@Injectable({
  providedIn: "root",
})
export class StateService {
  private currentTab = new BehaviorSubject<"mount" | "sync" | "copy" | "jobs">("mount");
  private selectedRemoteSource = new BehaviorSubject<any>(null);
  private _isMobile = new BehaviorSubject<boolean>(window.innerWidth <= 500);
  private _isMaximized = new BehaviorSubject<boolean>(false);
  
  selectedRemote$ = this.selectedRemoteSource.asObservable();
  currentTab$ = this.currentTab.asObservable();
  isMobile$ = this._isMobile.asObservable();
  isMaximized$ = this._isMaximized.asObservable();

  private appWindow = getCurrentWindow();

  constructor(private rcloneService: RcloneService, private ngZone: NgZone) {
    this.initializeWindowListeners();
    this.updateViewportSettings();
    
    window.addEventListener("resize", () => {
      this.ngZone.run(() => {
        this._isMobile.next(window.innerWidth <= 500);
        this.updateViewportSettings();
      });
    });
  }

  private async initializeWindowListeners() {
    try {
      // Listen for window maximize/unmaximize events
      await listen('tauri://resize', () => {
        this.ngZone.run(() => {
          this.updateWindowState();
        });
      });

      // Initial check
      await this.updateWindowState();
    } catch (error) {
      console.warn('Tauri window events not available:', error);
    }
  }

  private async updateWindowState() {
    const isMaximized = await this.appWindow.isMaximized();
    this._isMaximized.next(isMaximized);
    this.updateViewportSettings();
  }

  private updateViewportSettings() {
    const isMobile = this._isMobile.value;
    const isMaximized = this._isMaximized.value;

    if (isMaximized) {
      document.documentElement.style.setProperty("--home-bottom-radius", "0px");
      document.documentElement.style.setProperty("--title-bar-radius", "0px");
      document.documentElement.style.setProperty("--tab-bar-bottom-radius", "0px");
    } else if (isMobile) {
      document.documentElement.style.setProperty("--home-bottom-radius", "0px");
      document.documentElement.style.setProperty("--title-bar-radius", "16px");
      document.documentElement.style.setProperty("--tab-bar-bottom-radius", "16px");
    } else {
      document.documentElement.style.setProperty("--home-bottom-radius", "16px");
      document.documentElement.style.setProperty("--title-bar-radius", "16px");
      document.documentElement.style.setProperty("--tab-bar-bottom-radius", "0px");
    }

    // Update app height
    const height = isMobile
      ? `calc(100vh - ((var(--titlebar-height) + var(--title-bar-padding)) + 48px)`
      : "calc(100vh - (var(--titlebar-height) + var(--title-bar-padding)))";
    
    document.documentElement.style.setProperty("--app-height", height);
  }

  resetSelectedRemote(): void {
    this.selectedRemoteSource.next(null);
  }

  setSelectedRemote(remote: any): void {
    this.selectedRemoteSource.next(remote);
  }

  setTab(tab: "mount" | "sync" | "copy" | "jobs") {
    this.currentTab.next(tab);
  }

  getCurrentTab() {
    // Return the current tab value
    console.log("Current tab:", this.currentTab.value);

    return this.currentTab.value;
  }

  private _isAuthInProgress$ = new BehaviorSubject<boolean>(false);
  private _currentRemoteName$ = new BehaviorSubject<string | null>(null);
  private _isAuthCancelled$ = new BehaviorSubject<boolean>(false);

  isAuthInProgress$ = this._isAuthInProgress$.asObservable();
  isAuthCancelled$ = this._isAuthCancelled$.asObservable();
  currentRemoteName$ = this._currentRemoteName$.asObservable();

  async startAuth(remoteName: string): Promise<void> {
    this._isAuthInProgress$.next(true);
    this._currentRemoteName$.next(remoteName);
    this._isAuthCancelled$.next(false);
  }

  async cancelAuth(): Promise<void> {
    this._isAuthCancelled$.next(true);
    const remoteName = this._currentRemoteName$.value;
    try {
      if (remoteName) {
        await this.rcloneService.quitOAuth();
        await this.rcloneService.deleteRemote(remoteName);
      }
    } finally {
      this.resetAuthState();
    }
  }

  resetAuthState(): void {
    this._isAuthInProgress$.next(false);
    this._currentRemoteName$.next(null);
    this._isAuthCancelled$.next(false);
  }

  get currentState() {
    return {
      isAuthInProgress: this._isAuthInProgress$.value,
      currentRemoteName: this._currentRemoteName$.value,
    };
  }
}
