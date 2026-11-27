import { inject, Injectable } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { NautilusService } from '../ui/nautilus.service';
import { FilePickerConfig, FilePickerResult, LocalDrive } from '@app/types';
import { PathService } from '../infrastructure/platform/path.service';
import { filter, firstValueFrom } from 'rxjs';
import { isMobile } from '../infrastructure/platform/api-client.service';
import { BackendService } from '../infrastructure/system/backend.service';
import { generatePrefixedId } from 'src/app/shared/utils';
import { mountDriveLetter } from '../../shared/utils/path.utils';

interface AndroidUploadPicker {
  pickUploadFiles?: (folder: boolean) => boolean;
  clearSharedFiles?: (paths: string) => void;
}

const getBridge = (): AndroidUploadPicker | undefined =>
  (window as Window & { __rclone__?: AndroidUploadPicker }).__rclone__;

type AndroidUploadPick =
  { stage: 'copying'; count: number } | { stage: 'done'; paths: string[]; failed: number };

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

  /**
   * A mount gets a letter of the machine the active engine runs on, local or remote, whichever
   * device the app or its web UI is opened on.
   */
  canSelectDriveLetter(): boolean {
    return this.backendService.isWindows();
  }

  /**
   * The letters the engine's machine has not taken, Z: down to A:, from its rclone `core/disks`.
   * A drive Windows reports as not ready (an empty card reader, a disconnected network drive) is
   * not listed there, and a mount on its letter fails with rclone's error.
   */
  async getAvailableDriveLetters(): Promise<string[]> {
    if (!this.canSelectDriveLetter()) return [];
    const drives = await this.invokeCommand<LocalDrive[]>('get_local_drives');
    const taken = new Set(drives.map(drive => mountDriveLetter(drive.name)));
    return Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(90 - index)}:`).filter(
      letter => !taken.has(letter)
    );
  }

  /**
   * Returns true if the internal Nautilus browser should be used instead of native system dialogs.
   * This is true in server mode or when a remote rclone backend is active.
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
    // If internal browser is preferred (the server or a remote backend), use Nautilus
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
    // If internal browser is preferred (the server or a remote backend), use Nautilus
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
   * with a remote engine (whose own disk is the file browser's Local root), and Android its own
   * picker, which needs no storage permission and reaches every provider. The server uses Nautilus
   * in local-only mode. Pass the paths to `releaseUploadPaths` when their upload ended.
   */
  async selectFilesForUpload(): Promise<string[]> {
    if (this.isTauri && isMobile()) return this.pickOnAndroid(false);
    if (!this.isTauri) {
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
    if (this.isTauri && isMobile()) return (await this.pickOnAndroid(true))[0] ?? null;
    if (!this.isTauri) {
      const result = await this.selectPathWithNautilus({
        mode: 'local',
        selection: 'folders',
        multi: false,
      });
      return result.cancelled ? null : (result.paths[0] ?? null);
    }
    return this.invokeCommand<string | null>('get_folder_location', { requireEmpty: false });
  }

  /** Removes the copies the Android picker made of `paths`. */
  releaseUploadPaths(paths: string[]): void {
    // Only the Android picker hands out copies; the app removes nothing outside their folder.
    if (this.isTauri && isMobile()) getBridge()?.clearSharedFiles?.(JSON.stringify(paths));
  }

  /**
   * Opens the Android picker. Android gives the app only content it may read, which no engine can
   * open by path, so the picked items are copied into the app's cache first; a large pick takes a
   * moment, which the user is told. (Copying a file of the phone in the file browser reads it in
   * place.)
   */
  private pickOnAndroid(folder: boolean): Promise<string[]> {
    const bridge = getBridge();
    if (!bridge?.pickUploadFiles) return Promise.resolve([]);
    return new Promise(resolve => {
      const onPick = (event: Event): void => {
        const pick = (event as CustomEvent<AndroidUploadPick>).detail;
        if (pick.stage === 'copying') {
          this.notificationService.showInfo(
            this.translate.instant('nautilus.notifications.copyingPickedFiles', {
              count: pick.count,
            })
          );
          return;
        }
        window.removeEventListener('android-upload-picked', onPick);
        if (pick.failed > 0) {
          this.notificationService.showError(
            this.translate.instant('nautilus.notifications.pickedFilesNotCopied', {
              count: pick.failed,
            })
          );
        }
        resolve(pick.paths);
      };
      window.addEventListener('android-upload-picked', onPick);
      // Called on the bridge: a Java method detached from its object cannot be invoked.
      if (!bridge.pickUploadFiles?.(folder)) {
        window.removeEventListener('android-upload-picked', onPick);
        resolve([]);
      }
    });
  }

  /**
   * Open a path in the system file manager, or in our file browser when the path is not on this
   * computer (the server, a remote engine).
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
