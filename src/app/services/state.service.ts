import { Injectable } from "@angular/core";
import { listen } from "@tauri-apps/api/event";
import { BehaviorSubject } from "rxjs/internal/BehaviorSubject";
import { RcloneService } from "./rclone.service";

@Injectable({
  providedIn: "root",
})
export class StateService {
  private currentTab = new BehaviorSubject<'mount' | 'sync' | 'copy' | 'jobs'>('mount');
  private selectedRemoteSource = new BehaviorSubject<any>(null);
  selectedRemote$ = this.selectedRemoteSource.asObservable();
  currentTab$ = this.currentTab.asObservable();

  private remotesSubject = new BehaviorSubject<any[]>([]);
  remotes$ = this.remotesSubject.asObservable();

  constructor(private rcloneService: RcloneService) {
    listen("remote-update", () => {
      this.refreshRemotes();
    });
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



  setTab(tab: 'mount' | 'sync' | 'copy' | 'jobs') {
    this.currentTab.next(tab);
  }

  getCurrentTab() {
    // Return the current tab value
    console.log("Current tab:", this.currentTab.value);
    
    return this.currentTab.value;
  }

}
