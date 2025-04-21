import { Component, HostListener, OnDestroy, OnInit } from "@angular/core";
import { CommonModule } from "@angular/common";
import { MatDrawerMode, MatSidenavModule } from "@angular/material/sidenav";
import { MatCardModule } from "@angular/material/card";
import { MatDividerModule } from "@angular/material/divider";
import { MatChipsModule } from "@angular/material/chips";
import { MatDialog } from "@angular/material/dialog";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatSlideToggleModule } from "@angular/material/slide-toggle";
import { MatMenuModule } from "@angular/material/menu";
import { MatIconModule } from "@angular/material/icon";
import { listen } from "@tauri-apps/api/event";

// Components
import { SidebarComponent } from "../components/sidebar/sidebar.component";
import { RemoteConfigModalComponent } from "../modals/remote-config-modal/remote-config-modal.component";
import { QuickAddRemoteComponent } from "../modals/quick-add-remote/quick-add-remote.component";
import { MountOverviewComponent } from "../components/overviews/mount-overview/mount-overview.component";
import { SyncOverviewComponent } from "../components/overviews/sync-overview/sync-overview.component";
import { CopyOverviewComponent } from "../components/overviews/copy-overview/copy-overview.component";
import { JobsOverviewComponent } from "../components/overviews/jobs-overview/jobs-overview.component";
import { MountDetailComponent } from "../components/details/mount-detail/mount-detail.component";
import { SyncDetailComponent } from "../components/details/sync-detail/sync-detail.component";
import { CopyDetailComponent } from "../components/details/copy-detail/copy-detail.component";
import { JobDetailComponent } from "../components/details/job-detail/job-detail.component";

// Services
import { StateService } from "../services/state.service";
import { RcloneService } from "../services/rclone.service";
import { SettingsService } from "../services/settings.service";
import { Subject, takeUntil } from "rxjs";

// Types
type AppTab = "mount" | "sync" | "copy" | "jobs";
interface Remote {
  remoteSpecs: {
    name: string;
    [key: string]: any;
  };
  mounted: boolean;
  diskUsage: {
    total_space: string;
    used_space: string;
    free_space: string;
  };
}

interface MountedRemote {
  fs: string;
  mount_point: string;
}

type ModalSize = {
  width: string;
  maxWidth: string;
  minWidth: string;
  height: string;
  maxHeight: string;
};

const STANDARD_MODAL_SIZE: ModalSize = {
  width: "90vw",
  maxWidth: "642px",
  minWidth: "360px",
  height: "80vh",
  maxHeight: "600px",
};

@Component({
  selector: "app-home",
  standalone: true,
  imports: [
    CommonModule,
    MatSidenavModule,
    MatDividerModule,
    MatChipsModule,
    MatCardModule,
    MatTooltipModule,
    MatSlideToggleModule,
    MatMenuModule,
    MatIconModule,
    SidebarComponent,
    MountOverviewComponent,
    SyncOverviewComponent,
    CopyOverviewComponent,
    JobsOverviewComponent,
    MountDetailComponent,
    SyncDetailComponent,
    CopyDetailComponent,
    JobDetailComponent,
  ],
  templateUrl: "./home.component.html",
  styleUrls: ["./home.component.scss"],
})
export class HomeComponent implements OnInit, OnDestroy {
  // UI State
  isSidebarOpen = false;
  sidebarMode: MatDrawerMode = "side";
  currentTab: AppTab = "mount";

  // Data State
  remotes: Remote[] = [];
  mountedRemotes: MountedRemote[] = [];
  selectedRemote: Remote | null = null;
  remoteSettings: Record<string, Record<string, any>> = {};

  // Cleanup
  private destroy$ = new Subject<void>();
  private resizeObserver?: ResizeObserver;

  constructor(
    private dialog: MatDialog,
    private stateService: StateService,
    private rcloneService: RcloneService,
    private settingsService: SettingsService
  ) {}

