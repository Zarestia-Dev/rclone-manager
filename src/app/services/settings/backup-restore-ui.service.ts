import { inject, Injectable } from '@angular/core';
import { BackupRestoreService } from './backup-restore.service';
import { NotificationService, ModalService } from '@app/services';
import { TranslateService } from '@ngx-translate/core';

@Injectable({
  providedIn: 'root',
})
export class BackupRestoreUiService {
  private readonly modalService = inject(ModalService);
  private readonly backupRestoreService = inject(BackupRestoreService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);

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
      const dialogRef = this.modalService.openRestorePreview({
        backupPath: path,
        analysis,
      });

      dialogRef.afterClosed().subscribe();
    } catch (error) {
      console.error('Failed to launch restore flow:', error);
      this.notificationService.showError(this.translate.instant('backup.launchRestoreFailed'));
    }
  }
}
