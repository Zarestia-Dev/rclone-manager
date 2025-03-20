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
    imports: [
        MatSidenavModule,
        MatDividerModule,
        MatChipsModule,
        CommonModule,
        MatCardModule,
    ],
    templateUrl: "./home.component.html",
    styleUrl: "./home.component.scss"
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
    await this.loadMounts();
    await this.loadRemotes();
    await this.loadMountTypes();
    // console.log("Global Flags:", this.rcloneService.getGlobalFlags());
    // console.log("Copy Flags:", this.rcloneService.getCopyFlags());
    // console.log("Sync Flags:", this.rcloneService.getSyncFlags());
    // console.log("Filter Flags:", this.rcloneService.getFilterFlags());
    // console.log("VFS Flags:", this.rcloneService.getVfsFlags());
    // console.log("Mount Flags:", this.rcloneService.getMountFlags());
    
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

  toggleSidebar(): void {
    this.isSidebarOpen = !this.isSidebarOpen;
    localStorage.setItem("sidebarState", String(this.isSidebarOpen));
  }

  async openFiles(remoteName: any): Promise<void> {
    const mountPoint = this.loadSavedMountConfig(remoteName)?.mount_path;
    await this.rcloneService.openInFiles(mountPoint);
  }

  async openRemoteConfigModal(
    existingConfig?: any,
    type?: "remote" | "mount"
  ): Promise<void> {
    let mountConfig = {};

    if (type === "mount" && this.selectedRemote) {
      try {
        mountConfig = await this.loadSavedMountConfig(
          this.selectedRemote.remoteSpecs.name
        );
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

  // Select a remote for editing
    selectRemote(remote: any) {
      const updatedRemote = this.remotes.find(r => r.remoteSpecs.name === remote.remoteSpecs.name);
      this.selectedRemote = updatedRemote ? { ...updatedRemote } : null;
      
    }


  // Get remotes based on their mount status
  getMountedRemotes() {
    return this.remotes.filter((remote) => remote.mounted);
  }

  getUnmountedRemotes() {
    return this.remotes.filter((remote) => !remote.mounted);
  }

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

  // Calculate disk usage percentage
  getUsagePercentage(remote: any): number {
    const used = parseFloat(remote.diskUsage?.used_space || "0");
    const total = parseFloat(remote.diskUsage?.total_space || "1");
    return (used / total) * 100;
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
  async loadMounts(): Promise<void> {
    const mountConfigs = await this.rcloneService.getAllMountConfigs();
    this.savedMountConfigs = Object.entries(mountConfigs).map(
      ([remote, config]) => ({
        remote,
        ...config,
      })
    );
    console.log("Saved Mount Configs:", this.savedMountConfigs);
  }

  // Load available mount types dynamically
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

  // Refresh the list of mounted remotes
  async refreshMounts(): Promise<void> {
    this.mountedRemotes = await this.rcloneService.getMountedRemotes();
  }

  // Check if a remote is currently mounted
  isRemoteMounted(remoteName: string): boolean {
    return this.mountedRemotes.some((mount) => mount.fs === `${remoteName}:`);
  }

  // Get saved mount configuration for a remote
  loadSavedMountConfig(remoteName: string): any {
    return this.savedMountConfigs.find(
      (config) => config.remote === remoteName
    );
  }

  // Mount a remote
  async mountRemote(remoteName: string): Promise<void> {
    const mountPoint = this.loadSavedMountConfig(remoteName)?.mount_path;
    if (!mountPoint) {
      console.warn(`No mount point found for ${remoteName}`);
      return;
    }

    try {
      await this.rcloneService.mountRemote(remoteName, mountPoint);
      await this.refreshMounts();
      await this.loadRemotes();
      console.log(`Mounted ${remoteName} at ${mountPoint}`);
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
    const mountPoint = this.loadSavedMountConfig(
      remote.remoteSpecs.name
    )?.mount_path;
    if (!mountPoint) {
      console.warn(`No mount point found for ${remote.remoteSpecs.name}`);
      return;
    }

    await this.rcloneService.addMount(remote.remoteSpecs.name, mountPoint);
    await this.loadMountTypes();
  }

  // Remove a mount
  async removeMount(remote: any): Promise<void> {
    await this.rcloneService.removeMount(remote.remoteSpecs.name);
    await this.loadMountTypes();
  }

  isObject(value: any): boolean {
    return value !== null && typeof value === "object";
  }

  ngOnDestroy(): void {
    localStorage.setItem("sidebarState", String(this.isSidebarOpen));
  }
}
