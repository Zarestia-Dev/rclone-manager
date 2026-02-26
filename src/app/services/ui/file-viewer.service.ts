import { Injectable, inject, signal, WritableSignal } from '@angular/core';
import { Overlay } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { convertFileSrc } from '@tauri-apps/api/core';
import { FileViewerModalComponent } from '../../features/components/file-browser/file-viewer/file-viewer-modal.component';
import { ConfigService } from '../system/config.service';
import { Entry } from '@app/types';
import { ApiClientService } from '../core/api-client.service';
import { IconService } from './icon.service';

@Injectable({
  providedIn: 'root',
})
export class FileViewerService {
  private overlay = inject(Overlay);
  private configService = inject(ConfigService);
  private apiClient = inject(ApiClientService);
  private iconService = inject(IconService);

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

  async getFileType(item: Entry, _remoteName: string, _isLocal: boolean): Promise<string> {
    return this.iconService.getFileTypeCategory(item);
  }

  async generateUrl(item: Entry, remoteName: string, isLocal: boolean): Promise<string> {
    return this.generateUrlFromPath(item.Path, remoteName, isLocal);
  }

  async resolveRelativePath(
    baseItem: Entry,
    remoteName: string,
    isLocal: boolean,
    relativePath: string
  ): Promise<string> {
    // Skip absolute URLs
    if (/^(?:[a-z]+:|\/|#)/i.test(relativePath)) return relativePath;

    try {
      // 1. Determine the directory of the base file
      const lastSlash = baseItem.Path.lastIndexOf('/');
      const fileDir = lastSlash === -1 ? '' : baseItem.Path.substring(0, lastSlash);

      // 2. Construct full target path relative to remote/local root
      // If fileDir is "docs", relative is "../img.png" -> target is "img.png"
      const combined = fileDir ? `${fileDir}/${relativePath}` : relativePath;
      const normalizedPath = this.normalizePath(combined);

      // 3. Generate URL for this new path
      return this.generateUrlFromPath(normalizedPath, remoteName, isLocal);
    } catch (e) {
      console.warn('Failed to resolve relative path:', relativePath, e);
      return relativePath;
    }
  }

  private async generateUrlFromPath(
    path: string,
    remoteName: string,
    isLocal: boolean
  ): Promise<string> {
    // Always fetch the latest URL to handle dynamic engine port/host changes
    const baseUrl = await this.configService.loadRcloneServeUrl();

    if (isLocal) {
      const separator = remoteName.endsWith('/') || remoteName.endsWith('\\') ? '' : '/';
      const fullPath = `${remoteName}${separator}${path}`;

      if (this.apiClient.isHeadless()) {
        const encodedPath = encodeURIComponent(fullPath);
        return `${this.apiClient.getApiBaseUrl()}/fs/stream?path=${encodedPath}`;
      }
      return convertFileSrc(fullPath);
    }
    const rName = remoteName.includes(':') ? remoteName : `${remoteName}:`;
    // For remote files, we strictly follow the server format
    // Ensure path is URL encoded for the browser fetch
    const encodedPath = path
      .split('/')
      .map(p => encodeURIComponent(p))
      .join('/');
    return `${baseUrl}/[${rName}]/${encodedPath}`;
  }

  private normalizePath(p: string): string {
    const parts = p.split(/[/\\]/);
    const stack: string[] = [];
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (stack.length > 0) stack.pop();
      } else {
        stack.push(part);
      }
    }
    return stack.join('/');
  }
}
