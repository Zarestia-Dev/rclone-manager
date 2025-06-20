import { Component, HostListener, Inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from "@angular/material/dialog";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatSelectModule } from "@angular/material/select";
import { MatInputModule } from "@angular/material/input";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatCheckboxModule } from "@angular/material/checkbox";
import { animate, style, transition, trigger } from "@angular/animations";
import { MatButtonModule } from "@angular/material/button";
import { ExportModalData } from "../../shared/components/types";
import { BackupRestoreService } from "../../services/features/backup-restore.service";
import { RemoteManagementService } from "../../services/features/remote-management.service";
import { FileSystemService } from "../../services/features/file-system.service";

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
  // Form data
  exportPath = "";
  selectedOption = "all"; // Default to export all
  selectedRemoteName = "";
  
  // Security options
  withPassword = false;
  password = "";
  showPassword = false;
  
  // Component state
  sevenZipSupported = false;
  remotes: string[] = [];

  exportOptions: Array<{ value: string; label: string }> = [
    { value: "all", label: "📦 Export All (Settings + Remotes + rclone.conf)" },
    { value: "settings", label: "⚙️ Only App Settings" },
    { value: "remotes", label: "🗂 Only Remotes with rclone.conf" },
    { value: "remote-configs", label: "🔧 Only Remote Configurations" },
    { value: "specific-remote", label: "🔍 Specific Remote" },
  ];

  constructor(
    private dialogRef: MatDialogRef<ExportModalComponent>,
    private backupRestoreService: BackupRestoreService,
    private remoteManagementService: RemoteManagementService,
    private fileSystemService: FileSystemService,
    @Inject(MAT_DIALOG_DATA) public data: ExportModalData
  ) {}

  async ngOnInit(): Promise<void> {
    // Check 7-Zip support for password protection
    this.sevenZipSupported = await this.backupRestoreService.check7zSupport();
    if (!this.sevenZipSupported) {
      this.withPassword = false;
    }

    // Load available remotes
    this.remotes = await this.remoteManagementService.getRemotes();

    // Handle input data
    if (this.data?.remoteName) {
      this.selectedOption = 'specific-remote';
      this.selectedRemoteName = this.data.remoteName;
    }
    if (this.data?.defaultExportType) {
      this.selectedOption = this.data.defaultExportType;
    }
  }

  @HostListener("document:keydown.escape", ["$event"])
  close(event?: KeyboardEvent) {
    this.dialogRef.close(true);
  }

  async selectFolder() {
    try {
      const selected = await this.fileSystemService.selectFolder(false);

      if (typeof selected === "string") {
        this.exportPath = selected;
      }
    } catch (err) {
      console.error("Folder selection cancelled or failed", err);
    }
  }

  async onExport() {
    await this.backupRestoreService.backupSettings(
      this.exportPath,
      this.selectedOption,
      this.withPassword ? this.password || "" : "",
      this.selectedOption === 'specific-remote' ? this.selectedRemoteName : ""
    );
  }

  /**
   * Toggle password visibility
   */
  togglePasswordVisibility(): void {
    this.showPassword = !this.showPassword;
  }

  /**
   * Check if export can be performed
   */
  canExport(): boolean {
    const hasPath = !!this.exportPath.trim();
    const hasPassword = this.withPassword ? !!this.password.trim() : true;
    const hasRemote = this.selectedOption === 'specific-remote' ? !!this.selectedRemoteName.trim() : true;
    
    return hasPath && hasPassword && hasRemote;
  }

  /**
   * Get tooltip message for export button
   */
  getExportTooltip(): string {
    if (!this.exportPath) {
      return "Please select a folder to save the export";
    }
    if (this.withPassword && !this.password) {
      return "Please enter a password for encryption";
    }
    if (this.selectedOption === 'specific-remote' && !this.selectedRemoteName) {
      return "Please select a remote to export";
    }
    return "Export your settings to the selected folder";
  }

  /**
   * Get selected option label for display
   */
  getSelectedOptionLabel(): string {
    const option = this.exportOptions.find(opt => opt.value === this.selectedOption);
    return option ? option.label.replace(/^[^\s]+\s/, '') : 'Settings'; // Remove emoji prefix
  }
}
