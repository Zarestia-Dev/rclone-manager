import { CommonModule } from "@angular/common";
import { Component, HostListener } from "@angular/core";
import { MatDialogRef } from "@angular/material/dialog";
import { MatDividerModule } from "@angular/material/divider";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MatIconModule } from "@angular/material/icon";
import { MatButtonModule } from "@angular/material/button";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";

import { listen, UnlistenFn } from "@tauri-apps/api/event";
import packageJson from "../../../../../../package.json";
import { RcloneInfo } from "../../../../shared/components/types";
import { AnimationsService } from "../../../../services/core/animations.service";
import { SystemInfoService } from "../../../../services/system/system-info.service";
import { NotificationService } from "../../../../services/ui/notification.service";
const rCloneManager = packageJson.version;

@Component({
  selector: "app-about-modal",
  imports: [
    CommonModule,
    MatDividerModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: "./about-modal.component.html",
  styleUrl: "./about-modal.component.scss",
  animations: [
    AnimationsService.slideOverlay(),
  ],
})
export class AboutModalComponent {
  currentPage = "main";
  rCloneManagerVersion = rCloneManager;

  scrolled = false;

  constructor(
    private dialogRef: MatDialogRef<AboutModalComponent>,
    private systemInfoService: SystemInfoService,
    private notificationService: NotificationService
  ) {}

  rcloneInfo: RcloneInfo | null = null;
  loadingRclone = false;
  rcloneError: string | null = null;
  private unlistenRcloneApiReady: UnlistenFn | null = null;

  async ngOnInit() {
    await this.loadRcloneInfo();
    await this.loadRclonePID();

    // Listen for rclone_api_ready event and store the unlisten function
    this.unlistenRcloneApiReady = await listen("rclone_api_ready", async () => {
      await this.loadRcloneInfo();
      await this.loadRclonePID();
    });
  }

  ngOnDestroy() {
    if (this.unlistenRcloneApiReady) {
      this.unlistenRcloneApiReady();
      this.unlistenRcloneApiReady = null;
    }
  }

  async loadRcloneInfo() {
    this.loadingRclone = true;
    this.rcloneError = null;
    try {
      this.rcloneInfo = await this.systemInfoService.getRcloneInfo();
    } catch (error) {
      console.error("Error fetching rclone info:", error);
      this.rcloneError = "Failed to load rclone info.";
    } finally {
      this.loadingRclone = false;
    }
  }

  async loadRclonePID() {
    this.loadingRclone = true;
    this.rcloneError = null;
    try {
      const pid = await this.systemInfoService.getRclonePID();
      if (this.rcloneInfo) {
        this.rcloneInfo = {
          ...this.rcloneInfo,
          pid: pid,
        };
      }
    } catch (error) {
      console.error("Error fetching rclone PID:", error);
      this.rcloneError = "Failed to load rclone PID.";
      this.notificationService.openSnackBar(this.rcloneError, "Close");
    } finally {
      this.loadingRclone = false;
    }
  }

  killProcess() {
    if (this.rcloneInfo?.pid) {
      this.systemInfoService.killProcess(this.rcloneInfo.pid).then(
        () => {
          this.notificationService.openSnackBar(
            "Rclone process killed successfully",
            "Close"
          );
          this.rcloneInfo = null; // Clear info after killing
        },
        (error) => {
          console.error("Failed to kill rclone process:", error);
          this.notificationService.openSnackBar(
            "Failed to kill rclone process",
            "Close"
          );
        }
      );
    } else {
      this.notificationService.openSnackBar("No rclone process to kill", "Close");
    }
  }

  onScroll(content: HTMLElement) {
    this.scrolled = content.scrollTop > 10;
  }

  @HostListener("document:keydown.escape", ["$event"])
  onEscKeyPress(event: KeyboardEvent) {
    this.dialogRef.close();
  }

  openLink(link: string) {
    openUrl(link);
  }

  copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(
      () => {
        this.notificationService.openSnackBar("Copied to clipboard", "Close");
      },
      (err) => {
        console.error("Failed to copy to clipboard:", err);
        this.notificationService.openSnackBar("Failed to copy to clipboard", "Close");
      }
    );
  }

  @HostListener("document:keydown.escape", ["$event"])
  close() {
    this.dialogRef.close();
  }

  navigateTo(page: string) {
    this.currentPage = page;
  }
}
