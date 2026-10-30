import { inject, Injectable } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { ExportType, BackupAnalysis } from '@app/types';
import { FileSystemService } from '../operations/file-system.service';

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
  private fileSystemService = inject(FileSystemService);

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
    await this.invokeWithNotification(
      'backup_settings',
      {
        backupDir: selectedPath,
        exportType: selectedOption,
        password,
        remoteName,
        userNote,
        includeProfiles,
      },
      {
        successKey: 'backup.backupSuccess',
        errorKey: 'backup.backupFailed',
      }
    );
  }

  /**
   * Restore settings from a .rcman backup
   * This command now handles both encrypted and unencrypted files.
   */
  async restoreSettings(
    path: string,
    password: string | null,
    restoreProfile?: string
  ): Promise<void> {
    await this.invokeWithNotification(
      'restore_settings',
      {
        backupPath: path,
        password,
        restoreProfile,
      },
      {
        successKey: 'backup.restoreSuccess',
        errorKey: 'backup.restoreFailed',
      }
    );
  }

  /**
   * Selects a backup file and analyzes it
   * Returns null if no file selected or analysis failed
   */
  async selectAndAnalyzeBackup(): Promise<{ path: string; analysis: BackupAnalysis } | null> {
    try {
      const path = await this.fileSystemService.selectFile();
      if (!path) return null;

      const analysis = await this.analyzeBackupFile(path);
      return analysis ? { path, analysis } : null;
    } catch (error) {
      if (error instanceof Error && error.message === 'File selection cancelled') {
        return null;
      }
      console.error('Failed to select a backup:', error);
      this.notificationService.showError(this.translate.instant('backup.analyzeFailed'));
      return null;
    }
  }

  /**
   * Analyze backup file contents.
   * Reports a failure to the user and returns null, so callers do not report it again.
   */
  async analyzeBackupFile(path: string): Promise<BackupAnalysis | null> {
    try {
      return await this.invokeCommand<BackupAnalysis>('analyze_backup_file', { path });
    } catch (error) {
      this.notificationService.confirmModal(
        this.translate.instant('common.error'),
        this.backendTranslation.translateBackendMessage(error),
        '',
        'common.close',
        {
          icon: 'circle-exclamation',
          color: 'warn',
        }
      );
      return null;
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
