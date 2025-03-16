import { animate, style, transition, trigger } from "@angular/animations";
import { CommonModule } from "@angular/common";
import { Component, HostListener } from "@angular/core";
import { MatDialogRef } from "@angular/material/dialog";
import { MatDividerModule } from "@angular/material/divider";

@Component({
  selector: "app-about-modal",
  standalone: true,
  imports: [CommonModule, MatDividerModule],
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
  version = "1.0.0";

  constructor(private dialogRef: MatDialogRef<AboutModalComponent>) {}

  @HostListener("document:keydown.escape", ["$event"])
  onEscKeyPress(event: KeyboardEvent) {
    this.dialogRef.close();
  }

  openGitHub() {
    window.open("https://gitlab.com/Hakanbaban53/rclone-manager", "_blank");
  }

  closeModal() {
    this.dialogRef.close();
  }
  navigateTo(page: string) {
    this.currentPage = page;
  }
}
