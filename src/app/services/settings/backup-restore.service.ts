import { inject, Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { NotificationService } from '@app/services';
import { ExportType } from '../../shared/types/ui';
import { FileSystemService } from '../file-operations/file-system.service';

// Matches the `BackupAnalysis` struct in `core/settings/backup/backup_types.rs`
export interface BackupAnalysis {
  isEncrypted: boolean;
  archiveType: string;
  formatVersion: string;
  createdAt?: string;
  backupType?: string;
  userNote?: string;
  contents?: BackupContentsInfo;
}

// Matches the `BackupContentsInfo` struct
export interface BackupContentsInfo {
  settings: boolean;
  backendConfig: boolean;
  rcloneConfig: boolean;
  remoteCount?: number;
  remoteNames?: string[];
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
  private fileSystemService = inject(FileSystemService);
  constructor() {
    super();
  }

  /**
   * Backup settings to a specified location
   */
  async backupSettings(
    selectedPath: string,
    selectedOption: ExportType,
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
   * Selects a backup file and analyzes it
   * Returns null if no file selected or analysis failed
   */
  async selectAndAnalyzeBackup(): Promise<{ path: string; analysis: BackupAnalysis } | null> {
    const path = await this.fileSystemService.selectFile();
    if (!path) return null;

    try {
      const analysis = await this.analyzeBackupFile(path);
      if (!analysis) return null;
      return { path, analysis };
    } catch (error) {
      console.error('Failed to analyze backup:', error);
      this.notificationService.showError('Failed to analyze backup file');
      return null;
    }
  }

  /**
   * Analyze backup file contents
   */
  async analyzeBackupFile(path: string): Promise<BackupAnalysis | null> {
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
