import { Component, Inject, NgZone } from '@angular/core';
import { MAT_BOTTOM_SHEET_DATA, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { invoke } from '@tauri-apps/api/core';
import { MatListModule } from '@angular/material/list';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { RepairData } from '../../shared/components/types';

@Component({
  selector: 'app-repair-sheet',
  standalone: true,
  imports: [MatListModule, MatProgressSpinner, MatButtonModule, MatIconModule],
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

  getRepairIcon(): string {
    switch (this.data.type) {
      case 'rclone_path':
        return 'download';
      case 'mount_plugin':
        return 'puzzle-piece';
      case 'config_corrupt':
        return 'arrow-rotate-left';
      case 'backend_unreachable':
        return 'refresh';
      default:
        return 'wrench';
    }
  }

  getRepairDetails(): Array<{icon: string, label: string, value: string}> | null {
    switch (this.data.type) {
      case 'rclone_path':
        return [
          { icon: 'circle-info', label: 'Issue', value: 'Rclone binary not found' },
          { icon: 'download', label: 'Action', value: 'Download and install rclone' }
        ];
      case 'mount_plugin':
        return [
          { icon: 'circle-info', label: 'Issue', value: 'Mount plugin missing' },
          { icon: 'puzzle-piece', label: 'Action', value: 'Install mount support plugin' }
        ];
      case 'config_corrupt':
        return [
          { icon: 'circle-info', label: 'Issue', value: 'Configuration file corrupted' },
          { icon: 'arrow-rotate-left', label: 'Action', value: 'Restore from backup' }
        ];
      case 'backend_unreachable':
        return [
          { icon: 'circle-info', label: 'Issue', value: 'API backend not responding' },
          { icon: 'refresh', label: 'Action', value: 'Restart API engine' }
        ];
      default:
        return null;
    }
  }

  dismiss(): void {
    this.sheetRef.dismiss();
  }

  getRepairProgressText(): string {
    switch (this.data.type) {
      case 'rclone_path':
        return 'Installing rclone...';
      case 'mount_plugin':
        return 'Installing plugin...';
      case 'config_corrupt':
        return 'Restoring backup...';
      case 'backend_unreachable':
        return 'Restarting engine...';
      default:
        return 'Repairing...';
    }
  }

  getRepairButtonIcon(): string {
    switch (this.data.type) {
      case 'rclone_path':
        return 'download';
      case 'mount_plugin':
        return 'puzzle-piece';
      case 'config_corrupt':
        return 'arrow-rotate-left';
      case 'backend_unreachable':
        return 'refresh';
      default:
        return 'wrench';
    }
  }

  getRepairButtonText(): string {
    switch (this.data.type) {
      case 'rclone_path':
        return 'Install Rclone';
      case 'mount_plugin':
        return 'Install Plugin';
      case 'config_corrupt':
        return 'Restore Backup';
      case 'backend_unreachable':
        return 'Restart Engine';
      default:
        return 'Repair';
    }
  }
}
