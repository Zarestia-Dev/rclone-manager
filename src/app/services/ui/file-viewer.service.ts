import { Injectable, inject, signal } from '@angular/core';
import { outputToObservable } from '@angular/core/rxjs-interop';
import { Overlay } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { platform } from '@tauri-apps/plugin-os';
import { Entry } from '@app/types';
import { take } from 'rxjs/operators';
import { IconService } from './icon.service';
import { PathService } from '../infrastructure/platform/path.service';
import { PathNavigationService } from '../infrastructure/platform/path-navigation.service';
import { isHeadlessMode, isMobile } from '../infrastructure/platform/api-client.service';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';

@Injectable({
  providedIn: 'root',
})
export class FileViewerService extends TauriBaseService {
  private readonly overlay = inject(Overlay);
  private readonly iconService = inject(IconService);
  private readonly pathService = inject(PathService);
  private readonly pathNavigationService = inject(PathNavigationService);

  private readonly _isViewerOpen = signal<boolean>(false);
  public readonly isViewerOpen = this._isViewerOpen.asReadonly();

  private readonly _activeFileName = signal<string | null>(null);
  public readonly activeFileName = this._activeFileName.asReadonly();

  setActiveFileName(name: string | null): void {
    this._activeFileName.set(name);
  }

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

    const { FileViewerModalComponent } =
      await import('../../file-browser/file-viewer/file-viewer-modal.component');
    const portal = new ComponentPortal(FileViewerModalComponent);
    const componentRef = overlayRef.attach(portal);
    componentRef.instance.data = {
      items,
      currentIndex,
      url: fileUrl,
      isLocal,
      remoteName,
    };

    const cleanup = (): void => {
      overlayRef.dispose();
      this._isViewerOpen.set(false);
      this._activeFileName.set(null);
    };

    outputToObservable(componentRef.instance.closeViewer)
      .pipe(take(1))
      .subscribe(() => cleanup());
    overlayRef
      .backdropClick()
      .pipe(take(1))
      .subscribe(() => cleanup());
  }

  async getFileType(item: Entry, _remoteName: string, _isLocal: boolean): Promise<string> {
    return this.iconService.getFileTypeCategory(item);
  }

  async getAudioCover(item: Entry, remoteName: string, isLocal: boolean): Promise<string | null> {
    const path = item.Path;

    if (isLocal) {
      const fullPath = this.pathService.joinPath(remoteName, path);

      if (isHeadlessMode()) {
        const encodedPath = encodeURIComponent(fullPath);
        return `${this.apiClient.getApiBase()}/stream/audio-cover?path=${encodedPath}`;
      }
      if (platform() === 'windows' || isMobile()) {
        return `http://audio-cover.localhost/local/${encodeURIComponent(fullPath)}`;
      }
      return `audio-cover://localhost/local/${encodeURIComponent(fullPath)}`;
    } else {
      if (isHeadlessMode()) {
        const encodedRemote = encodeURIComponent(remoteName);
        const encodedPath = encodeURIComponent(path);
        return `${this.apiClient.getApiBase()}/stream/audio-cover?path=${encodedPath}&remote=${encodedRemote}`;
      }
      if (platform() === 'windows' || isMobile()) {
        return `http://audio-cover.localhost/remote/${encodeURIComponent(remoteName)}/${encodeURIComponent(
          path
        )}`;
      }
      return `audio-cover://localhost/remote/${encodeURIComponent(remoteName)}/${encodeURIComponent(
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

      if (isHeadlessMode()) {
        const encodedPath = encodeURIComponent(fullPath);
        return `${this.apiClient.getApiBase()}/stream?path=${encodedPath}`;
      }

      const activePlatform = platform();
      const isHttpScheme = activePlatform === 'windows' || isMobile();
      const encodedSegments = this.pathNavigationService.encodePath(fullPath);

      if (isHttpScheme) {
        const cleanSegments = encodedSegments.startsWith('/')
          ? encodedSegments.substring(1)
          : encodedSegments;
        return `http://local-asset.localhost/${cleanSegments}`;
      }

      const pathWithSlash = encodedSegments.startsWith('/')
        ? encodedSegments
        : `/${encodedSegments}`;
      return `local-asset://localhost${pathWithSlash}`;
    }

    const rName = remoteName.endsWith(':') ? remoteName : `${remoteName}:`;
    const encodedPath = this.pathNavigationService.encodePath(path);

    if (isHeadlessMode()) {
      return `${this.apiClient.getApiBase()}/stream/remote?remote=${encodeURIComponent(
        rName
      )}&path=${encodedPath}`;
    }

    const urlSafeRemote = this.pathService.normalizeRemoteName(rName);
    const encodedRemote = encodeURIComponent(urlSafeRemote);
    if (platform() === 'windows' || isMobile()) {
      return `http://rclone.localhost/${encodedRemote}/${encodedPath}`;
    }
    return `rclone://localhost/${encodedRemote}/${encodedPath}`;
  }
}