  // Lifecycle Hooks
  ngOnInit(): void {
    this.setupResponsiveLayout();
    this.setupSubscriptions();
    this.loadInitialData();
    this.setupTauriListeners();
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  // Event Handlers
  @HostListener("window:resize")
  onResize(): void {
    this.updateSidebarMode();
  }

  private openModal(component: any, size: ModalSize, data?: any): void {
    const dialogRef = this.dialog.open(component, {
      ...size,
      disableClose: true,
      data: data,
    });
  }

  // Public Methods
  openQuickAddRemoteModal(): void {
    this.openModal(QuickAddRemoteComponent, STANDARD_MODAL_SIZE);
  }

  openRemoteConfigModal(editTarget?: string, existingConfig?: any[]): void {
    this.openModal(RemoteConfigModalComponent, STANDARD_MODAL_SIZE, {
      name: this.selectedRemote?.remoteSpecs.name,
      editTarget,
      existingConfig,
    });
  }

  async mountRemote(remoteName: string): Promise<void> {
    const settings = this.loadRemoteSettings(remoteName);
    if (!settings?.mount_options?.mount_point) {
      console.warn(`Mount point is missing for ${remoteName}`);
      return;
    }

    try {
      await this.rcloneService.mountRemote(
        remoteName,
        settings.mount_options.mount_point,
        settings.mount_options,
        settings.vfs_options
      );
      await this.refreshData();
      this.selectRemoteByName(remoteName);
    } catch (error) {
      console.error(`Failed to mount ${remoteName}:`, error);
    }
  }

  async unmountRemote(remoteName: string): Promise<void> {
    const mountPoint = this.getMountPoint(remoteName);
    if (!mountPoint) {
      console.warn(`No mount point found for ${remoteName}`);
      return;
    }

    try {
      await this.rcloneService.unmountRemote(mountPoint);
      await this.refreshData();
      this.selectRemoteByName(remoteName);
    } catch (error) {
      console.error(`Failed to unmount ${remoteName}:`, error);
    }
  }

  async deleteRemote(remoteName: string): Promise<void> {
    try {
      await this.rcloneService.deleteRemote(remoteName);
      this.remotes = this.remotes.filter(
        (r) => r.remoteSpecs.name !== remoteName
      );
      this.selectedRemote = null;
    } catch (error) {
      console.error(`Failed to delete remote: ${remoteName}`, error);
    }
  }

  selectRemote(remote: Remote): void {
    this.selectedRemote = { ...remote };
  }

  // Helper Methods
  private async refreshData(): Promise<void> {
    await Promise.all([
      this.refreshMounts(),
      this.loadRemotes(),
      this.getRemoteSettings(),
    ]);
  }

  private getMountPoint(remoteName: string): string | undefined {
    return this.mountedRemotes.find((mount) => mount.fs === `${remoteName}:`)
      ?.mount_point;
  }

  private isRemoteMounted(remoteName: string): boolean {
    return this.mountedRemotes.some((mount) => mount.fs === `${remoteName}:`);
  }

  private selectRemoteByName(remoteName: string): void {
    const remote = this.remotes.find((r) => r.remoteSpecs.name === remoteName);
    if (remote) this.selectedRemote = { ...remote };
  }

  // Initialization Methods
  private setupResponsiveLayout(): void {
    this.updateSidebarMode();
    this.setupResizeObserver();
  }

  private updateSidebarMode(): void {
    this.sidebarMode = window.innerWidth < 900 ? "over" : "side";
  }

  private setupResizeObserver(): void {
    if (typeof window !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.updateSidebarMode());
      this.resizeObserver.observe(document.body);
    }
  }

  private setupSubscriptions(): void {
    this.stateService.currentTab$
      .pipe(takeUntil(this.destroy$))
      .subscribe((tab) => (this.currentTab = tab));

    this.stateService.selectedRemote$
      .pipe(takeUntil(this.destroy$))
      .subscribe((remote) => (this.selectedRemote = remote));
  }

  private async loadInitialData(): Promise<void> {
    await this.refreshData();
  }

  private setupTauriListeners(): void {
    const events = ["mount_cache_updated", "remote_cache_updated"];

    events.forEach((event) => {
      listen<string>(event, async () => {
        try {
          await this.refreshData();
        } catch (error) {
          console.error(`Error handling ${event}:`, error);
        }
      });
    });
  }

  // Cleanup
  private cleanup(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.resizeObserver?.disconnect();
    this.stateService.resetSelectedRemote();
  }

  // Remote Settings Methods
  loadRemoteSettings(remoteName: string): any {
    return Object.values(this.remoteSettings).find(
      (config) => config?.["name"] === remoteName
    );
  }

  getRemoteSettingValue(remoteName: string, key: string): any {
    return this.remoteSettings[remoteName]?.[key];
  }

  saveRemoteSettings(remoteName: string, settings: any): void {
    this.settingsService.saveRemoteSettings(remoteName, settings);
  }

  resetRemoteSettings(): void {
    if (this.selectedRemote?.remoteSpecs.name) {
      this.settingsService.resetRemoteSettings(
        this.selectedRemote.remoteSpecs.name
      );
    }
  }

  // Data Loading Methods
  private async loadRemotes(): Promise<void> {
    try {
      const remoteConfigs = await this.rcloneService.getAllRemoteConfigs();
      this.remotes = await Promise.all(
        Object.keys(remoteConfigs).map(async (name) => {
          const mounted = this.isRemoteMounted(name);
          let diskUsage = {
            total_space: "N/A",
            used_space: "N/A",
            free_space: "N/A",
          };

          if (mounted) {
            try {
              const usage = await this.rcloneService.getDiskUsage(name);
              diskUsage = {
                total_space: usage.total || "N/A",
                used_space: usage.used || "N/A",
                free_space: usage.free || "N/A",
              };
            } catch (error) {
              console.error(`Failed to fetch disk usage for ${name}:`, error);
            }
          }

          return {
            remoteSpecs: { name, ...remoteConfigs[name] },
            mounted,
            diskUsage,
          };
        })
      );
    } catch (error) {
      console.error("Failed to load remotes:", error);
    }
  }

  private async getRemoteSettings(): Promise<void> {
    this.remoteSettings = await this.settingsService.getRemoteSettings();
  }

  private async refreshMounts(): Promise<void> {
    this.mountedRemotes = await this.rcloneService.getMountedRemotes();
  }

  // Utility Methods
  async openRemoteInFiles(remoteName: string): Promise<void> {
    const mountPoint =
      this.loadRemoteSettings(remoteName)?.mount_options?.mount_point;
    if (mountPoint) {
      await this.rcloneService.openInFiles(mountPoint);
    }
  }
}
