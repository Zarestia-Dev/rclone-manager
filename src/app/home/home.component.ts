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

  constructor(
    private dialog: MatDialog,
    private stateService: StateService,
    private rcloneService: RcloneService
  ) {}

  // Save remotes to localStorage
  saveRemotes() {
    localStorage.setItem("remotes", JSON.stringify(this.remotes));
  }

  // Select a remote for editing
  selectRemote(remote: any) {
    this.selectedRemote = { ...remote }; // Clone object to prevent direct modification
  }

  // Save the edited remote back to the array
  saveEditedRemote() {
    if (this.selectedRemote) {
      const index = this.remotes.findIndex(
        (remote) => remote.id === this.selectedRemote.id
      );
      if (index !== -1) {
        this.remotes[index] = { ...this.selectedRemote }; // Update remote
        this.saveRemotes(); // Save changes to localStorage
      }
    }
    this.selectedRemote = null;
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
    const used = parseFloat(remote.info[0]?.remote_disk?.[1]?.value) || 0;
    const total = parseFloat(remote.info[0]?.remote_disk?.[0]?.value) || 1;
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

  openRemoteConfigModal(existingConfig?: any, type?: "remote" | "mount"): void {
    const dialogRef = this.dialog.open(RemoteConfigModalComponent, {
      width: "70vw",
      maxWidth: "800px",
      height: "80vh",
      maxHeight: "600px",
      disableClose: true,
      data: {
        editMode: true, // Set editMode only if editing
        editTarget: type,
        existingConfig: existingConfig
        ? { ...existingConfig, mountSpecs: existingConfig.mountSpecs || {} } // Ensure mountSpecs exists
        : null,      },
    });
  
    dialogRef.afterClosed().subscribe((result) => {
      if (result) {
        console.log("Remote Config Saved:", result);
  
        // Find the existing remote by name (or other unique identifier)
        const index = this.remotes.findIndex((remote) => 
          remote.remoteSpecs.name === result.remoteSpecs.name
        );
  
        if (index !== -1) {
          this.remotes[index] = { ...result }; // Update existing remote
        } else {
          this.remotes.push(result); // Add as a new remote
        }
  
        this.saveRemotes();
      }
    });
  }
  
  

  deleteRemote(remote: any) {
    console.log("Deleting remote:", remote);

    const index = this.remotes.findIndex((r) => r.id === remote.id);
    if (index !== -1) {
      this.remotes.splice(index, 1);
      this.saveRemotes();
    }
  }

  mountedRemotes: string[] = [];

  async ngOnInit(): Promise<void> {
    await this.refreshMounts();
    const savedState = localStorage.getItem("sidebarState");
    this.isSidebarOpen = savedState === "true";
    this.updateSidebarMode();
    this.stateService.selectedRemote$.subscribe((remote) => {
      this.selectedRemote = remote;
    });
    await this.loadRemotes();
    await this.refreshMounts();
    await this.loadRemotes();
    await this.loadMountTypes();
  }

/** Fetch mount types dynamically */
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

  /** Fetch all remotes and their configs in one request */
  async loadRemotes(): Promise<void> {
    const remoteConfigs = await this.rcloneService.getAllRemoteConfigs(); // ✅ Fetch all at once
    const remoteNames = Object.keys(remoteConfigs); // Extract remote names

    this.remotes = remoteNames.map((name) => ({
      remoteSpecs: {
        name: name,
        ...remoteConfigs[name], // Merge config details
      },
      mounted: this.mountedRemotes.includes(`/mnt/${name}`) ? "true" : "false",
    }));

    console.log("Loaded Remotes:", this.remotes);
  }

  /** Get list of mounted remotes */
  async refreshMounts(): Promise<void> {
    this.mountedRemotes = await this.rcloneService.listMounts();
  }


  /** Add a mount */
  async addMount(remote: any): Promise<void> {
    const mountPoint = `/mnt/${remote.remoteSpecs.name}`;
    await this.rcloneService.addMount(remote.remoteSpecs.name, mountPoint);
    await this.loadMountTypes();
  }

  /** Remove a mount */
  async removeMount(remote: any): Promise<void> {
    await this.rcloneService.removeMount(remote.remoteSpecs.name);
    await this.loadMountTypes();
  }

  async mountRemote(): Promise<void> {
    const remoteName = "gdrive";
    const mountPoint = "/mnt/gdrive";

    await this.rcloneService.mountRemote(remoteName, mountPoint);
    await this.refreshMounts();
  }

  async unmountRemote(mountPoint: string): Promise<void> {
    await this.rcloneService.unmountRemote(mountPoint);
    await this.refreshMounts();
  }
}
