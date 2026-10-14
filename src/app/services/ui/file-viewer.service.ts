import { Injectable, inject, signal, effect } from '@angular/core';
import { outputToObservable } from '@angular/core/rxjs-interop';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Entry } from '@app/types';
import { take } from 'rxjs/operators';
import { VaultService } from '../security/vault.service';
import { PathService } from '../infrastructure/platform/path.service';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { NavigationHistoryService } from './navigation-history.service';

import { encodeUrlPath, extractFilenameFromUrl } from 'src/app/shared/utils/url.utils';

@Injectable({
  providedIn: 'root',
})
export class FileViewerService extends TauriBaseService {
  private readonly vault = inject(VaultService);
  private readonly navigationHistory = inject(NavigationHistoryService);
  private overlayRef: OverlayRef | null = null;
  private openGeneration = 0;
  private releaseHistory: (() => void) | null = null;

  constructor() {
    super();
    effect(() => {
      if (!this.vault.isAccessible()) this.close();
    });
  }

  private close(): void {
    this.openGeneration++;
    const releaseHistory = this.releaseHistory;
    this.releaseHistory = null;
    const overlayRef = this.overlayRef;
    this.overlayRef = null;
    overlayRef?.dispose();
    this._isViewerOpen.set(false);
    this._activeFileName.set(null);
    releaseHistory?.();
  }

  private readonly overlay = inject(Overlay);
  private readonly pathService = inject(PathService);

  private readonly _isViewerOpen = signal<boolean>(false);
  public readonly isViewerOpen = this._isViewerOpen.asReadonly();

  private readonly _activeFileName = signal<string | null>(null);
  public readonly activeFileName = this._activeFileName.asReadonly();

  /** Let Tauri choose the platform's registered HTTP(S) or custom protocol origin. */
  private protocolUrl(scheme: string, encodedPath: string): string {
    return `${convertFileSrc('', scheme)}${encodedPath.replace(/^\//, '')}`;
  }

  setActiveFileName(name: string | null): void {
    this._activeFileName.set(name);
  }

  async open(
    items: Entry[],
    currentIndex: number,
    remoteName: string,
    isLocal: boolean
  ): Promise<void> {
    if (!this.vault.isAccessible()) return;
    const item = items[currentIndex];
    if (!item) return;
    const generation = ++this.openGeneration;
    const fileUrl = await this.generateUrl(item, remoteName, isLocal);
    if (generation !== this.openGeneration || !this.vault.isAccessible()) return;
    await this.attachModalOverlay({
      items,
      currentIndex,
      url: fileUrl,
      isLocal,
      remoteName,
    });
  }

  async openDirectUrl(url: string, fileName?: string): Promise<void> {
    const name = fileName || extractFilenameFromUrl(url) || 'file';
    const syntheticItem: Entry = {
      ID: '',
      Name: name,
      Path: name,
      IsDir: false,
      Size: 0,
      MimeType: '',
      ModTime: new Date().toISOString(),
    };

    await this.attachModalOverlay({
      items: [syntheticItem],
      currentIndex: 0,
      url,
      isLocal: false,
      remoteName: '',
      isDirectUrl: true,
    });
  }

  private async attachModalOverlay(data: {
    items: Entry[];
    currentIndex: number;
    url: string;
    isLocal: boolean;
    remoteName: string;
    isDirectUrl?: boolean;
  }): Promise<void> {
    if (!this.vault.isAccessible()) return;
    this.close();
    const overlayRef = this.overlay.create({
      hasBackdrop: true,
      scrollStrategy: this.overlay.scrollStrategies.block(),
      positionStrategy: this.overlay.position().global().centerHorizontally().centerVertically(),
    });
    this.overlayRef = overlayRef;
    this._isViewerOpen.set(true);
    // Register before the lazy import so Back also closes a viewer still loading.
    this.releaseHistory = this.navigationHistory.openLayer(() => this.close());

    try {
      const { FileViewerModalComponent } =
        await import('../../file-browser/file-viewer/file-viewer-modal.component');
      if (!this.vault.isAccessible() || this.overlayRef !== overlayRef) return;
      const componentRef = overlayRef.attach(new ComponentPortal(FileViewerModalComponent));
      componentRef.instance.data = data;

      const closeOverlay = (): void => {
        if (this.overlayRef === overlayRef) this.close();
      };
      outputToObservable(componentRef.instance.closeViewer).pipe(take(1)).subscribe(closeOverlay);
      overlayRef.backdropClick().pipe(take(1)).subscribe(closeOverlay);
    } catch (error) {
      if (this.overlayRef === overlayRef) this.close();
      throw error;
    }
  }

  async getAudioCover(item: Entry, remoteName: string, isLocal: boolean): Promise<string | null> {
    const path = item.Path;

    if (isLocal) {
      const fullPath = this.pathService.joinPath(remoteName, path);

      if (!this.isTauri) {
        const encodedPath = encodeURIComponent(fullPath);
        return `${this.apiClient.getApiBase()}/stream/audio-cover?path=${encodedPath}`;
      }
      return this.protocolUrl('audio-cover', `local/${encodeURIComponent(fullPath)}`);
    } else {
      if (!this.isTauri) {
        const encodedRemote = encodeURIComponent(remoteName);
        const encodedPath = encodeURIComponent(path);
        return `${this.apiClient.getApiBase()}/stream/audio-cover?path=${encodedPath}&remote=${encodedRemote}`;
      }
      return this.protocolUrl(
        'audio-cover',
        `remote/${encodeURIComponent(remoteName)}/${encodeURIComponent(path)}`
      );
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
    if (/^(?:[a-z]+:|\/|#)/i.test(relativePath)) return relativePath;

    try {
      const fileDir = this.pathService.getDirname(baseItem.Path);
      const combined = this.pathService.joinPath(fileDir, relativePath);
      const normalizedPath = this.pathService.normalizePath(combined);

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

      if (!this.isTauri) {
        const encodedPath = encodeURIComponent(fullPath);
        return `${this.apiClient.getApiBase()}/stream?path=${encodedPath}`;
      }

      // Local-asset URLs always use POSIX canonical form (forward slashes,
      // percent-encoded segments) regardless of the underlying filesystem's
      // native separator. The leading-slash sniff is URL-routing logic
      // (absolute vs relative), not an OS inference.
      const encodedSegments = encodeUrlPath(fullPath);

      return this.protocolUrl('local-asset', encodedSegments);
    }

    const rName = remoteName.endsWith(':') ? remoteName : `${remoteName}:`;
    const encodedPath = encodeUrlPath(path);

    if (!this.isTauri) {
      return `${this.apiClient.getApiBase()}/stream/remote?remote=${encodeURIComponent(
        rName
      )}&path=${encodeURIComponent(path)}`;
    }

    const urlSafeRemote = this.pathService.normalizeRemoteName(rName);
    const encodedRemote = encodeURIComponent(urlSafeRemote);
    return this.protocolUrl('rclone', `${encodedRemote}/${encodedPath}`);
  }
}
