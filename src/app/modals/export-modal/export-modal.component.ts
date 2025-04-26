import { CommonModule } from "@angular/common";
import { Component, HostListener } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatDialogModule, MatDialogRef } from "@angular/material/dialog";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatSelectModule } from "@angular/material/select";
import { RcloneService } from "../../services/rclone.service";
import { MatInputModule } from "@angular/material/input";
import { SettingsService } from "../../services/settings.service";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatCheckboxModule } from "@angular/material/checkbox";
import { animate, style, transition, trigger } from "@angular/animations";

@Component({
  selector: "app-export-modal",
  imports: [
    MatIconModule,
    CommonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatSelectModule,
    FormsModule,
    MatInputModule,
    MatTooltipModule,
    MatCheckboxModule,
  ],
  animations: [
    trigger("slideInOut", [
      transition(":enter", [
        style({ height: "0px", opacity: 0 }),
        animate("200ms ease-out", style({ height: "*", opacity: 1 })),
      ]),
      transition(":leave", [
        animate("200ms ease-in", style({ height: "0px", opacity: 0 })),
      ]),
    ]),
  ],
  templateUrl: "./export-modal.component.html",
  styleUrl: "./export-modal.component.scss",
})
export class ExportModalComponent {
  exportPath: string = "";
  sevenZipSupported = false;
  withPassword = false;
  password: any = null;

  constructor(
    private dialogRef: MatDialogRef<ExportModalComponent>,
    private rcloneService: RcloneService,
    private settingsService: SettingsService
  ) {}

  ngOnInit(): void {
    this.settingsService.check7zSupport().then((supported) => {
      this.sevenZipSupported = supported;
      if (!supported) {
        this.withPassword = false;
      }
    });
  }

  exportOptions: Array<{ value: string; label: string }> = [
    { value: "all", label: "📦 Export All (Settings + Remotes + rclone.conf)" },
    { value: "settings", label: "⚙️ Only App Settings" },
    { value: "remotes", label: "🗂 Only Remotes with rclone.conf" },
    { value: "remote-configs", label: "🔧 Only Remote Configurations" },
  ];

  selectedOption: string = this.exportOptions[0].value; // 👈 Default selection

  @HostListener("document:keydown.escape", ["$event"])
  close(event?: KeyboardEvent) {
    this.dialogRef.close(true);
  }

  async selectFolder() {
    try {
      const selected = await this.rcloneService.selectFolder(false);

      if (typeof selected === "string") {
        this.exportPath = selected;
      }
    } catch (err) {
      console.error("Folder selection cancelled or failed", err);
    }
  }

  async onExport() {
    await this.settingsService.backupSettings(
      this.exportPath,
      this.selectedOption,
      this.withPassword ? this.password : null
    );
  }
}
