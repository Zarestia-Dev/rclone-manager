import { animate, style, transition, trigger } from "@angular/animations";
import { CommonModule } from "@angular/common";
import { Component, HostListener } from "@angular/core";
import { MatDialogRef } from "@angular/material/dialog";
import { MatDividerModule } from "@angular/material/divider";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MatIconModule } from "@angular/material/icon";
import { InfoService } from "../../services/info.service";
import { MatButtonModule } from "@angular/material/button";
import { RcloneService } from "../../services/rclone.service";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { RcloneInfo } from "../../shared/components/types";
import packageJson from '../../../../package.json';
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
    trigger("slideOverlay", [
      transition(":enter", [
        style({ transform: "translateX(100%)" }),
        animate(
          "200ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
          style({ transform: "translateX(0%)" })
        ),
      ]),
      transition(":leave", [
        animate(
          "200ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
          style({ transform: "translateX(100%)" })
        ),
      ]),
    ]),
  ],
})
export class AboutModalComponent {
  currentPage = "main";
  rCloneManagerVersion = rCloneManager;

  scrolled = false;

  constructor(
    private dialogRef: MatDialogRef<AboutModalComponent>,
    private infoService: InfoService,
    private rcloneService: RcloneService
  ) {}

  rcloneInfo: RcloneInfo | null = null;
  loadingRclone = false;
  rcloneError: string | null = null;

  async ngOnInit() {
    await this.loadRcloneInfo();
  }

  async loadRcloneInfo() {
    this.loadingRclone = true;
    this.rcloneError = null;
    try {
      this.rcloneInfo = await this.rcloneService.getRcloneInfo();
    } catch (error) {
      console.error("Error fetching rclone info:", error);
      this.rcloneError = "Failed to load rclone info.";
    } finally {
      this.loadingRclone = false;
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
        this.infoService.openSnackBar("Copied to clipboard", "Close");
      },
      (err) => {
        console.error("Failed to copy to clipboard:", err);
        this.infoService.openSnackBar("Failed to copy to clipboard", "Close");
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
