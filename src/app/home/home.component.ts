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

@Component({
  selector: "app-home",
  standalone: true,
  imports: [
    MatSidenavModule,
    MatDividerModule,
    MatChipsModule,
    CommonModule,
    MatCardModule,
  ],
  templateUrl: "./home.component.html",
  styleUrl: "./home.component.scss",
})
export class HomeComponent {
  isSidebarOpen = true;
  sidebarMode: MatDrawerMode = "side";
  selectedRemote: any = null;
  remotes: any[] = [];
  mountTypes: any[] = [];
  savedMountConfigs: any[] = [];
  mountedRemotes: { fs: string; mount_point: string }[] = [];

  constructor(
    private dialog: MatDialog,
    private stateService: StateService,
    private rcloneService: RcloneService
  ) {}

  async ngOnInit(): Promise<void> {
    const savedState = localStorage.getItem("sidebarState");
    this.isSidebarOpen = savedState === "true";
    this.updateSidebarMode();

    this.stateService.selectedRemote$.subscribe((remote) => {
      this.selectedRemote = remote;
    });

    await this.refreshMounts();
    await this.loadRemotes();
    await this.loadMountTypes();
    await this.loadSavedMountConfigs();
  }

  async openFiles(remoteName: any): Promise<void> {
    const mountPoint = this.loadSavedMountConfig(remoteName)?.mount_path;
    await this.rcloneService.openInFiles(mountPoint);
  }

  // Select a remote for editing
  selectRemote(remote: any) {
    this.selectedRemote = { ...remote }; // Clone object to prevent direct modification
  }

  // Get only mounted remotes
  getMountedRemotes() {
    return this.remotes.filter((remote) => remote.mounted === "true");
  }

  // Get only unmounted remotes
  getUnmountedRemotes() {
    return this.remotes.filter((remote) => remote.mounted === "false");
  }

  // Get only remotes with errors
  getErrorRemotes() {
    return this.remotes.filter((remote) => remote.mounted === "error");
  }

  // Count different remote states
  getMountedCount() {
    return this.getMountedRemotes().length;
  }

  getUnmountedCount() {
    return this.getUnmountedRemotes().length;
  }

  getErrorCount() {
    return this.getErrorRemotes().length;
  }

