import { Component, Inject, NgZone } from '@angular/core';
import { MAT_BOTTOM_SHEET_DATA, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { invoke } from '@tauri-apps/api/core';
import { MatListModule } from '@angular/material/list';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { RepairData } from '../../shared/components/types';

@Component({
  selector: 'app-repair-sheet',
  standalone: true,
  imports: [MatListModule, MatProgressSpinner, CommonModule, MatButtonModule],
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

    } catch (error) {
      console.error("Repair failed:", error);
    }

    this.zone.run(() => (this.installing = false)); // ✅ for future attempts
  }
}
