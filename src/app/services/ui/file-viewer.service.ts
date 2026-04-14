import { Injectable, inject, signal, WritableSignal } from '@angular/core';
import { Overlay } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { platform } from '@tauri-apps/plugin-os';
import { FileViewerModalComponent } from '../../file-browser/file-viewer/file-viewer-modal.component';
import { Entry } from '@app/types';
import { IconService } from './icon.service';
import { PathService } from '../infrastructure/platform/path.service';
import { HttpClient } from '@angular/common/http';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { firstValueFrom } from 'rxjs';

@Injectable({
  providedIn: 'root',
})
export class FileViewerService extends TauriBaseService {
  private overlay = inject(Overlay);
  private iconService = inject(IconService);
  private pathService = inject(PathService);
  private http = inject(HttpClient);

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

  async getAudioCover(item: Entry, remoteName: string, isLocal: boolean): Promise<string | null> {
    if (this.apiClient.isHeadless()) {
      try {
        const response = await firstValueFrom(
          this.http.get<{ data: string | null }>(
            `${this.apiClient.getApiBaseUrl()}/fs/audio/cover`,
            {
              params: {
                remote: remoteName,
                path: item.Path,
                is_local: String(isLocal),
              },
            }
          )
        );
        return response?.data ?? null;
      } catch (e) {
        console.warn('[FileViewerService] Failed to fetch audio cover:', e);
        return null;
      }
    } else {
      try {
        return await this.invokeCommand<string | null>('get_audio_cover', {
          remote: remoteName,
          path: item.Path,
          isLocal: isLocal,
        });
      } catch (e) {
        console.warn('[FileViewerService] Failed to invoke get_audio_cover:', e);
        return null;
      }
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
      const lastSlash = baseItem.Path.lastIndexOf('/');
      const fileDir = lastSlash === -1 ? '' : baseItem.Path.substring(0, lastSlash);

      // 2. Construct full target path relative to remote/local root
      // If fileDir is "docs", relative is "../img.png" -> target is "img.png"
      const combined = fileDir ? `${fileDir}/${relativePath}` : relativePath;
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
      const separator = remoteName.endsWith('/') || remoteName.endsWith('\\') ? '' : '/';
      const fullPath = `${remoteName}${separator}${path}`;

      if (this.apiClient.isHeadless()) {
        const encodedPath = encodeURIComponent(fullPath);
        return `${this.apiClient.getApiBaseUrl()}/fs/stream?path=${encodedPath}`;
      }
      // Use our own local-asset:// custom protocol instead of Tauri's asset://.
      // Linux/macOS (WebKit): local-asset://localhost/path/to/file
      // Windows   (WebView2): http://local-asset.localhost/Z%3A/path/to/file
      let normalizedPath = fullPath.replace(/\\/g, '/');
      // Fix missing drive colon: "Z/path" → "Z:/path"
      if (/^[A-Za-z]\//.test(normalizedPath)) {
        normalizedPath = `${normalizedPath[0]}:${normalizedPath.slice(1)}`;
      }
      // Encode each segment individually (preserves '/' separators)
      const encodedSegments = normalizedPath
        .split('/')
        .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
        .join('/');
      if (platform() === 'windows') {
        // Drive colon is invalid in a URL host/path without encoding
        const winPath = encodedSegments.replace(/^([A-Za-z]):/, '$1%3A');
        return `http://local-asset.localhost/${winPath}`;
      }

      const pathWithSlash = encodedSegments.startsWith('/')
        ? encodedSegments
        : `/${encodedSegments}`;
      return `local-asset://localhost${pathWithSlash}`;
    }
    const rName = remoteName.includes(':') ? remoteName : `${remoteName}:`;
    const encodedPath = path
      .split('/')
      .map(p => encodeURIComponent(p))
      .join('/');

    if (this.apiClient.isHeadless()) {
      return `${this.apiClient.getApiBaseUrl()}/fs/stream/remote?remote=${encodeURIComponent(
        rName
      )}&path=${encodedPath}`;
    }

    const urlSafeRemote = rName.endsWith(':') ? rName.slice(0, -1) : rName;
    const encodedRemote = encodeURIComponent(urlSafeRemote);
    if (platform() === 'windows') {
      return `http://rclone.localhost/${encodedRemote}/${encodedPath}`;
    }
    return `rclone://localhost/${encodedRemote}/${encodedPath}`;
  }
}
