import { Host, HostListener, Injectable } from "@angular/core";
import { BehaviorSubject } from "rxjs/internal/BehaviorSubject";
import { RcloneService } from "./rclone.service";

@Injectable({
  providedIn: "root",
})
export class StateService {
  private currentTab = new BehaviorSubject<"mount" | "sync" | "copy" | "jobs">(
    "mount"
  );
  private selectedRemoteSource = new BehaviorSubject<any>(null);
  selectedRemote$ = this.selectedRemoteSource.asObservable();
  currentTab$ = this.currentTab.asObservable();

  private _isMobile = new BehaviorSubject<boolean>(window.innerWidth <= 768);
  public isMobile$ = this._isMobile.asObservable();

  constructor(private rcloneService: RcloneService) {

    this.updateMobileStatus();
    window.addEventListener("resize", this.updateMobileStatus.bind(this));
  }

  @HostListener("window:resize", ["$event"])
  private updateMobileStatus() {
    const isMobile = window.innerWidth <= 500;
    this._isMobile.next(isMobile);

    if (isMobile) {
      document.documentElement.style.setProperty(
        "--app-height",
        `calc(100vh - ((var(--titlebar-height) + var(--title-bar-padding) + var(--titlebar-border)) + 48px))`
      );
    } else {
      document.documentElement.style.setProperty(
        "--app-height",
        "calc(100vh - (var(--titlebar-height) + var(--title-bar-padding) + var(--titlebar-border)))"
      );
      console.log("Desktop view");
    }
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
        await this.rcloneService.deleteRemote(remoteName, false);
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
      currentRemoteName: this._currentRemoteName$.value
    };
  }
}
