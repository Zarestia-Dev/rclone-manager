import { inject, Injectable } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { NotificationService } from '@app/services';
import { ExportType } from '../../shared/types/ui';
import { FileSystemService } from '../file-operations/file-system.service';

// Matches the `BackupAnalysis` struct in `core/settings/backup/backup_types.rs`
export interface BackupAnalysis {
  isEncrypted: boolean;
  archiveType: string;
  formatVersion: string;
  isLegacy?: boolean;
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
  profiles?: string[];
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
  private translate = inject(TranslateService);

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
    userNote: string | null,
    includeProfiles?: string[]
  ): Promise<void> {
    try {
      await this.invokeCommand('backup_settings', {
        backupDir: selectedPath,
        exportType: selectedOption,
        password,
        remoteName,
        userNote,
        includeProfiles,
      });

      this.notificationService.showSuccess(this.translate.instant('backup.backupSuccess'));
    } catch (error) {
      this.notificationService.showError(String(error));
      throw error;
    }
  }

  /**
   * Restore settings from a .rcman backup
   * This command now handles both encrypted and unencrypted files.
   */
  async restoreSettings(
    path: string,
    password: string | null,
    restoreProfile?: string,
    restoreProfileAs?: string
  ): Promise<void> {
    try {
      await this.invokeCommand('restore_settings', {
        backupPath: path,
        password,
        restoreProfile,
        restoreProfileAs,
      });
      this.notificationService.showSuccess(this.translate.instant('backup.restoreSuccess'));
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
      this.notificationService.showError(this.translate.instant('backup.analyzeFailed'));
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

  /**
   * Get available backend profiles from backend
   */
  async getBackendProfiles(): Promise<string[]> {
    return this.invokeCommand<string[]>('get_backend_profiles', {});
  }
}
