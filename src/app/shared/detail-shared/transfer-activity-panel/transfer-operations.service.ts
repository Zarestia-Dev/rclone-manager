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
    const idx = fs.indexOf(':');
    if (idx > 0) {
      const name = fs.substring(0, idx);
      if (name !== 'http' && name !== 'https' && name !== 'ftp') return name;
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

  private isDeleteJob(jobType: string, group?: string): boolean {
    if (jobType === 'delete' || jobType === 'cleanup' || jobType === 'rmdirs') return true;
    const subType = group?.split('/')[0]?.toLowerCase();
    return subType === 'delete' || subType === 'cleanup' || subType === 'rmdirs';
  }

  private isMoveJob(jobType: string, group?: string): boolean {
    return jobType === 'move' || group?.split('/')[0]?.toLowerCase() === 'move';
  }

  canCopyUrlSource(
    item: { srcFs?: string; group?: string; status?: string },
    jobType: string
  ): boolean {
    if (item.status === 'missing_src') return false;
    if (
      (this.isMoveJob(jobType, item.group) || this.isDeleteJob(jobType, item.group)) &&
      item.status !== 'failed'
    )
      return false;

    const srcRemote = this.getRemoteName(item.srcFs || '');
    if (!srcRemote) return false;
    const feats = this.remoteManagement.getFeaturesSignal(srcRemote)();
    return feats.PublicLink || !!feats.loading;
  }

  canCopyUrlDst(
    item: {
      dstFs?: string;
      group?: string;
      status?: string;
      isCompleted?: boolean;
      completedAt?: string;
    },
    jobType: string
  ): boolean {
    if (item.status === 'failed' || item.status === 'missing_dst') return false;
    if (!(item.isCompleted || !!item.completedAt || !!item.status)) return false;
    if (this.isDeleteJob(jobType, item.group)) return false;

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
    if (!remoteName || item.status === 'failed' || this.isDeleteJob(jobType, item.group))
      return false;
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
    if (
      (this.isMoveJob(jobType, item.group) || this.isDeleteJob(jobType, item.group)) &&
      item.status !== 'failed'
    )
      return false;
    return !!this.getRemoteName(item.srcFs || '');
  }

  canDownloadDst(
    item: {
      dstFs?: string;
      group?: string;
      status?: string;
      isCompleted?: boolean;
      completedAt?: string;
    },
    jobType: string
  ): boolean {
    if (item.status === 'failed' || item.status === 'missing_dst') return false;
    if (!(item.isCompleted || !!item.completedAt || !!item.status)) return false;
    if (this.isDeleteJob(jobType, item.group)) return false;
    return !!this.getRemoteName(item.dstFs || '');
  }

  canDownloadFallback(
    item: { group?: string; status?: string },
    jobType: string,
    remoteName: string
  ): boolean {
    if (!remoteName || item.status === 'failed' || this.isDeleteJob(jobType, item.group))
      return false;
    return !this.pathService.isLocalPath(this.pathService.normalizeRemoteForRclone(remoteName));
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
      if (!result?.url) throw new Error('No link generated');
      await navigator.clipboard.writeText(result.url);
      this.notifications.showSuccess(
        this.translate.instant('shared.transferActivity.actions.successCopyUrl')
      );
    } catch (e) {
      this.notifications.showError(
        this.translate.instant('shared.transferActivity.actions.failCopyUrl') +
          ': ' +
          (e instanceof Error ? e.message : String(e))
      );
    } finally {
      this.loadingUrlIds.update(s => {
        const n = new Set(s);
        n.delete(key);
        return n;
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
      if (!result?.url) throw new Error('No link generated');
      await navigator.clipboard.writeText(result.url);
      this.notifications.showSuccess(
        this.translate.instant('shared.transferActivity.actions.successCopyUrl')
      );
    } catch (e) {
      this.notifications.showError(
        this.translate.instant('shared.transferActivity.actions.failCopyUrl') +
          ': ' +
          (e instanceof Error ? e.message : String(e))
      );
    } finally {
      this.loadingUrlIds.update(s => {
        const n = new Set(s);
        n.delete(key);
        return n;
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
      const result = await this.remoteOps.getPublicLink(
        this.pathService.normalizeRemoteForRclone(remoteName),
        item.name,
        false,
        undefined,
        'dashboard'
      );
      if (!result?.url) throw new Error('No link generated');
      await navigator.clipboard.writeText(result.url);
      this.notifications.showSuccess(
        this.translate.instant('shared.transferActivity.actions.successCopyUrl')
      );
    } catch (e) {
      this.notifications.showError(
        this.translate.instant('shared.transferActivity.actions.failCopyUrl') +
          ': ' +
          (e instanceof Error ? e.message : String(e))
      );
    } finally {
      this.loadingUrlIds.update(s => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  }

  async downloadSource(item: { srcFs?: string; name: string }, uniqueId: string): Promise<void> {
    const key = `${uniqueId}-src`;
    this.downloadingIds.update(s => new Set(s).add(key));
    try {
      const fileRemote = item.srcFs || '';
      await this.performDownload(fileRemote, item.name, this.pathService.extractName(item.name));
    } catch (e) {
      this.notifications.showError(
        this.translate.instant('shared.transferActivity.actions.failDownload') +
          ': ' +
          (e instanceof Error ? e.message : String(e))
      );
    } finally {
      this.downloadingIds.update(s => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  }

  async downloadDst(item: { dstFs?: string; name: string }, uniqueId: string): Promise<void> {
    const key = `${uniqueId}-dst`;
    this.downloadingIds.update(s => new Set(s).add(key));
    try {
      const fileRemote = item.dstFs || '';
      await this.performDownload(fileRemote, item.name, this.pathService.extractName(item.name));
    } catch (e) {
      this.notifications.showError(
        this.translate.instant('shared.transferActivity.actions.failDownload') +
          ': ' +
          (e instanceof Error ? e.message : String(e))
      );
    } finally {
      this.downloadingIds.update(s => {
        const n = new Set(s);
        n.delete(key);
        return n;
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
      await this.performDownload(
        this.pathService.normalizeRemoteForRclone(remoteName),
        item.name,
        this.pathService.extractName(item.name)
      );
    } catch (e) {
      this.notifications.showError(
        this.translate.instant('shared.transferActivity.actions.failDownload') +
          ': ' +
          (e instanceof Error ? e.message : String(e))
      );
    } finally {
      this.downloadingIds.update(s => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  }

  private async performDownload(fileRemote: string, path: string, fileName: string): Promise<void> {
    if (isHeadlessMode()) {
      const rawUrl = await this.fileViewerService.generateUrl(
        { Path: path, Name: fileName } as unknown as Entry,
        fileRemote,
        this.pathService.isLocalPath(fileRemote) || fileRemote === '/'
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
    if (item.srcFs) await this.confirmAndDelete(item, item.srcFs, `${uniqueId}-src-del`, onDeleted);
  }

  async deleteDst(
    item: { dstFs?: string; name: string },
    uniqueId: string,
    onDeleted?: () => void
  ): Promise<void> {
    if (item.dstFs) await this.confirmAndDelete(item, item.dstFs, `${uniqueId}-dst-del`, onDeleted);
  }

  async deleteFallback(
    item: { name: string },
    uniqueId: string,
    remoteName: string,
    onDeleted?: () => void
  ): Promise<void> {
    await this.confirmAndDelete(
      item,
      this.pathService.normalizeRemoteForRclone(remoteName),
      `${uniqueId}-fallback-del`,
      onDeleted
    );
  }

  private async confirmAndDelete(
    item: { name: string },
    remote: string,
    key: string,
    onDeleted?: () => void
  ): Promise<void> {
    const confirmed = await this.notifications.confirmModal(
      this.translate.instant('nautilus.modals.delete.title'),
      this.translate.instant('nautilus.modals.delete.messageSingle', {
        name: this.pathService.extractName(item.name),
      }),
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
      if (onDeleted) onDeleted();
    } catch (e) {
      this.notifications.showError(
        this.translate.instant('nautilus.errors.deleteFailed', { count: 1, total: 1 }) +
          ': ' +
          (e instanceof Error ? e.message : String(e))
      );
    } finally {
      this.deletingIds.update(s => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  }

  preloadFeatures(items: { srcFs?: string; dstFs?: string }[]): void {
    const remotes = new Set<string>();
    for (const item of items) {
      if (item.srcFs) {
        const s = this.getRemoteName(item.srcFs);
        if (s) remotes.add(s);
      }
      if (item.dstFs) {
        const d = this.getRemoteName(item.dstFs);
        if (d) remotes.add(d);
      }
    }
    for (const remote of remotes) {
      void this.remoteManagement.getFeatures(remote);
    }
  }
}
