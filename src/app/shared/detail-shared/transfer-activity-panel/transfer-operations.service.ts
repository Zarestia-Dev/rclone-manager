import { inject, Injectable, signal } from '@angular/core';
import { Entry } from '@app/types';
import { TranslateService } from '@ngx-translate/core';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { FileViewerService } from 'src/app/services/ui/file-viewer.service';
import { isHeadlessMode } from 'src/app/services/infrastructure/platform/api-client.service';

@Injectable()
export class TransferOperationsService {
  private readonly translate = inject(TranslateService);
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly remoteManagement = inject(RemoteManagementService);
  private readonly notifications = inject(NotificationService);
  private readonly pathService = inject(PathService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly fileViewerService = inject(FileViewerService);

  readonly loadingUrlIds = signal<Set<string>>(new Set());
  readonly downloadingIds = signal<Set<string>>(new Set());
  readonly deletingIds = signal<Set<string>>(new Set());

  getRemoteName(fs: string): string {
    if (!fs || this.pathService.isLocalPath(fs)) return '';
    const parts = fs.split(':');
    if (parts.length > 1) {
      const name = parts[0];
      if (name === 'http' || name === 'https' || name === 'ftp') return '';
      return name;
    }
    return '';
  }

  isFeaturesLoading(fs: string | undefined): boolean {
    const remote = this.getRemoteName(fs || '');
    if (!remote) return false;
    return !!this.remoteManagement.getFeaturesSignal(remote)().loading;
  }

  isFallbackFeaturesLoading(remoteName: string): boolean {
    const fallback = this.pathService.normalizeRemoteName(remoteName);
    if (!fallback) return false;
    return !!this.remoteManagement.getFeaturesSignal(fallback)().loading;
  }

  canCopyUrlSource(
    item: { srcFs?: string; group?: string; status?: string },
    jobType: string
  ): boolean {
    if (item.status === 'missing_src') return false;

    const isMove = jobType === 'move' || item.group?.split('/')[0]?.toLowerCase() === 'move';
    const isDelete =
      ['delete', 'cleanup', 'rmdirs'].includes(jobType) ||
      ['delete', 'cleanup', 'rmdirs'].includes(item.group?.split('/')[0]?.toLowerCase() || '');
    if ((isMove || isDelete) && item.status !== 'failed') {
      return false;
    }

    const srcRemote = this.getRemoteName(item.srcFs || '');
    if (!srcRemote) return false;
    const feats = this.remoteManagement.getFeaturesSignal(srcRemote)();
    return feats.PublicLink || !!feats.loading;
  }

  canCopyUrlDst(
    item: { dstFs?: string; group?: string; status?: string },
    jobType: string
  ): boolean {
    if (item.status === 'failed' || item.status === 'missing_dst') return false;

    const isDelete =
      ['delete', 'cleanup', 'rmdirs'].includes(jobType) ||
      ['delete', 'cleanup', 'rmdirs'].includes(item.group?.split('/')[0]?.toLowerCase() || '');
    if (isDelete) return false;

    const dstRemote = this.getRemoteName(item.dstFs || '');
    if (!dstRemote) return false;
    const feats = this.remoteManagement.getFeaturesSignal(dstRemote)();
    return feats.PublicLink || !!feats.loading;
  }

  canCopyUrlFallback(
    item: { group?: string; status?: string },
    jobType: string,
    remoteName: string
  ): boolean {
    if (!remoteName || item.status === 'failed') return false;
    const isDelete =
      ['delete', 'cleanup', 'rmdirs'].includes(jobType) ||
      ['delete', 'cleanup', 'rmdirs'].includes(item.group?.split('/')[0]?.toLowerCase() || '');
    if (isDelete) return false;

    const fallback = this.pathService.normalizeRemoteName(remoteName);
    if (!fallback) return false;
    const feats = this.remoteManagement.getFeaturesSignal(fallback)();
    return feats.PublicLink || !!feats.loading;
  }

  canDownloadSource(
    item: { srcFs?: string; group?: string; status?: string },
    jobType: string
  ): boolean {
    if (item.status === 'missing_src') return false;

    const isMove = jobType === 'move' || item.group?.split('/')[0]?.toLowerCase() === 'move';
    const isDelete =
      ['delete', 'cleanup', 'rmdirs'].includes(jobType) ||
      ['delete', 'cleanup', 'rmdirs'].includes(item.group?.split('/')[0]?.toLowerCase() || '');
    if ((isMove || isDelete) && item.status !== 'failed') {
      return false;
    }

    const srcRemote = this.getRemoteName(item.srcFs || '');
    return !!srcRemote;
  }

  canDownloadDst(
    item: { dstFs?: string; group?: string; status?: string },
    jobType: string
  ): boolean {
    if (item.status === 'failed' || item.status === 'missing_dst') return false;

    const isDelete =
      ['delete', 'cleanup', 'rmdirs'].includes(jobType) ||
      ['delete', 'cleanup', 'rmdirs'].includes(item.group?.split('/')[0]?.toLowerCase() || '');
    if (isDelete) return false;

    const dstRemote = this.getRemoteName(item.dstFs || '');
    return !!dstRemote;
  }

  canDownloadFallback(
    item: { group?: string; status?: string },
    jobType: string,
    remoteName: string
  ): boolean {
    if (!remoteName || item.status === 'failed') return false;
    const isDelete =
      ['delete', 'cleanup', 'rmdirs'].includes(jobType) ||
      ['delete', 'cleanup', 'rmdirs'].includes(item.group?.split('/')[0]?.toLowerCase() || '');
    if (isDelete) return false;

    const fallback = this.pathService.normalizeRemoteForRclone(remoteName);
    return !this.pathService.isLocalPath(fallback);
  }

  canDeleteSource(
    item: { srcFs?: string; group?: string; status?: string },
    jobType: string
  ): boolean {
    return this.canDownloadSource(item, jobType);
  }

  canDeleteDst(
    item: { dstFs?: string; group?: string; status?: string },
    jobType: string
  ): boolean {
    return this.canDownloadDst(item, jobType);
  }

  canDeleteFallback(
    item: { group?: string; status?: string },
    jobType: string,
    remoteName: string
  ): boolean {
    return this.canDownloadFallback(item, jobType, remoteName);
  }

  async copyUrlSource(item: { srcFs?: string; name: string }, uniqueId: string): Promise<void> {
    const key = `${uniqueId}-src`;
    this.loadingUrlIds.update(s => new Set(s).add(key));
    try {
      const result = await this.remoteOps.getPublicLink(
        item.srcFs || '',
        item.name,
        false,
        undefined,
        'dashboard'
      );
      if (result?.url) {
        await navigator.clipboard.writeText(result.url);
        this.notifications.showSuccess(
          this.translate.instant('shared.transferActivity.actions.successCopyUrl')
        );
      } else {
        throw new Error('No link generated');
      }
    } catch (e) {
      console.error('Failed to get source public link:', e);
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.notifications.showError(
        this.translate.instant('shared.transferActivity.actions.failCopyUrl') + ': ' + errorMsg
      );
    } finally {
      this.loadingUrlIds.update(s => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  async copyUrlDst(item: { dstFs?: string; name: string }, uniqueId: string): Promise<void> {
    const key = `${uniqueId}-dst`;
    this.loadingUrlIds.update(s => new Set(s).add(key));
    try {
      const result = await this.remoteOps.getPublicLink(
        item.dstFs || '',
        item.name,
        false,
        undefined,
        'dashboard'
      );
      if (result?.url) {
        await navigator.clipboard.writeText(result.url);
        this.notifications.showSuccess(
          this.translate.instant('shared.transferActivity.actions.successCopyUrl')
        );
      } else {
        throw new Error('No link generated');
      }
    } catch (e) {
      console.error('Failed to get destination public link:', e);
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.notifications.showError(
        this.translate.instant('shared.transferActivity.actions.failCopyUrl') + ': ' + errorMsg
      );
    } finally {
      this.loadingUrlIds.update(s => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  async copyUrlFallback(
    item: { name: string },
    uniqueId: string,
    remoteName: string
  ): Promise<void> {
    const key = `${uniqueId}-fallback`;
    this.loadingUrlIds.update(s => new Set(s).add(key));
    try {
      const fallback = this.pathService.normalizeRemoteForRclone(remoteName);
      const result = await this.remoteOps.getPublicLink(
        fallback,
        item.name,
        false,
        undefined,
        'dashboard'
      );
      if (result?.url) {
        await navigator.clipboard.writeText(result.url);
        this.notifications.showSuccess(
          this.translate.instant('shared.transferActivity.actions.successCopyUrl')
        );
      } else {
        throw new Error('No link generated');
      }
    } catch (e) {
      console.error('Failed to get fallback public link:', e);
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.notifications.showError(
        this.translate.instant('shared.transferActivity.actions.failCopyUrl') + ': ' + errorMsg
      );
    } finally {
      this.loadingUrlIds.update(s => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  async downloadSource(item: { srcFs?: string; name: string }, uniqueId: string): Promise<void> {
    const key = `${uniqueId}-src`;
    this.downloadingIds.update(s => new Set(s).add(key));
    try {
      const fileRemote = item.srcFs || '';
      const path = item.name;
      const fileName = this.pathService.extractName(path);
      await this.performDownload(fileRemote, path, fileName);
    } catch (e) {
      console.error('Download from source failed:', e);
      this.notifications.showError(
        this.translate.instant('shared.transferActivity.actions.failDownload')
      );
    } finally {
      this.downloadingIds.update(s => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  async downloadDst(item: { dstFs?: string; name: string }, uniqueId: string): Promise<void> {
    const key = `${uniqueId}-dst`;
    this.downloadingIds.update(s => new Set(s).add(key));
    try {
      const fileRemote = item.dstFs || '';
      const path = item.name;
      const fileName = this.pathService.extractName(path);
      await this.performDownload(fileRemote, path, fileName);
    } catch (e) {
      console.error('Download from destination failed:', e);
      this.notifications.showError(
        this.translate.instant('shared.transferActivity.actions.failDownload')
      );
    } finally {
      this.downloadingIds.update(s => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  async downloadFallback(
    item: { name: string },
    uniqueId: string,
    remoteName: string
  ): Promise<void> {
    const key = `${uniqueId}-fallback`;
    this.downloadingIds.update(s => new Set(s).add(key));
    try {
      const fallback = this.pathService.normalizeRemoteForRclone(remoteName);
      const path = item.name;
      const fileName = this.pathService.extractName(path);
      await this.performDownload(fallback, path, fileName);
    } catch (e) {
      console.error('Download from fallback failed:', e);
      this.notifications.showError(
        this.translate.instant('shared.transferActivity.actions.failDownload')
      );
    } finally {
      this.downloadingIds.update(s => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  private async performDownload(fileRemote: string, path: string, fileName: string): Promise<void> {
    if (isHeadlessMode()) {
      const isLocal = this.pathService.isLocalPath(fileRemote) || fileRemote === '/';
      const rawUrl = await this.fileViewerService.generateUrl(
        { Path: path, Name: fileName } as unknown as Entry,
        fileRemote,
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

      this.notifications.showInfo(
        this.translate.instant('fileBrowser.fileViewer.downloading', { name: fileName })
      );
    } else {
      const selectedPath = await this.fileSystemService.selectFolder();
      if (selectedPath) {
        this.notifications.showInfo(
          this.translate.instant('fileBrowser.fileViewer.downloading', { name: fileName })
        );
        await this.remoteOps.transferItems(
          [{ remote: fileRemote, path, name: fileName, isDir: false }],
          selectedPath,
          '',
          'copy',
          'dashboard'
        );
        this.notifications.showSuccess(
          this.translate.instant('shared.transferActivity.actions.successDownload')
        );
      }
    }
  }

  async deleteSource(
    item: { srcFs?: string; name: string },
    uniqueId: string,
    onDeleted?: () => void
  ): Promise<void> {
    const key = `${uniqueId}-src-del`;
    const remote = item.srcFs || '';
    if (!remote) return;
    await this.confirmAndDelete(item, remote, key, onDeleted);
  }

  async deleteDst(
    item: { dstFs?: string; name: string },
    uniqueId: string,
    onDeleted?: () => void
  ): Promise<void> {
    const key = `${uniqueId}-dst-del`;
    const remote = item.dstFs || '';
    if (!remote) return;
    await this.confirmAndDelete(item, remote, key, onDeleted);
  }

  async deleteFallback(
    item: { name: string },
    uniqueId: string,
    remoteName: string,
    onDeleted?: () => void
  ): Promise<void> {
    const key = `${uniqueId}-fallback-del`;
    const remote = this.pathService.normalizeRemoteForRclone(remoteName);
    await this.confirmAndDelete(item, remote, key, onDeleted);
  }

  private async confirmAndDelete(
    item: { name: string },
    remote: string,
    key: string,
    onDeleted?: () => void
  ): Promise<void> {
    const fileName = this.pathService.extractName(item.name);
    const confirmed = await this.notifications.confirmModal(
      this.translate.instant('nautilus.modals.delete.title'),
      this.translate.instant('nautilus.modals.delete.messageSingle', { name: fileName }),
      'common.delete',
      'common.cancel',
      { icon: 'trash', color: 'warn' }
    );
    if (!confirmed) return;

    this.deletingIds.update(s => new Set(s).add(key));
    try {
      await this.remoteOps.deleteItems([{ remote, path: item.name, isDir: false }], 'dashboard');
      this.notifications.showSuccess(
        this.translate.instant('nautilus.notifications.deleteStarted', { count: 1 })
      );
      if (onDeleted) {
        onDeleted();
      }
    } catch (e) {
      console.error('Delete failed:', e);
      this.notifications.showError(
        this.translate.instant('nautilus.errors.deleteFailed', { count: 1, total: 1 })
      );
    } finally {
      this.deletingIds.update(s => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  preloadFeatures(items: { srcFs?: string; dstFs?: string }[]): void {
    const remotes = new Set<string>();
    for (const item of items) {
      if (item.srcFs) {
        const src = this.getRemoteName(item.srcFs);
        if (src) remotes.add(src);
      }
      if (item.dstFs) {
        const dst = this.getRemoteName(item.dstFs);
        if (dst) remotes.add(dst);
      }
    }
    for (const remote of remotes) {
      void this.remoteManagement.getFeatures(remote);
    }
  }
}
