import { Injectable, NgZone } from "@angular/core";
import { BehaviorSubject } from "rxjs/internal/BehaviorSubject";
import { RcloneService } from "./rclone.service";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { filter, firstValueFrom, take } from "rxjs";
import { platform } from "@tauri-apps/plugin-os";

@Injectable({
  providedIn: "root",
})
export class StateService {
  private currentTab = new BehaviorSubject<"mount" | "sync" | "copy" | "jobs">(
    "mount"
  );

  private viewportSettings = {
    maximized: {
      radii: {
        homeBottom: "0px",
        titleBar: "0px",
        tabBarBottom: "0px",
      },
    },
    mobile: {
      radii: {
        homeBottom: "0px",
        titleBar: "16px",
        tabBarBottom: "16px",
      },
    },
    default: {
      radii: {
        homeBottom: "16px",
        titleBar: "16px",
        tabBarBottom: "0px",
      },
    },
  };

  private selectedRemoteSource = new BehaviorSubject<any>(null);
  private _isMobile = new BehaviorSubject<boolean>(window.innerWidth <= 600);
  private _isMaximized = new BehaviorSubject<boolean>(false);

  selectedRemote$ = this.selectedRemoteSource.asObservable();
  currentTab$ = this.currentTab.asObservable();
  isMobile$ = this._isMobile.asObservable();
  isMaximized$ = this._isMaximized.asObservable();

  private appWindow = getCurrentWindow();

  constructor(private rcloneService: RcloneService, private ngZone: NgZone) {
    this.initializeWindowListeners();
    this.updateViewportSettings();
    this.setupRemoteDeletionListener();

    window.addEventListener("resize", () => {
      this.ngZone.run(() => {
        this._isMobile.next(window.innerWidth <= 600);
        this.updateViewportSettings();
      });
    });
      this.appWindow.listen("reset-ui", () => {
    this.ngZone.run(() => this.resetAppState());
  });
  }

  // Add this new method
  private _showToast$ = new BehaviorSubject<{
    message: string;
    type: "success" | "error";
  } | null>(null);
  showToast$ = this._showToast$.asObservable();

  // Update the deletion listener
  private async setupRemoteDeletionListener() {
    try {
      await listen<string>("remote_deleted", (event) => {
        this.ngZone.run(() => {
          const deletedRemoteName = event.payload;
          const currentRemote = this.selectedRemoteSource.value;

          if (currentRemote?.remoteSpecs?.name === deletedRemoteName) {
            this.resetSelectedRemote();
            this._showToast$.next({
              message: `Remote ${deletedRemoteName} deleted`,
              type: "success",
            });
          }
        });
      });
    } catch (error) {
      console.warn("Failed to setup remote deletion listener:", error);
    }
  }

  private async initializeWindowListeners() {
    try {
      // Listen for window maximize/unmaximize events
      await listen("tauri://resize", () => {
        this.ngZone.run(() => {
          this.updateWindowState();
        });
      });

      // Initial check
      await this.updateWindowState();
    } catch (error) {
      console.warn("Tauri window events not available:", error);
    }
  }

  private async updateWindowState() {
    let isMaximized = false;
    const currentPlatform = await platform();

    if (currentPlatform === "macos") {
      // On macOS, always set maximized to true and set all radii to 0
      isMaximized = true;
      this._isMaximized.next(isMaximized);
      document.documentElement.style.setProperty("--home-bottom-radius", "0px");
      document.documentElement.style.setProperty("--title-bar-radius", "0px");
      document.documentElement.style.setProperty(
        "--tab-bar-bottom-radius",
        "0px"
      );
      return;
    }
    // For other platforms, check if the window is maximized. Also when we listen to isMaximized, its cause the infinite loop
    // on macOS. So we need to check if the platform is macOS and if it is, we don't set the isMaximized.
    isMaximized = await this.appWindow.isMaximized();
    this._isMaximized.next(isMaximized);
    this.updateViewportSettings();
  }

  private updateViewportSettings() {
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
      "--home-bottom-radius",
      settings.radii.homeBottom
    );
    document.documentElement.style.setProperty(
      "--title-bar-radius",
      settings.radii.titleBar
    );
    document.documentElement.style.setProperty(
      "--tab-bar-bottom-radius",
      settings.radii.tabBarBottom
    );

    // Update app height
    const height = isMobile
      ? `calc(100vh - ((var(--titlebar-height) + var(--title-bar-padding)) + 48px)`
      : "calc(100vh - (var(--titlebar-height) + var(--title-bar-padding))";

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
  private _isEditMode$ = new BehaviorSubject<boolean>(false);
  private _cleanupInProgress$ = new BehaviorSubject<boolean>(false);

  isAuthInProgress$ = this._isAuthInProgress$.asObservable();
  isAuthCancelled$ = this._isAuthCancelled$.asObservable();
  currentRemoteName$ = this._currentRemoteName$.asObservable();
  cleanupInProgress$ = this._cleanupInProgress$.asObservable();

  async startAuth(remoteName: string, isEditMode: boolean): Promise<void> {
    if (this._cleanupInProgress$.value) {
      console.log("Waiting for previous cleanup to complete");
      await firstValueFrom(
        this._cleanupInProgress$.pipe(
          filter((inProgress) => !inProgress),
          take(1)
        )
      );
    }

    this._isAuthInProgress$.next(true);
    this._currentRemoteName$.next(remoteName);
    this._isAuthCancelled$.next(false);
    this._isEditMode$.next(isEditMode);
    console.log(
      "Starting auth for remote:",
      remoteName,
      "in edit mode:",
      isEditMode
    );
  }

  async cancelAuth(): Promise<void> {
    if (this._cleanupInProgress$.value) {
      console.log("Cleanup already in progress");
      return;
    }

    this._cleanupInProgress$.next(true);
    try {
      this._isAuthCancelled$.next(true);
      const remoteName = this._currentRemoteName$.value;
      const isEditMode = this._isEditMode$.value;
      console.log(
        "Cancelling auth for remote:",
        remoteName,
        "in edit mode:",
        isEditMode
      );

      await this.rcloneService.quitOAuth();

      if (remoteName && !isEditMode) {
        console.log("Deleting remote:", remoteName);
        console.log(
          "Cancelling auth for remote:",
          remoteName,
          "in edit mode:",
          isEditMode
        );

        try {
          await this.rcloneService.deleteRemote(remoteName);
        } catch (error) {
          console.error("Error deleting remote:", error);
        }
      }
    } finally {
      this.resetAuthState();
      this._cleanupInProgress$.next(false);
    }
  }

  resetAuthState(): void {
    this._isAuthInProgress$.next(false);
    this._currentRemoteName$.next(null);
    this._isAuthCancelled$.next(false);
    this._isEditMode$.next(false);
    console.log("Auth state reset");
  }

  resetAppState(): void {
    this.resetSelectedRemote();
    this.resetAuthState();
    this._showToast$.next(null);
    this.setTab("mount");
  }
}
