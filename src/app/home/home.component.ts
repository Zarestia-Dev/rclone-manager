import { Component, HostListener } from "@angular/core";
import { CommonModule } from "@angular/common";
import { MatDrawerMode, MatSidenavModule } from "@angular/material/sidenav";
import { MatCardModule } from "@angular/material/card";
import { MatDividerModule } from "@angular/material/divider";
import { MatChipsModule } from "@angular/material/chips";
import { MatDialog } from "@angular/material/dialog";
import { RemoteConfigModalComponent } from "../modals/remote-config-modal/remote-config-modal.component";
import { StateService } from "../services/state.service";
import { RcloneService } from "../services/rclone.service";
import {
  ConfirmDialogData,
  ConfirmModalComponent,
} from "../modals/confirm-modal/confirm-modal.component";
import { SettingsService } from "../services/settings.service";
import { MatTooltipModule } from "@angular/material/tooltip";
import { SidebarComponent } from "../components/sidebar/sidebar.component";
import { QuickAddRemoteComponent } from "../modals/quick-add-remote/quick-add-remote.component";
import { MountOverviewComponent } from "../components/overviews/mount-overview/mount-overview.component";
import { SyncOverviewComponent } from "../components/overviews/sync-overview/sync-overview.component";
import { CopyOverviewComponent } from "../components/overviews/copy-overview/copy-overview.component";
import { JobsOverviewComponent } from "../components/overviews/jobs-overview/jobs-overview.component";
import { MountDetailComponent } from "../components/details/mount-detail/mount-detail.component";
import { MatSlideToggleModule } from "@angular/material/slide-toggle";
import { MatMenuModule } from "@angular/material/menu";
import { MatIconModule } from "@angular/material/icon";
import { SyncDetailComponent } from "../components/details/sync-detail/sync-detail.component";
import { CopyDetailComponent } from "../components/details/copy-detail/copy-detail.component";
import { JobDetailComponent } from "../components/details/job-detail/job-detail.component";

@Component({
  selector: "app-home",
  imports: [
    MatSidenavModule,
    MatDividerModule,
    MatChipsModule,
    CommonModule,
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
    JobDetailComponent
],
  templateUrl: "./home.component.html",
  styleUrl: "./home.component.scss",
})
export class HomeComponent {
  isSidebarOpen = false;
  sidebarMode: MatDrawerMode = "side";
  selectedRemote: any = null;
  remotes: any[] = [];
  mountTypes: any[] = [];
  remoteSettings: Record<string, Record<string, any>> = {};
  mountedRemotes: { fs: string; mount_point: string }[] = [];
  currentTab: "mount" | "sync" | "copy" | "jobs" = "mount";

  constructor(
    private dialog: MatDialog,
    private stateService: StateService,
    private rcloneService: RcloneService,
    private settingservice: SettingsService
  ) {}

  @HostListener("window:resize", [])
  onResize() {
    this.updateSidebarMode();
  }

  ngOnInit() {
    this.updateSidebarMode();
    this.setupSubscriptions();
    this.loadInitialData();
  }

  private updateSidebarMode() {
    if (window.innerWidth < 900) {
      this.sidebarMode = "over";
    } else {
      this.sidebarMode = "side";
    }
  }

  private setupSubscriptions() {
    this.stateService.currentTab$.subscribe((tab) => (this.currentTab = tab));
    this.stateService.selectedRemote$.subscribe(
      (remote) => (this.selectedRemote = remote)
    );
  }

  private async loadInitialData() {
    await this.refreshMounts();
    await this.loadRemotes();
    await this.getRemoteSettings();
  }

  getRemoteSettingValue(remoteName: string, key: string): any {
    return this.remoteSettings[remoteName]?.[key];
  }

  resetRemoteSettings() {
    this.settingservice.resetRemoteSettings(
      this.selectedRemote?.remoteSpecs?.name
    );
  }

  deleteRemoteByName() {
    const remoteName = this.selectedRemote?.remoteSpecs?.name;
    if (remoteName) {
      this.deleteRemote(remoteName);
    }
  }

  async openRemoteInFiles(remoteName: any): Promise<void> {
    const mountPoint =
      this.loadRemoteSettings(remoteName)?.mount_options?.mount_point;
    console.log("Opening Files at:", mountPoint);
    await this.rcloneService.openInFiles(mountPoint);
  }

  saveRemoteSettings(remoteName: string, settings: any): void {
    console.log("Saving Remote Settings:", remoteName, settings);
    this.settingservice.saveRemoteSettings(remoteName, settings);
  }

  openQuickAddRemoteModal(): void {
    this.dialog.open(QuickAddRemoteComponent, {
      width: "70vw",
      maxWidth: "800px",
      height: "80vh",
      maxHeight: "600px",
      disableClose: true,
    });
  }

  openRemoteConfigModal(editTarget?: string, existingConfig?: any[]) {
    const dialogRef = this.dialog.open(RemoteConfigModalComponent, {
      width: "70vw",
      maxWidth: "800px",
      height: "80vh",
      maxHeight: "600px",
      disableClose: true,

      data: {
        name: this.selectedRemote?.remoteSpecs?.name,
        editTarget: editTarget, // 🔹 Edit only mount settings
        existingConfig: existingConfig,
      },
    });

    dialogRef.afterClosed().subscribe((result) => {
      if (result) {
        console.log("Remote Config Modal Result:", result);
        this.loadRemotes();
      }
    });
  }

