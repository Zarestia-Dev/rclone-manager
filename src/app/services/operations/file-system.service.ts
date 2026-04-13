import { inject, Injectable } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { NautilusService } from '../ui/nautilus.service';
import { FilePickerConfig, FilePickerResult } from '@app/types';
import { filter, firstValueFrom } from 'rxjs';

/**
 * Service for file system operations
 * Handles file/folder selection and system integration
 */
@Injectable({
  providedIn: 'root',
})
export class FileSystemService extends TauriBaseService {
  private nautilusService = inject(NautilusService);

  /**
   * Select a folder with optional empty requirement
   * @param requireEmpty - If true, require the folder to be empty (for mount destinations)
   * @param initialPath - Optional initial path to open the picker to
   */
  async selectFolder(requireEmpty?: boolean, initialPath?: string): Promise<string> {
    // In headless mode, use Nautilus file browser
    if (this.apiClient.isHeadless()) {
      const config: FilePickerConfig = {
        mode: 'local',
        selection: 'folders',
        multi: false,
        initialLocation: initialPath,
      };
      const result = await this.selectPathWithNautilus(config);
      if (result.cancelled || (result.items.length === 0 && result.paths.length === 0)) {
        throw new Error('Folder selection cancelled');
      }
      // Prefer structured item path, fallback to flat string
      return result.items.length > 0 ? result.items[0].entry.Path : result.paths[0];
    }

    // In Tauri mode, use native dialog
    try {
      return await this.invokeCommand<string>('get_folder_location', {
        requireEmpty: requireEmpty || false,
      });
    } catch (error) {
      this.notificationService.alertModal(
        this.translate.instant('common.error'),
        String(error),
        undefined,
        {
          icon: 'circle-exclamation',
          color: 'warn',
        }
      );
      throw error;
    }
  }

  /**
   * Select a path using the integrated Nautilus file browser
   */
  async selectPathWithNautilus(config: FilePickerConfig): Promise<FilePickerResult> {
    const requestId =
      config.requestId ??
      (typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `picker_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);

    this.nautilusService.openFilePicker({ ...config, requestId });
    return firstValueFrom(
      this.nautilusService.filePickerResult$.pipe(filter(result => result.requestId === requestId))
    );
  }

  /**
   * Select a file
   * @param initialPath - Optional initial path to open the picker to
   */
  async selectFile(initialPath?: string): Promise<string> {
    // In headless mode, use Nautilus file browser
    if (this.apiClient.isHeadless()) {
      const config: FilePickerConfig = {
        mode: 'local',
        selection: 'files',
        multi: false,
        initialLocation: initialPath,
      };
      const result = await this.selectPathWithNautilus(config);
      if (result.cancelled || (result.items.length === 0 && result.paths.length === 0)) {
        throw new Error('File selection cancelled');
      }
      // Prefer structured item path, fallback to flat string
      return result.items.length > 0 ? result.items[0].entry.Path : result.paths[0];
    }

    // In Tauri mode, use native dialog
    try {
      return await this.invokeCommand<string>('get_file_location', { initialPath });
    } catch (error) {
      this.notificationService.alertModal(
        this.translate.instant('common.error'),
        String(error),
        undefined,
        {
          icon: 'circle-exclamation',
          color: 'warn',
        }
      );
      throw error;
    }
  }

  /**
   * Open a path in the system file manager
   */
  async openInFiles(path: string): Promise<void> {
    return this.invokeCommand('open_in_files', { path });
  }
}
