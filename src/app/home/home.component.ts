import { Component, HostListener } from "@angular/core";
import { CommonModule } from "@angular/common";
import { MatDrawerMode, MatSidenavModule } from "@angular/material/sidenav";
import { MatCardModule } from "@angular/material/card";
import { MatDividerModule } from "@angular/material/divider";
import { MatChipsModule } from "@angular/material/chips";
import { MatDialog } from "@angular/material/dialog";
import { RemoteConfigModalComponent } from "../modals/remote-config-modal/remote-config-modal.component";

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

  constructor(private dialog: MatDialog) {
    this.loadRemotes();
  }

  // Load remotes from localStorage
  loadRemotes() {
    const storedRemotes = localStorage.getItem("remotes");
    if (storedRemotes) {
      this.remotes = JSON.parse(storedRemotes);
    }
    //  else {

    //   // If no stored data, initialize with example remotes
    //   this.remotes = [
    //     {
    //       name: "Google Drive",
    //       icon: "drive",
    //       mounted: "true",
    //       id: "drive",
    //       info: [
    //         {
    //           remote_disk: [
    //             { name: "Total Space", value: "15 GB" },
    //             { name: "Used Space", value: "5 GB" },
    //             { name: "Free Space", value: "10 GB" },
    //           ],
    //         },
    //         {
    //           remote_specs: [
    //             { name: "client_id", value: "1234567890" },
    //             { name: "client_secret", value: "1234567890" },
    //             { name: "token", value: "1234567890" },
    //             { name: "file_access", value: "full" },
    //             {
    //               name: "service_account_file",
    //               value: "service_account_file.json",
    //             },
    //           ],
    //         },
    //         {
    //           mount_specs: [
    //             { name: "Mount Path", value: "/mnt/gdrive" },
    //             { name: "Mount Type", value: "Service" },
    //             { name: "Mount Options", value: "rw,uid=1000,gid=1000" },
    //             {
    //               name: "spesific_mount_options",
    //               value:
    //                 "--vfs-cache-max-size 20G --vfs-cache-max-age 24h --vfs-read-chunk-size 32M --vfs-read-chunk-size-limit 2G",
    //             },
    //           ],
    //         },
    //       ],
    //     },
    //     {
    //       name: "Dropbox",
    //       icon: "dropbox",
    //       mounted: "false",
    //       id: "dropbox",
    //       info: [
    //         { remote_disk: [] },
    //         {
    //           remote_specs: [
    //             { name: "client_id", value: "1234567890" },
    //             { name: "client_secret", value: "1234567890" },
    //             { name: "token", value: "1234567890" },
    //             { name: "file_access", value: "full" },
    //             {
    //               name: "service_account_file",
    //               value: "service_account_file.json",
    //             },
    //           ],
    //         },
    //         {
    //           mount_specs: [
    //             { name: "Mount Path", value: "/mnt/dropbox" },
    //             { name: "Mount Type", value: "Native" },
    //             { name: "Mount Options", value: "rw,uid=1000,gid=1000" },
    //             {
    //               name: "spesific_mount_options",
    //               value:
    //                 "--vfs-cache-max-size 20G --vfs-cache-max-age 24h --vfs-read-chunk-size 32M --vfs-read-chunk-size-limit 2G",
    //             },
    //           ],
    //         },
    //       ],
    //     },
    //     {
    //       name: "OneDrive",
    //       icon: "onedrive",
    //       mounted: "error",
    //       id: "onedrive",
    //       info: [
    //         {
    //           remote_disk: [],
    //         },
    //         {
    //           remote_specs: [
    //             { name: "client_id", value: "1234567890" },
    //             { name: "client_secret", value: "1234567890" },
    //             { name: "token", value: "1234567890" },
    //             { name: "file_access", value: "full" },
    //             {
    //               name: "service_account_file",
    //               value: "service_account_file.json",
    //             },
    //           ],
    //         },
    //         {
    //           mount_specs: [
    //             { name: "Mount Path", value: "/mnt/onedrive" },
    //             { name: "Mount Type", value: "Service" },
    //             { name: "Mount Options", value: "rw,uid=1000,gid=1000" },
    //             {
    //               name: "spesific_mount_options",
    //               value:
    //                 "--vfs-cache-max-size 20G --vfs-cache-max-age 24h --vfs-read-chunk-size 32M --vfs-read-chunk-size-limit 2G",
    //             },
    //           ],
    //         },
    //       ],
    //     },
    //   ];
    //   this.saveRemotes(); // Save default remotes
    // }
  }

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

  ngOnInit(): void {
    const savedState = localStorage.getItem("sidebarState");
    this.isSidebarOpen = savedState === "true";
    this.updateSidebarMode();
  }

  ngOnDestroy(): void {
    localStorage.setItem("sidebarState", String(this.isSidebarOpen));
  }

  toggleSidebar(): void {
    this.isSidebarOpen = !this.isSidebarOpen;
    localStorage.setItem("sidebarState", String(this.isSidebarOpen));
  }

  openRemoteConfigModal(existingConfig: any, type: "remote" | "mount"): void {
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
      }
    });

    dialogRef.afterClosed().subscribe((result) => {
      if (result) {
        console.log("Remote Config Saved:", result);
        // Handle the saved data here
        // result will contain { remote: {...}, mount: {...} }
      }
    });
  }

  fixRemote() {
    // Fix remote
  }

  unmountRemote() {
    // Unmount remote
  }

  mountRemote() {
    // Mount remote
  }

  openFiles() {
    // Open files
  }

  addRemote() {
    // Add remote
  }
}
