import { inject, Injectable } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { NautilusService } from '../ui/nautilus.service';
import { FilePickerConfig, FilePickerResult } from '@app/types';
import { PathService } from '../infrastructure/platform/path.service';
import { filter, firstValueFrom } from 'rxjs';
import { isMobile } from '../infrastructure/platform/api-client.service';
import { BackendService } from '../infrastructure/system/backend.service';
import { generatePrefixedId } from 'src/app/shared/utils';

/**
 * Service for file system operations
 * Handles file/folder selection and system integration
 */
@Injectable({
  providedIn: 'root',
})
export class FileSystemService extends TauriBaseService {
  private nautilusService = inject(NautilusService);
  private backendService = inject(BackendService);
  private pathService = inject(PathService);

  canSelectDriveLetter(): boolean {
    return (
      this.isTauri &&
      !isMobile() &&
      this.backendService.isLocalBackend() &&
      this.backendService.isWindows()
    );
  }

  getAvailableDriveLetters(): Promise<string[]> {
    return this.canSelectDriveLetter()
      ? this.invokeCommand<string[]>('get_available_drive_letters')
      : Promise.resolve([]);
  }

  /**
   * Returns true if the internal Nautilus browser should be used instead of native system dialogs.
   * This is true in headless mode or when a remote rclone backend is active.
   */
  private isInternalBrowserPreferred(): boolean {
    return !this.isTauri || this.backendService.activeBackend() !== 'Local' || isMobile();
  }

  /**
   * Select a folder with optional empty requirement
   * @param requireEmpty - If true, require the folder to be empty (for mount destinations)
   * @param initialPath - Optional initial path to open the picker to
   */
  async selectFolder(requireEmpty?: boolean, initialPath?: string): Promise<string> {
    // If internal browser is preferred (headless or remote backend), use Nautilus
    if (this.isInternalBrowserPreferred()) {
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
      // Return full path constructed by Nautilus
      return result.paths[0];
    }

    // In Tauri mode, use native dialog
    try {
      return await this.invokeCommand<string>('get_folder_location', {
        requireEmpty: requireEmpty || false,
        initialPath,
      });
    } catch (error) {
      this.notificationService.confirmModal(
        this.translate.instant('common.error'),
        String(error),
        '',
        'common.close',
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
    const requestId = config.requestId ?? generatePrefixedId('picker');

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
    // If internal browser is preferred (headless or remote backend), use Nautilus
    if (this.isInternalBrowserPreferred()) {
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
      // Return full path constructed by Nautilus
      return result.paths[0];
    }

    // In Tauri mode, use native dialog
    try {
      return await this.invokeCommand<string>('get_file_location', { initialPath });
    } catch (error) {
      this.notificationService.confirmModal(
        this.translate.instant('common.error'),
        String(error),
        '',
        'common.close',
        {
          icon: 'circle-exclamation',
          color: 'warn',
        }
      );
      throw error;
    }
  }

  /**
   * Select multiple local files for uploading.
   * An upload sends files from this device, so the desktop always uses its native dialog, also
   * with a remote engine (whose own disk is the file browser's Local root). Mobile and headless
   * use Nautilus in local-only mode.
   */
  async selectFilesForUpload(): Promise<string[]> {
    if (!this.isTauri || isMobile()) {
      const config: FilePickerConfig = {
        mode: 'local',
        selection: 'files',
        multi: true,
      };
      const result = await this.selectPathWithNautilus(config);
      if (result.cancelled) return [];
      return result.paths;
    }
    try {
      const paths = await this.invokeCommand<string[] | null>('get_files_location');
      return paths ?? [];
    } catch {
      return [];
    }
  }

  /** Select a folder to upload, from this device like `selectFilesForUpload`. Null when cancelled. */
  async selectFolderForUpload(): Promise<string | null> {
    if (!this.isTauri || isMobile()) {
      const result = await this.selectPathWithNautilus({
        mode: 'local',
        selection: 'folders',
        multi: false,
      });
      return result.cancelled ? null : (result.paths[0] ?? null);
    }
    return this.invokeCommand<string | null>('get_folder_location', { requireEmpty: false });
  }

  /**
   * Open a path in the system file manager, or in our file browser when the path is not on this
   * computer (headless, remote engine).
   */
  async openInFiles(path: string): Promise<void> {
    if (!path) return;

    // A path on the web server or on a remote engine does not exist on this computer, so the
    // system file manager cannot open it: our file browser reads it through the engine.
    if (!this.isTauri || this.backendService.activeBackend() !== 'Local') {
      const { remote, remainder } = this.pathService.splitLocalPath(path);
      return this.nautilusService.newNautilusWindow(remote, remainder);
    }

    if (!this.pathService.isTrulyLocalPath(path) && !path.startsWith('saf://')) {
      const { remote, path: relativePath } = this.pathService.splitFsPath(path);
      if (remote) {
        return this.nautilusService.newNautilusWindow(remote, relativePath);
      }
    }

    if (isMobile()) {
      const isInternalAppPath =
        path.startsWith('/data/') ||
        path.startsWith('/data/user/') ||
        path.includes('com.rclone.manager');
      if (isInternalAppPath) {
        const { remote, remainder } = this.pathService.splitLocalPath(path);
        return this.nautilusService.newNautilusWindow(remote, remainder);
      }
    }

    try {
      return await this.invokeCommand('open_in_files', { path });
    } catch (error) {
      const translatedError = this.backendTranslation.translateBackendMessage(error);
      this.notificationService.showError(
        this.translate.instant('home.errors.openFailed', { name: path }) + ': ' + translatedError
      );
      throw error;
    }
  }
}