  deleteRemote(remoteName: any) {
    // Create the confirmation dialog data
    const dialogData: ConfirmDialogData = {
      title: "Delete Confirmation",
      message: `Are you sure you want to delete '${remoteName}'? This action cannot be undone.`,
      confirmText: "Yes, Delete",
      cancelText: "Cancel",
    };

    // Open the confirmation dialog
    const dialogRef = this.dialog.open(ConfirmModalComponent, {
      width: "300px",
      data: dialogData,
    });

    // Wait for user response
    dialogRef.afterClosed().subscribe((confirmed) => {
      if (confirmed) {
        try {
          // Delete the remote
          this.rcloneService.deleteRemote(remoteName).then(() => {
            this.remotes = this.remotes.filter(
              (r) => r.remoteSpecs.name !== remoteName
            );
          });
          this.selectedRemote = null;
          this.remotes = this.remotes.filter(
            (r) => r.remoteSpecs.name !== remoteName
          );
        } catch (error) {
          console.error(`Failed to delete remote: ${remoteName}`, error);
        }
      }
    });
  }

  // Select a remote for editing
  selectRemote(remote: any) {
    console.log("Selected Remote:", remote);
    const updatedRemote = this.remotes.find(
      (r) => r.remoteSpecs.name === remote.remoteSpecs.name
    );
    this.selectedRemote = updatedRemote ? { ...updatedRemote } : null;
  }

  // Load all remotes with their configurations & mount status
  async loadRemotes(): Promise<void> {
    const remoteConfigs = await this.rcloneService.getAllRemoteConfigs();
    console.log("Remote Configs:", remoteConfigs);
    const remoteNames = Object.keys(remoteConfigs);

    this.remotes = await Promise.all(
      remoteNames.map(async (name) => {
        const mounted = this.isRemoteMounted(name);
        console.log(`Remote ${name} is mounted:`, mounted);

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

    console.log("Loaded Remotes:", this.remotes);
  }

  // Load all saved mount configurations
  async getRemoteSettings(): Promise<void> {
    this.remoteSettings = await this.settingservice.getRemoteSettings();
    console.log("Saved Mount Configs:", this.remoteSettings);
  }

  // Refresh the list of mounted remotes
  async refreshMounts(): Promise<void> {
    this.mountedRemotes = await this.rcloneService.getMountedRemotes();
  }

  // Check if a remote is currently mounted
  isRemoteMounted(remoteName: string): boolean {
    return this.mountedRemotes.some((mount) => mount.fs === `${remoteName}:`);
  }

  // Get saved mount configuration for a remote
  loadRemoteMountSettings(remoteName: string): any {
    const all_settings = Object.values(this.remoteSettings).find(
      (config: any) => config?.name === remoteName
    );
    console.log("Loaded Remote Mount Settings:", all_settings);
    return {
      mount_options: all_settings?.["mount_options"],
      vfs_options: all_settings?.["vfs_options"],
    };
  }

  loadRemoteSyncSettings(remoteName: string): any {
    const all_settings = Object.values(this.remoteSettings).find(
      (config: any) => config?.name === remoteName
    );
    return {
      sync_options: all_settings?.["sync_options"],
      filter_options: all_settings?.["filter_options"],
    };
  }

  loadRemoteCopySettings(remoteName: string): any {
    const all_settings = Object.values(this.remoteSettings).find(
      (config: any) => config?.name === remoteName
    );
    return {
      copy_options: all_settings?.["copy_options"],
      filter_options: all_settings?.["filter_options"],
    };
  }

  loadRemoteSettings(remoteName: string): any {
    const all_settings = Object.values(this.remoteSettings).find(
      (config: any) => config?.name === remoteName
    );
    return all_settings;
  }

  // Mount a remote
  async mountRemote(remoteName: string): Promise<void> {
    const { mount_options, vfs_options } = this.loadRemoteSettings(remoteName);
    if (!mount_options?.mount_point) {
      console.warn(`Mount point is missing for ${remoteName}`);
      return;
    }

    try {
      await this.rcloneService.mountRemote(
        remoteName,
        mount_options.mount_point,
        mount_options,
        vfs_options
      );
      await this.refreshMounts();
      await this.loadRemotes();
      this.selectRemoteByName(remoteName);
    } catch (error) {
      console.error(`Failed to mount ${remoteName}:`, error);
    }
  }

  selectRemoteByName(remoteName: string) {
    const remote = this.remotes.find((r) => r.remoteSpecs.name === remoteName);
    if (remote) this.selectedRemote = { ...remote };
  }

  // Unmount a remote
  async unmountRemote(remoteName: string): Promise<void> {
    const mountPoint = this.mountedRemotes.find(
      (mount) => mount.fs === `${remoteName}:`
    )?.mount_point;

    if (!mountPoint) {
      console.warn(`No mount point found for ${remoteName}`);
      return;
    }

    try {
      await this.rcloneService.unmountRemote(mountPoint);
      await this.refreshMounts();
      await this.loadRemotes();
      this.selectRemote(
        this.remotes.find((remote) => remote.remoteSpecs.name === remoteName)
      );
      console.log(`Unmounted ${remoteName} from ${mountPoint}`);
    } catch (error) {
      console.error(`Failed to unmount ${remoteName}:`, error);
    }
  }

  ngOnDestroy(): void {
    this.stateService.resetSelectedRemote();
  }
}
