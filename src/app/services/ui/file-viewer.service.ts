import { Injectable, inject, signal, WritableSignal } from '@angular/core';
import { Overlay } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { convertFileSrc } from '@tauri-apps/api/core';
import { FileViewerModalComponent } from '../../features/components/file-browser/file-viewer/file-viewer-modal.component';
import { ConfigService } from '../system/config.service';
import { Entry } from '@app/types';
import { ApiClientService } from '../core/api-client.service';

@Injectable({
  providedIn: 'root',
})
export class FileViewerService {
  private overlay = inject(Overlay);
  private configService = inject(ConfigService);
  private apiClient = inject(ApiClientService);

  // Use Angular signal for viewer open state
  private readonly _isViewerOpen: WritableSignal<boolean> = signal(false);
  public readonly isViewerOpen = this._isViewerOpen;

  async open(
    items: Entry[],
    currentIndex: number,
    remoteName: string,
    isLocal: boolean
  ): Promise<void> {
    const item = items[currentIndex];
    const fileType = await this.getFileType(item, remoteName, isLocal);

    const fileUrl = await this.generateUrl(item, remoteName, isLocal);

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
      isLocal,
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

  /**
   * Detect file type based on MIME type, extension, and content inspection.
   * For unknown files, fetches content to determine if binary or text.
   */
  async getFileType(item: Entry, remoteName: string, isLocal: boolean): Promise<string> {
    const syncType = this.getFileTypeSync(item);
    if (syncType !== 'unknown') {
      return syncType;
    }

    // Unknown file type → detect if binary or text by inspecting content
    try {
      const url = await this.generateUrl(item, remoteName, isLocal);
      const response = await fetch(url, {
        headers: { Range: 'bytes=0-1023' },
      });

      if (!response.ok) {
        // Range request not supported, fetch full content (may be slow for large files)
        const fullResponse = await fetch(url);
        const buffer = await fullResponse.arrayBuffer();
        return this.isBinaryContent(buffer) ? 'binary' : 'text';
      }

      const sampleBuffer = await response.arrayBuffer();
      return this.isBinaryContent(sampleBuffer) ? 'binary' : 'text';
    } catch (error) {
      console.error('Error detecting file type:', error);
      return 'binary'; // Fallback to binary on error
    }
  }

  /**
   * Synchronous file type detection based on MIME type and extension only.
   * Use this for quick lookups like icons. Returns 'binary' for unknown files.
   */
  getFileTypeSync(item: Entry): string {
    if (item.IsDir) {
      return 'directory';
    }

    // Check MIME type for media files (browsers handle these natively)
    const mimeType = item.MimeType;
    if (mimeType) {
      if (mimeType.startsWith('image/')) return 'image';
      if (mimeType.startsWith('video/')) return 'video';
      if (mimeType.startsWith('audio/')) return 'audio';
      if (mimeType === 'application/pdf') return 'pdf';
      if (mimeType.startsWith('text/')) return 'text';
    }

    // Extension fallback for media types (browsers render these natively)
    const extension = item.Name.split('.').pop()?.toLowerCase() || '';
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico'].includes(extension))
      return 'image';
    if (['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv'].includes(extension)) return 'video';
    if (['mp3', 'wav', 'flac', 'aac', 'm4a'].includes(extension)) return 'audio';
    if (extension === 'pdf') return 'pdf';

    // Unknown - would need content inspection to determine if text or binary
    return 'unknown';
  }

  /**
   * Detect if content is binary by checking for NULL bytes and non-printable characters.
   * This is how VSCode and other editors detect binary content.
   * @param buffer ArrayBuffer of file content (first 512-1024 bytes is sufficient)
   * @returns true if content appears to be binary, false if it looks like text
   */
  isBinaryContent(buffer: ArrayBuffer): boolean {
    const bytes = new Uint8Array(buffer);
    const checkLength = Math.min(bytes.length, 512);

    if (checkLength === 0) return false; // Empty file is text

    let nonPrintable = 0;
    for (let i = 0; i < checkLength; i++) {
      // NULL byte is a strong indicator of binary content
      if (bytes[i] === 0) {
        return true;
      }

      // Count non-printable characters (excluding tab, newline, carriage return)
      if (bytes[i] < 32 && bytes[i] !== 9 && bytes[i] !== 10 && bytes[i] !== 13) {
        nonPrintable++;
      }
    }

    // If more than 30% of characters are non-printable, it's likely binary
    return nonPrintable / checkLength > 0.3;
  }

  async generateUrl(item: Entry, remoteName: string, isLocal: boolean): Promise<string> {
    const baseUrl = this.configService.rcloneServeUrl();

    if (isLocal) {
      const separator = remoteName.endsWith('/') || remoteName.endsWith('\\') ? '' : '/';
      const fullPath = `${remoteName}${separator}${item.Path}`;

      if (this.apiClient.isHeadless()) {
        const encodedPath = encodeURIComponent(fullPath);
        return `${this.apiClient.getApiBaseUrl()}/fs/stream?path=${encodedPath}`;
      }
      return convertFileSrc(fullPath);
    }
    const rName = remoteName.includes(':') ? remoteName : `${remoteName}:`;
    return `${baseUrl}/[${rName}]/${item.Path}`;
  }
}
