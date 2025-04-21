import { Host, HostListener, Injectable } from "@angular/core";
import { listen } from "@tauri-apps/api/event";
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

  private remotesSubject = new BehaviorSubject<any[]>([]);
  remotes$ = this.remotesSubject.asObservable();

  private _isMobile = new BehaviorSubject<boolean>(window.innerWidth <= 768);
  public isMobile$ = this._isMobile.asObservable();

  constructor(private rcloneService: RcloneService) {
    listen("remote-update", () => {
      this.refreshRemotes();
    });

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

  async refreshRemotes() {
    const remotes = await this.rcloneService.getRemotes();
    this.remotesSubject.next(remotes);
    console.log("Remotes updated:", remotes);
  }

  setTab(tab: "mount" | "sync" | "copy" | "jobs") {
    this.currentTab.next(tab);
  }

  getCurrentTab() {
    // Return the current tab value
    console.log("Current tab:", this.currentTab.value);

    return this.currentTab.value;
  }
}
