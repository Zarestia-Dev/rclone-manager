
import { Component, HostListener, Inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from "@angular/material/dialog";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatSelectModule } from "@angular/material/select";
import { RcloneService } from "../../services/rclone.service";
import { MatInputModule } from "@angular/material/input";
import { SettingsService } from "../../services/settings.service";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatCheckboxModule } from "@angular/material/checkbox";
import { animate, style, transition, trigger } from "@angular/animations";
import { MatButtonModule } from "@angular/material/button";
import { ExportModalData } from "../../shared/components/types";

@Component({
  selector: "app-export-modal",
  imports: [
    MatIconModule,
    MatDialogModule,
    MatFormFieldModule,
    MatSelectModule,
    FormsModule,
    MatInputModule,
    MatTooltipModule,
    MatCheckboxModule,
    MatButtonModule
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
  selectedRemoteName: any = "";
  remotes: any[] = [];

  exportOptions: Array<{ value: string; label: string }> = [
    { value: "all", label: "📦 Export All (Settings + Remotes + rclone.conf)" },
    { value: "settings", label: "⚙️ Only App Settings" },
    { value: "remotes", label: "🗂 Only Remotes with rclone.conf" },
    { value: "remote-configs", label: "🔧 Only Remote Configurations" },
    { value: "specific-remote", label: "🔍 Specific Remote" },
  ];

  selectedOption: string = this.exportOptions[0].value; // 👈 Default selection

  constructor(
    private dialogRef: MatDialogRef<ExportModalComponent>,
    private rcloneService: RcloneService,
    private settingsService: SettingsService,
    @Inject(MAT_DIALOG_DATA) public data: ExportModalData
  ) {}

  async ngOnInit(): Promise<void> {
    this.settingsService.check7zSupport().then((supported) => {
      this.sevenZipSupported = supported;
      if (!supported) {
        this.withPassword = false;
      }
    });

    // Load available remotes
    this.remotes = await this.rcloneService.getRemotes();

    // Handle input data
    if (this.data) {
      if (this.data.remoteName) {
        this.selectedOption = 'specific-remote';
        this.selectedRemoteName = this.data.remoteName;
      }
      if (this.data.defaultExportType) {
        this.selectedOption = this.data.defaultExportType;
      }
    }
  }

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
      this.withPassword ? this.password : null,
      this.selectedOption == 'specific-remote' ? this.selectedRemoteName : null
    );
  }
}
