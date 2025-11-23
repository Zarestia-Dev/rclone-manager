import { Injectable, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { FileViewerModalComponent } from '../../features/modals/file-viewer/file-viewer-modal.component';
import { Entry } from '@app/types';

@Injectable({
  providedIn: 'root',
})
export class FileViewerService {
  private dialog = inject(MatDialog);

  open(item: Entry, remoteName: string): void {
    const supportedTypes = ['image', 'video', 'audio', 'pdf', 'text'];
    const fileType = this.getFileType(item);

    if (supportedTypes.includes(fileType)) {
      const baseUrl = 'http://127.0.0.1:51900';
      const fileUrl = `${baseUrl}/[${remoteName}:]/${item.Path}`;

      this.dialog.open(FileViewerModalComponent, {
        data: { url: fileUrl, fileType, name: item.Name },
        panelClass: 'file-viewer-overlay',
        backdropClass: 'file-viewer-backdrop',
      });
    } else {
      console.warn('Unsupported file type for preview:', item.Name);
    }
  }

  private getFileType(item: Entry): string {
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

    return 'unsupported';
  }
}
