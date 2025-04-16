import { Component, Inject, NgZone } from '@angular/core';
import { MAT_BOTTOM_SHEET_DATA, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { invoke } from '@tauri-apps/api/core';
import { MatListModule } from '@angular/material/list';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { CommonModule } from '@angular/common';

interface RepairData {
  type: 'rclone_path' | 'mount_plugin' | 'config_corrupt' | 'backend_unreachable';
  title?: string;
  message?: string;
}

@Component({
  selector: 'app-repair-sheet',
  standalone: true,
  imports: [MatListModule, MatProgressSpinner, CommonModule],
  templateUrl: './repair-sheet.component.html',
  styleUrl: './repair-sheet.component.scss'
})
export class RepairSheetComponent {
  installing = false;

  constructor(
    @Inject(MAT_BOTTOM_SHEET_DATA) public data: RepairData,
    private sheetRef: MatBottomSheetRef<RepairSheetComponent>,
    private zone: NgZone
  ) {}

  async repair() {
    this.zone.run(() => (this.installing = true)); // ✅ triggers Angular update

    try {
      switch (this.data.type) {
        case 'rclone_path':
          await invoke<string>("provision_rclone", { path: null });
          break;
        case 'mount_plugin':
          await invoke<string>("install_mount_plugin", {});
          break;
        case 'config_corrupt':
          await invoke("restore_backup_config", {});
          break;
        case 'backend_unreachable':
          await invoke("restart_api_engine", {});
          break;
      }

      this.sheetRef.dismiss();
    } catch (error) {
      console.error("Repair failed:", error);
    }

    this.zone.run(() => (this.installing = false)); // ✅ for future attempts
  }
}
