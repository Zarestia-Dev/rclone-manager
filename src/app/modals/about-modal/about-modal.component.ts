import { animate, style, transition, trigger } from "@angular/animations";
import { CommonModule } from "@angular/common";
import { Component, HostListener } from "@angular/core";
import { MatDialogRef } from "@angular/material/dialog";
import { MatDividerModule } from "@angular/material/divider";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MatIconModule } from "@angular/material/icon";
import { InfoService } from "../../services/info.service";
import { MatButtonModule } from "@angular/material/button";

@Component({
  selector: "app-about-modal",
  imports: [CommonModule, MatDividerModule, MatIconModule, MatButtonModule],
  templateUrl: "./about-modal.component.html",
  styleUrl: "./about-modal.component.scss",
  animations: [
    trigger("slideOverlay", [
      transition(":enter", [
        style({ transform: "translateX(100%)" }),
        animate("300ms ease-out", style({ transform: "translateX(0%)" })),
      ]),
      transition(":leave", [
        animate("300ms ease-in", style({ transform: "translateX(100%)" })),
      ]),
    ]),
  ],
})
export class AboutModalComponent {
  currentPage = "main";
  version = "0.1.0";

  constructor(
    private dialogRef: MatDialogRef<AboutModalComponent>,
    private infoService: InfoService
  ) {}

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

  @HostListener('document:keydown.escape', ['$event'])
  close() {
    this.dialogRef.close();
  }

  navigateTo(page: string) {
    this.currentPage = page;
  }
}
