import { Injectable, inject, signal, WritableSignal } from '@angular/core';
import { Overlay } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { FileViewerModalComponent } from '../../features/components/file-browser/file-viewer/file-viewer-modal.component';
import { Entry } from '@app/types';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ConfigService } from '../system/config.service';

@Injectable({
  providedIn: 'root',
})
export class FileViewerService {
  private overlay = inject(Overlay);
  private configService = inject(ConfigService);

  // Use Angular signal for viewer open state
  private readonly _isViewerOpen: WritableSignal<boolean> = signal(false);
  public readonly isViewerOpen = this._isViewerOpen;

  async open(
    items: Entry[],
    currentIndex: number,
    remoteName: string,
    fsType: string
  ): Promise<void> {
    const item = items[currentIndex];
    const fileType = this.getFileType(item);

    const fileUrl = this.generateUrl(item, remoteName, fsType);

    const overlayRef = this.overlay.create({
      hasBackdrop: true,
      scrollStrategy: this.overlay.scrollStrategies.block(),
      positionStrategy: this.overlay.position().global().centerHorizontally().centerVertically(),
    });
    this._isViewerOpen.set(true);

    const portal = new ComponentPortal(FileViewerModalComponent);
    const componentRef = overlayRef.attach(portal);
    componentRef.instance.data = {
      items,
      currentIndex,
      url: fileUrl,
      fileType,
      name: item.Name,
      isLocal: fsType === 'local',
      remoteName,
    };

    componentRef.instance.closeViewer.subscribe(() => {
      overlayRef.dispose();
      this._isViewerOpen.set(false);
    });

    overlayRef.backdropClick().subscribe(() => {
      overlayRef.dispose();
      this._isViewerOpen.set(false);
    });
  }

  getFileType(item: Entry): string {
    if (item.IsDir) {
      return 'directory';
    }
    const mimeType = item.MimeType;
    if (mimeType) {
      if (mimeType.startsWith('image/')) return 'image';
      if (mimeType.startsWith('video/')) return 'video';
      if (mimeType.startsWith('audio/')) return 'audio';
      if (mimeType === 'application/pdf') return 'pdf';
      if (mimeType.startsWith('text/')) return 'text';
    }

    // Fallback to extension-based detection
    const extension = item.Name.split('.').pop()?.toLowerCase() || '';
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(extension)) return 'image';
    if (['mp4', 'webm', 'ogg'].includes(extension)) return 'video';
    if (['mp3', 'wav', 'ogg'].includes(extension)) return 'audio';
    if (extension === 'pdf') return 'pdf';
    if (['txt', 'log', 'md', 'json', 'xml', 'html', 'css', 'js', 'ts'].includes(extension))
      return 'text';

    return 'unknown';
  }

  generateUrl(item: Entry, remoteName: string, fsType: string): string {
    const baseUrl = this.configService.rcloneServeUrl();
    const isLocal = fsType === 'local';
    if (isLocal) {
      if (!remoteName || remoteName === '/') {
        return convertFileSrc(`//${item.Path}`);
      } else {
        const nativePathForTauri = `${remoteName}${item.Path}`;
        return convertFileSrc(nativePathForTauri);
      }
    }

    return `${baseUrl}/[${remoteName}]/${item.Path}`;
  }
}
