import { animate, style, transition, trigger } from "@angular/animations";
import { CommonModule } from "@angular/common";
import { Component, HostListener, inject } from "@angular/core";
import { MatDialogRef } from "@angular/material/dialog";
import { MatDividerModule } from "@angular/material/divider";
import { openUrl } from '@tauri-apps/plugin-opener'
import { MatSnackBar } from "@angular/material/snack-bar";


@Component({
    selector: "app-about-modal",
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
    ]
})
export class AboutModalComponent {
  private _snackBar = inject(MatSnackBar);
  currentPage = "main";
  version = "0.1.0";

  constructor(private dialogRef: MatDialogRef<AboutModalComponent>) {}

  @HostListener("document:keydown.escape", ["$event"])
  onEscKeyPress(event: KeyboardEvent) {
    this.dialogRef.close();
  }

  openLink(link: string) {
    openUrl(link);
  }

  openSnackBar(message: string, action: string) {
    this._snackBar.open(message, action, {
      duration: 2000,
    });
  }

  copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(
      () => {
        this.openSnackBar("Copied to clipboard", "Close");
      },
      (err) => {
        console.error("Failed to copy to clipboard:", err);
        this.openSnackBar("Failed to copy to clipboard", "Close");
      }
    );
  }

  closeModal() {
    this.dialogRef.close();
  }
  navigateTo(page: string) {
    this.currentPage = page;
  }
}