  getUsagePercentage(remote: any): number {
    const used = parseFloat(remote.diskUsage.used_space) || 0;
    const total = parseFloat(remote.diskUsage.total_space) || 1;
    return (used / total) * 100;
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

  ngOnDestroy(): void {
    localStorage.setItem("sidebarState", String(this.isSidebarOpen));
  }

  toggleSidebar(): void {
    this.isSidebarOpen = !this.isSidebarOpen;
    localStorage.setItem("sidebarState", String(this.isSidebarOpen));
  }

  async openRemoteConfigModal(existingConfig?: any, type?: "remote" | "mount"): Promise<void> {
    let mountConfig = {};
  
    if (type === "mount" && this.selectedRemote) {
      try {
        mountConfig = await this.loadSavedMountConfig(this.selectedRemote.remoteSpecs.name);
        console.log("Loaded saved mount config:", mountConfig);
      } catch (error) {
        console.error("Failed to load saved mount config:", error);
      }
    }
  
    const dialogRef = this.dialog.open(RemoteConfigModalComponent, {
      width: "70vw",
      maxWidth: "800px",
      height: "80vh",
      maxHeight: "600px",
      disableClose: true,
      data: {
        editMode: true,
        editTarget: type,
        existingConfig: existingConfig
          ? { ...existingConfig, mountSpecs: existingConfig.mountSpecs || {} }
          : {
              remoteSpecs: {
                name: this.selectedRemote?.remoteSpecs.name || "",
              },
              mountSpecs: mountConfig || {},
            },
      },
    });
  
    dialogRef.afterClosed().subscribe((result) => {
      if (result) {
        console.log("Modal Result:", result);
      }
    });
  }
  

  deleteRemote(remote: any) {
    // Create the confirmation dialog data
    const dialogData: ConfirmDialogData = {
      title: "Delete Confirmation",
      message: `Are you sure you want to delete '${remote.remoteSpecs.name}'? This action cannot be undone.`,
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
        this.rcloneService.deleteRemote(remote.remoteSpecs.name).then(() => {
          this.remotes = this.remotes.filter(
            (r) => r.remoteSpecs.name !== remote.remoteSpecs.name
          );
        });
      }
    });
  }

  /** Fetch all remotes and their configs in one request */
  async loadRemotes(): Promise<void> {
    const remoteConfigs = await this.rcloneService.getAllRemoteConfigs();
    const remoteNames = Object.keys(remoteConfigs);
    console.log(remoteNames);

    this.remotes = await Promise.all(
      remoteNames.map(async (name) => {
        const mountPoint = this.loadSavedMountConfig(name)?.mount_path;
        const mounted = this.isRemoteMounted(name);

        let diskUsage = null;
        if (mounted) {
          try {
            diskUsage = await this.rcloneService.getDiskUsage(mountPoint);
            console.log("Disk Usage for", name, ":", diskUsage);
          } catch (error) {
            console.error("Failed to fetch disk usage:", error);
          }
        }

        return {
          remoteSpecs: { name, ...remoteConfigs[name] },
          mounted: mounted ? "true" : "false",
          diskUsage: diskUsage || {
            total_space: "N/A",
            used_space: "N/A",
            free_space: "N/A",
          },
        };
      })
    );

    console.log("Loaded Remotes with Disk Info:", this.remotes);
  }

  /** Fetch all mount types dynamically */
  async loadMountTypes(): Promise<void> {
    try {
      const response = await this.rcloneService.getMountTypes();
      this.mountTypes = [
        { value: "Native", label: "Native (Direct Mounting)" },
        { value: "Systemd", label: "Systemd Service Mounting" },
        ...response.map((type: string) => ({ value: type, label: type })),
      ];
    } catch (error) {
      console.error("Error fetching mount types:", error);
    }
  }

  /** Get list of mounted remotes */
  async refreshMounts(): Promise<void> {
    this.mountedRemotes = await this.rcloneService.getMountedRemotes();
    console.log("Mounted Remotes:", this.mountedRemotes);
  }

  /** Check if a remote is mounted */
  isRemoteMounted(remoteName: string): boolean {
    return this.mountedRemotes.some((mount) => mount.fs === `${remoteName}:`);
  }

  async loadSavedMountConfigs(): Promise<void> {
    this.savedMountConfigs = await this.rcloneService.getSavedMountConfigs();
    console.log("Loaded Saved Mount Configs:", this.savedMountConfigs);
  }

  loadSavedMountConfig(remoteName: string): any {
    console.log(this.savedMountConfigs.find(
      (config) => config.remote === remoteName
    ));
    
    return this.savedMountConfigs.find(
      (config) => config.remote === remoteName
    );
  }

  /** Mount a remote */
  async mountRemote(remoteName: string): Promise<void> {
    const mountPoint = this.loadSavedMountConfig(remoteName)?.mount_path;
    if (!mountPoint) {
      console.warn(`No mount point found for ${remoteName}`);
      return;
    }
    console.log("Mounting remote:", remoteName, "to:", mountPoint);

    await this.rcloneService.mountRemote(remoteName, mountPoint);
    await this.refreshMounts();
    await this.loadRemotes();
  }

  /** Unmount a remote */
  async unmountRemote(remoteName: string): Promise<void> {
    const mountPoint = this.mountedRemotes.find(
      (mount) => mount.fs === `${remoteName}:`
    )?.mount_point;
    console.log("Unmounting remote:", remoteName, "from:", mountPoint);
    if (!mountPoint) {
      console.warn(`No mount point found for ${remoteName}`);
      return;
    }

    await this.rcloneService.unmountRemote(mountPoint);
    await this.refreshMounts();
    await this.loadRemotes();
  }

  /** Add a mount */
  async addMount(remote: any): Promise<void> {
    const mountPoint = this.loadSavedMountConfig(remote.remoteSpecs.name)?.mount_path;
    await this.rcloneService.addMount(remote.remoteSpecs.name, mountPoint);
    await this.loadMountTypes();
  }

  /** Remove a mount */
  async removeMount(remote: any): Promise<void> {
    await this.rcloneService.removeMount(remote.remoteSpecs.name);
    await this.loadMountTypes();
  }

  isObject(value: any): boolean {
    return value !== null && typeof value === 'object';
  }
}
