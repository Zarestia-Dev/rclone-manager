import { inject, Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { NotificationService } from '../../shared/services/notification.service';

/**
 * Service for backup and restore operations
 * Handles settings backup/restore with encryption support
 */
@Injectable({
  providedIn: 'root',
})
export class BackupRestoreService extends TauriBaseService {
  private notificationService = inject(NotificationService);
  constructor() {
    super();
  }

  /**
   * Backup settings to a specified location
   */
  async backupSettings(
    selectedPath: string,
    selectedOption: string,
    password: string | null,
    remoteName: string
  ): Promise<void> {
    try {
      const result = await this.invokeCommand('backup_settings', {
        backupDir: selectedPath,
        exportType: selectedOption,
        password,
        remoteName,
      });

      this.notificationService.showSuccess(String(result));
    } catch (error) {
      this.notificationService.showError(String(error));
      throw error;
    }
  }

  /**
   * Restore settings from backup
   */
  async restoreSettings(path: string): Promise<void> {
    try {
      const result = await this.invokeCommand('restore_settings', { backupPath: path });
      this.notificationService.showSuccess(String(result));
    } catch (error) {
      this.notificationService.showError(String(error));
      throw error;
    }
  }

  /**
   * Restore encrypted settings
   */
  async restoreEncryptedSettings(path: string, password: string): Promise<void> {
    try {
      const result = await this.invokeCommand('restore_encrypted_settings', {
        path,
        password,
      });

      this.notificationService.showSuccess(String(result));
    } catch (error) {
      this.notificationService.showError(String(error));
      throw error;
    }
  }

  /**
   * Analyze backup file contents
   */
  async analyzeBackupFile(path: string): Promise<any> {
    try {
      return await this.invokeCommand('analyze_backup_file', { path });
    } catch (error) {
      this.notificationService.alertModal('Error', String(error));
      throw error;
    }
  }

  /**
   * Check if 7z compression is available
   */
  async check7zSupport(): Promise<boolean> {
    return this.invokeCommand<boolean>('is_7z_available');
  }
}
