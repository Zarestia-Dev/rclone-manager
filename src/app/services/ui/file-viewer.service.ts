import { Injectable, inject, signal, WritableSignal } from '@angular/core';
import { Overlay } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { platform } from '@tauri-apps/plugin-os';
import { FileViewerModalComponent } from '../../file-browser/file-viewer/file-viewer-modal.component';
import { Entry } from '@app/types';
import { IconService } from './icon.service';
import { PathService } from '../infrastructure/platform/path.service';
import { isHeadlessMode } from '../infrastructure/platform/api-client.service';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';

@Injectable({
  providedIn: 'root',
})
export class FileViewerService extends TauriBaseService {
  private overlay = inject(Overlay);
  private iconService = inject(IconService);
  private pathService = inject(PathService);

  // Use Angular signal for viewer open state
  private readonly _isViewerOpen: WritableSignal<boolean> = signal(false);
  public readonly isViewerOpen = this._isViewerOpen;
  public readonly activeFileName = signal<string | null>(null);

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
      this.activeFileName.set(null);
    });

    overlayRef.backdropClick().subscribe(() => {
      overlayRef.dispose();
      this._isViewerOpen.set(false);
      this.activeFileName.set(null);
    });
  }

  async getFileType(item: Entry, _remoteName: string, _isLocal: boolean): Promise<string> {
    return this.iconService.getFileTypeCategory(item);
  }

  async getAudioCover(item: Entry, remoteName: string, isLocal: boolean): Promise<string | null> {
    const remote = remoteName;
    const path = item.Path;

    if (isLocal) {
      const fullPath = this.pathService.joinPath(remote, path);

      if (isHeadlessMode()) {
        const encodedPath = encodeURIComponent(fullPath);
        return `${this.apiClient.getApiBase()}/stream/audio-cover?path=${encodedPath}`;
      }
      return `audio-cover://localhost/local/${encodeURIComponent(fullPath)}`;
    } else {
      // Remote
      if (isHeadlessMode()) {
        const encodedRemote = encodeURIComponent(remote);
        const encodedPath = encodeURIComponent(path);
        return `${this.apiClient.getApiBase()}/stream/audio-cover?path=${encodedPath}&remote=${encodedRemote}`;
      }
      return `audio-cover://localhost/remote/${encodeURIComponent(remote)}/${encodeURIComponent(
        path
      )}`;
    }
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
      const fileDir = this.pathService.getDirname(baseItem.Path);

      // 2. Construct full target path relative to remote/local root
      const combined = this.pathService.joinPath(fileDir, relativePath);
      const normalizedPath = this.pathService.normalizePath(combined);

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
    if (isLocal) {
      const fullPath = this.pathService.joinPath(remoteName, path);

      if (isHeadlessMode()) {
        const encodedPath = encodeURIComponent(fullPath);
        return `${this.apiClient.getApiBase()}/stream?path=${encodedPath}`;
      }
      // Use our own local-asset:// custom protocol instead of Tauri's asset://.
      // Linux/macOS (WebKit): local-asset://localhost/path/to/file
      // Windows   (WebView2): http://local-asset.localhost/Z%3A/path/to/file
      // Encode each segment individually (preserves '/' separators)
      const encodedSegments = this.pathService.encodePath(fullPath, true, {
        platform: platform(),
        protocol: platform() === 'windows' ? 'http' : 'local-asset',
      });

      if (platform() === 'windows') {
        return `http://local-asset.localhost/${encodedSegments}`;
      }

      const pathWithSlash = encodedSegments.startsWith('/')
        ? encodedSegments
        : `/${encodedSegments}`;
      return `local-asset://localhost${pathWithSlash}`;
    }
    const rName = remoteName.includes(':') ? remoteName : `${remoteName}:`;
    const encodedPath = this.pathService.encodePath(path, false);

    if (isHeadlessMode()) {
      return `${this.apiClient.getApiBase()}/stream/remote?remote=${encodeURIComponent(
        rName
      )}&path=${encodedPath}`;
    }

    const urlSafeRemote = this.pathService.normalizeRemoteName(rName);
    const encodedRemote = encodeURIComponent(urlSafeRemote);
    if (platform() === 'windows') {
      return `http://rclone.localhost/${encodedRemote}/${encodedPath}`;
    }
    return `rclone://localhost/${encodedRemote}/${encodedPath}`;
  }
}
