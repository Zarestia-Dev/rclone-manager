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
import { OverviewComponent } from "../components/overview/overview.component";
import { RemoteDetailComponent } from "../components/remote-detail/remote-detail.component";
import { QuickAddRemoteComponent } from "../modals/quick-add-remote/quick-add-remote.component";

@Component({
  selector: "app-home",
  imports: [
    MatSidenavModule,
    MatDividerModule,
    MatChipsModule,
    CommonModule,
    MatCardModule,
    MatTooltipModule,
    SidebarComponent,
    OverviewComponent,
    RemoteDetailComponent,
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
  remoteSettings: any[] = [];
  mountedRemotes: { fs: string; mount_point: string }[] = [];

  constructor(
    private dialog: MatDialog,
    private stateService: StateService,
    private rcloneService: RcloneService,
    private settingservice: SettingsService
  ) {}

  async ngOnInit(): Promise<void> {
    this.updateSidebarMode();

    this.stateService.selectedRemote$.subscribe((remote) => {
      this.selectedRemote = remote;
    });

    await this.refreshMounts();
    await this.loadRemotes();
    await this.getRemoteSettings();
  }

  @HostListener("window:resize", [])
  onResize() {
    this.updateSidebarMode();
  }

  private updateSidebarMode() {
    if (window.innerWidth < 900) {
      this.sidebarMode = "over";
    } else {
      this.sidebarMode = "side";
    }
  }

  async openRemoteInFiles(remoteName: any): Promise<void> {
    const mountPoint =
      this.loadRemoteSettings(remoteName)?.mount_options?.mount_point;
    console.log("Opening Files at:", mountPoint);
    await this.rcloneService.openInFiles(mountPoint);
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

  openRemoteConfigModal(editTarget?: string, existingConfig?: any[]): void {
    this.dialog.open(RemoteConfigModalComponent, {
      width: "70vw",
      maxWidth: "800px",
      height: "80vh",
      maxHeight: "600px",
      disableClose: true,

      data: {
        editTarget: editTarget,  // 🔹 Edit only mount settings
        existingConfig: existingConfig,
      },
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
    const remoteNames = this.remotes.map((remote) => remote.remoteSpecs.name);
    this.remoteSettings = await Promise.all(
      remoteNames.map(async (name) => {
        return await this.settingservice.getRemoteSettings(name);
      })
    );
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
  loadRemoteSettings(remoteName: string): any {
    const all_settings = this.remoteSettings.find(
      (config) => config?.name === remoteName
    );
    return all_settings;
  }

  // Mount a remote
  async mountRemote(remoteName: string): Promise<void> {
    const remoteSettings = this.loadRemoteSettings(remoteName);
    if (!remoteSettings.mount_options.mount_point) {
      console.warn(`No mount point found for ${remoteName}`);
      return;
    }

    try {
      await this.rcloneService.mountRemote(
        remoteName,
        remoteSettings.mount_options.mount_point,
        remoteSettings.mount_options,
        remoteSettings.vfs_options
      );
      await this.refreshMounts();
      await this.loadRemotes();
      console.log(`Mounted ${remoteName} at ${remoteSettings.mount_options.mount_point}`);
    } catch (error) {
      console.error(`Failed to mount ${remoteName}:`, error);
    }
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
      console.log(`Unmounted ${remoteName} from ${mountPoint}`);
    } catch (error) {
      console.error(`Failed to unmount ${remoteName}:`, error);
    }
  }

  // Add a mount
  async addMount(remote: any): Promise<void> {
    const mountPoint = this.loadRemoteSettings(remote.remoteSpecs.name)
      ?.mount_options?.mount_path;
    if (!mountPoint) {
      console.warn(`No mount point found for ${remote.remoteSpecs.name}`);
      return;
    }

    await this.rcloneService.addMount(remote.remoteSpecs.name, mountPoint);
  }

  // Remove a mount
  async removeMount(remote: any): Promise<void> {
    await this.rcloneService.removeMount(remote.remoteSpecs.name);
  }

  ngOnDestroy(): void {
    this.stateService.resetSelectedRemote();
  }
}
