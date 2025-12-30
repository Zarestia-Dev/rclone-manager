import { inject, Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { BackupRestoreService } from './backup-restore.service';
import { NotificationService } from '../../shared/services/notification.service';
import { RestorePreviewModalComponent } from '../../features/modals/settings/restore-preview-modal/restore-preview-modal.component';
import { STANDARD_MODAL_SIZE } from '@app/types';

@Injectable({
  providedIn: 'root',
})
export class BackupRestoreUiService {
  private dialog = inject(MatDialog);
  private backupRestoreService = inject(BackupRestoreService);
  private notificationService = inject(NotificationService);

  /**
   * Launches the full settings restore flow:
   * 1. Opens file picker
   * 2. Analyzes selected backup
   * 3. Opens preview modal if analysis successful
   */
  async launchRestoreFlow(): Promise<void> {
    try {
      const result = await this.backupRestoreService.selectAndAnalyzeBackup();
      if (!result) return;

      const { path, analysis } = result;

      const dialogRef = this.dialog.open(RestorePreviewModalComponent, {
        ...STANDARD_MODAL_SIZE,
        disableClose: true,
        data: {
          backupPath: path,
          analysis,
        },
      });

      dialogRef.afterClosed().subscribe();
    } catch (error) {
      console.error('Failed to launch restore flow:', error);
      this.notificationService.showError('Failed to launch restore flow');
    }
  }
}
