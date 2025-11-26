import { inject, Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { NotificationService } from '../../shared/services/notification.service';
import { FilePickerOptions, NautilusService } from '../ui/nautilus.service';
import { firstValueFrom } from 'rxjs';

/**
 * Service for file system operations
 * Handles file/folder selection and system integration
 */
@Injectable({
  providedIn: 'root',
})
export class FileSystemService extends TauriBaseService {
  private notificationService = inject(NotificationService);
  private nautilusService = inject(NautilusService);

  constructor() {
    super();
  }

  /**
   * Select a folder with optional empty requirement
   */
  async selectFolder(requireEmpty?: boolean): Promise<string> {
    try {
      return await this.invokeCommand<string>('get_folder_location', {
        requireEmpty: requireEmpty || false,
      });
    } catch (error) {
      this.notificationService.alertModal('Error', String(error));
      throw error;
    }
  }

  /**
   * Select a path using the integrated Nautilus file browser
   */
  async selectPathWithNautilus(options: FilePickerOptions): Promise<string[] | null> {
    this.nautilusService.openFilePicker(options);
    return firstValueFrom(this.nautilusService.filePickerResult$);
  }

  /**
   * Select a file
   */
  async selectFile(): Promise<string> {
    try {
      return await this.invokeCommand<string>('get_file_location');
    } catch (error) {
      this.notificationService.alertModal('Error', String(error));
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
