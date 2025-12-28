import { inject, Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { NotificationService } from '../../shared/services/notification.service';

// Matches the `BackupAnalysis` struct in `core/settings/backup/backup_types.rs`
export interface BackupAnalysis {
  isEncrypted: boolean;
  archiveType: string;
  formatVersion: string;
  createdAt?: string;
  backupType?: string;
  metadata?: {
    userNote?: string;
    tags?: string[];
    computer?: string;
    os?: string;
  };
  contents?: {
    settings: boolean;
    backendConfig: boolean;
    rcloneConfig: boolean;
    remoteConfigs?: {
      count: number;
      names?: string[];
    };
  };
}

// Matches ExportCategoryResponse from backend
export interface ExportCategory {
  id: string;
  name: string;
  categoryType: 'settings' | 'sub_settings' | 'external';
  optional: boolean;
  description?: string;
}

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
    remoteName: string,
    userNote: string | null
  ): Promise<void> {
    try {
      const result = await this.invokeCommand('backup_settings', {
        backupDir: selectedPath,
        exportType: selectedOption,
        password,
        remoteName,
        userNote,
      });

      this.notificationService.showSuccess(String(result));
    } catch (error) {
      this.notificationService.showError(String(error));
      throw error;
    }
  }

  /**
   * Restore settings from a .rcman backup
   * This command now handles both encrypted and unencrypted files.
   */
  async restoreSettings(path: string, password: string | null): Promise<void> {
    try {
      const result = await this.invokeCommand('restore_settings', {
        backupPath: path,
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
  async analyzeBackupFile(path: string): Promise<BackupAnalysis> {
    try {
      return await this.invokeCommand<BackupAnalysis>('analyze_backup_file', { path });
    } catch (error) {
      this.notificationService.alertModal('Error', String(error));
      throw error;
    }
  }

  /**
   * Get available export categories from backend
   */
  async getExportCategories(): Promise<ExportCategory[]> {
    return this.invokeCommand<ExportCategory[]>('get_export_categories', {});
  }
}
