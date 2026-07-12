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
        const url = new URL(rawUrl);
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
}
