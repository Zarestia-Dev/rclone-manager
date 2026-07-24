import { inject, Injectable } from '@angular/core';
import { ApiClientService, isHeadlessMode } from '../infrastructure/platform/api-client.service';
import { FileViewerService } from '../ui/file-viewer.service';
import { NotificationService } from '../ui/notification.service';
import { TranslateService } from '@ngx-translate/core';
import { Entry } from '@app/types';

@Injectable({ providedIn: 'root' })
export class DownloadService {
  private readonly apiClient = inject(ApiClientService);
  private readonly fileViewerService = inject(FileViewerService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);

  /**
   * Downloads a remote or local file directly to the client's PC filesystem.
   *
   * @param remote The rclone remote name or path
   * @param path The path to the file on the remote
   * @param fileName The name of the file
   * @param isLocal Whether the file is local
   * @param size Optional file size in bytes
   */
  async download(
    remote: string,
    path: string,
    fileName: string,
    isLocal: boolean,
    size?: number
  ): Promise<void> {
    if (isHeadlessMode()) {
      // Headless / Web mode download: trigger direct browser download
      try {
        const rawUrl = await this.fileViewerService.generateUrl(
          { Path: path, Name: fileName } as unknown as Entry,
          remote,
          isLocal
        );
        const url = new URL(rawUrl, window.location.origin);
        url.searchParams.set('download', 'true');

        const link = document.createElement('a');
        link.href = url.toString();
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        this.notificationService.showInfo(
          this.translate.instant('fileBrowser.fileViewer.downloading', { name: fileName })
        );
      } catch (err) {
        console.error('Failed to trigger browser download:', err);
        this.notificationService.showError(
          this.translate.instant('fileBrowser.fileViewer.errorDownload')
        );
        throw err;
      }
    } else {
      // Desktop / Tauri mode download: prompt save path and download directly via Tauri Rust
      try {
        const destination = await this.apiClient.invoke<string | null>('get_save_file_location', {
          defaultName: fileName,
        });

        if (!destination) {
          // User cancelled
          return;
        }

        this.notificationService.showInfo(
          this.translate.instant('fileBrowser.fileViewer.downloading', { name: fileName })
        );

        await this.apiClient.invoke('download_file', {
          remote,
          path,
          destination,
          totalSize: size || null,
          isLocal,
        });

        this.notificationService.showSuccess(
          this.translate.instant('shared.transferActivity.actions.successDownload')
        );
      } catch (err) {
        console.error('Failed to download file:', err);
        this.notificationService.showError(
          this.translate.instant('shared.transferActivity.actions.failDownload') +
            ': ' +
            (err instanceof Error ? err.message : String(err))
        );
        throw err;
      }
    }
  }

  /**
   * Opens a remote or local file in the system default native application (e.g. PDF viewer).
   */
  async openFileNatively(
    remote: string,
    path: string,
    fileName: string,
    isLocal: boolean
  ): Promise<void> {
    return this.executeNativeAction('open', remote, path, fileName, isLocal);
  }

  /**
   * Opens the Android native share sheet for a remote or local file.
   */
  async shareFileNatively(
    remote: string,
    path: string,
    fileName: string,
    isLocal: boolean
  ): Promise<void> {
    return this.executeNativeAction('share', remote, path, fileName, isLocal);
  }

  /**
   * Unified helper for native file actions ('open' | 'share').
   * Resolves the local path (or streams remote file to cache), then triggers
   * the appropriate native action (FileProvider intent on Android or open_path on Desktop).
   */
  private async executeNativeAction(
    action: 'open' | 'share',
    remote: string,
    path: string,
    fileName: string,
    isLocal: boolean
  ): Promise<void> {
    try {
      this.notificationService.showInfo(
        this.translate.instant('fileBrowser.fileViewer.openingNative', { name: fileName })
      );

      // Rust resolves the local path (or streams remote file to app cache) and returns the absolute path.
      const localPath = await this.apiClient.invoke<string>('open_file_natively', {
        remote,
        path,
        fileName,
        isLocal,
      });

      // On Android, trigger the Kotlin bridge (FileProvider ACTION_VIEW or ACTION_SEND).
      const bridge = (
        window as Window & {
          __rclone__?: {
            openLocalFile?: (p: string) => void;
            shareFile?: (p: string) => void;
          };
        }
      ).__rclone__;

      if (action === 'open' && bridge?.openLocalFile) {
        bridge.openLocalFile(localPath);
      } else if (action === 'share' && bridge?.shareFile) {
        bridge.shareFile(localPath);
      }
      // On desktop, Rust handles opening directly when action === 'open'.
    } catch (err) {
      console.error(`Failed to execute native ${action} action:`, err);
      this.notificationService.showError(
        this.translate.instant('fileBrowser.fileViewer.errorOpenNative') +
          ': ' +
          (err instanceof Error ? err.message : String(err))
      );
      throw err;
    }
  }
}
