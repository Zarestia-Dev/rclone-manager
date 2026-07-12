import { inject, Injectable, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { DownloadService } from 'src/app/services/operations/download.service';

type TransferTarget = 'src' | 'dst' | 'fallback';

@Injectable()
export class TransferOperationsService {
  private readonly translate = inject(TranslateService);
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly remoteManagement = inject(RemoteManagementService);
  private readonly notifications = inject(NotificationService);
  private readonly pathService = inject(PathService);
  private readonly downloadService = inject(DownloadService);

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
    return this.canDo('copyUrl', 'src', item, jobType);
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
    return this.canDo('copyUrl', 'dst', item, jobType);
  }

  canCopyUrlFallback(
    item: { group?: string; status?: string },
    jobType: string,
    remoteName: string
  ): boolean {
    return this.canDo('copyUrl', 'fallback', item, jobType, remoteName);
  }

  canDownloadSource(
    item: { srcFs?: string; group?: string; status?: string },
    jobType: string
  ): boolean {
    return this.canDo('download', 'src', item, jobType);
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
    return this.canDo('download', 'dst', item, jobType);
  }

  canDownloadFallback(
    item: { group?: string; status?: string },
    jobType: string,
    remoteName: string
  ): boolean {
    return this.canDo('download', 'fallback', item, jobType, remoteName);
  }

  canDeleteSource(
    item: { srcFs?: string; group?: string; status?: string },
    jobType: string
  ): boolean {
    return this.canDo('delete', 'src', item, jobType);
  }

  canDeleteDst(
    item: { dstFs?: string; group?: string; status?: string },
    jobType: string
  ): boolean {
    return this.canDo('delete', 'dst', item, jobType);
  }

  canDeleteFallback(
    item: { group?: string; status?: string },
    jobType: string,
    remoteName: string
  ): boolean {
    return this.canDo('delete', 'fallback', item, jobType, remoteName);
  }

  private canDo(
    action: 'copyUrl' | 'download' | 'delete',
    target: TransferTarget,
    item: {
      srcFs?: string;
      dstFs?: string;
      group?: string;
      status?: string;
      isCompleted?: boolean;
      completedAt?: string;
    },
    jobType: string,
    remoteName?: string
  ): boolean {
    // `delete` reuses `download`'s permission rules.
    if (action === 'delete') return this.canDo('download', target, item, jobType, remoteName);

    if (target === 'src') {
      if (item.status === 'missing_src') return false;
      if (
        (this.isMoveJob(jobType, item.group) || this.isDeleteJob(jobType, item.group)) &&
        item.status !== 'failed'
      )
        return false;
      const srcRemote = this.getRemoteName(item.srcFs || '');
      if (!srcRemote) return false;
      if (action === 'copyUrl') {
        const feats = this.remoteManagement.getFeaturesSignal(srcRemote)();
        return feats.PublicLink || !!feats.loading;
      }
      return true; // download
    }

    if (target === 'dst') {
      if (item.status === 'failed' || item.status === 'missing_dst') return false;
      if (!(item.isCompleted || !!item.completedAt || !!item.status)) return false;
      if (this.isDeleteJob(jobType, item.group)) return false;
      const dstRemote = this.getRemoteName(item.dstFs || '');
      if (!dstRemote) return false;
      if (action === 'copyUrl') {
        const feats = this.remoteManagement.getFeaturesSignal(dstRemote)();
        return feats.PublicLink || !!feats.loading;
      }
      return true; // download
    }

    // fallback
    if (!remoteName || item.status === 'failed' || this.isDeleteJob(jobType, item.group))
      return false;
    if (action === 'copyUrl') {
      const fallback = this.pathService.normalizeRemoteName(remoteName);
      if (!fallback) return false;
      const feats = this.remoteManagement.getFeaturesSignal(fallback)();
      return feats.PublicLink || !!feats.loading;
    }
    // download fallback: must not be a local path
    return !this.pathService.isLocalPath(this.pathService.normalizeRemoteForRclone(remoteName));
  }

  async copyUrlSource(item: { srcFs?: string; name: string }, uniqueId: string): Promise<void> {
    await this.runCopyUrl(item, 'src', uniqueId);
  }

  async copyUrlDst(item: { dstFs?: string; name: string }, uniqueId: string): Promise<void> {
    await this.runCopyUrl(item, 'dst', uniqueId);
  }

  async copyUrlFallback(
    item: { name: string },
    uniqueId: string,
    remoteName: string
  ): Promise<void> {
    await this.runCopyUrl(item, 'fallback', uniqueId, remoteName);
  }

  async downloadSource(item: { srcFs?: string; name: string }, uniqueId: string): Promise<void> {
    await this.runDownload(item, 'src', uniqueId);
  }

  async downloadDst(item: { dstFs?: string; name: string }, uniqueId: string): Promise<void> {
    await this.runDownload(item, 'dst', uniqueId);
  }

  async downloadFallback(
    item: { name: string },
    uniqueId: string,
    remoteName: string
  ): Promise<void> {
    await this.runDownload(item, 'fallback', uniqueId, remoteName);
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

  // ---------------------------------------------------------------------------
  // Shared implementation
  // ---------------------------------------------------------------------------

  /** Resolves the rclone fs string for a given target. */
  private resolveFs(
    item: { srcFs?: string; dstFs?: string; name: string },
    target: TransferTarget,
    remoteName?: string
  ): string {
    if (target === 'src') return item.srcFs || '';
    if (target === 'dst') return item.dstFs || '';
    return this.pathService.normalizeRemoteForRclone(remoteName || '');
  }

  /** Shared copyUrl implementation — handles loading-id Set + error translation. */
  private async runCopyUrl(
    item: { srcFs?: string; dstFs?: string; name: string },
    target: TransferTarget,
    uniqueId: string,
    remoteName?: string
  ): Promise<void> {
    const key = `${uniqueId}-${target}`;
    this.loadingUrlIds.update(s => new Set(s).add(key));
    try {
      const fs = this.resolveFs(item, target, remoteName);
      const result = await this.remoteOps.getPublicLink(
        fs,
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

  /** Shared download implementation — handles loading-id Set + error translation. */
  private async runDownload(
    item: { srcFs?: string; dstFs?: string; name: string },
    target: TransferTarget,
    uniqueId: string,
    remoteName?: string
  ): Promise<void> {
    const key = `${uniqueId}-${target}`;
    this.downloadingIds.update(s => new Set(s).add(key));
    try {
      const fileRemote = this.resolveFs(item, target, remoteName);
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

  private async performDownload(fileRemote: string, path: string, fileName: string): Promise<void> {
    const isLocal = this.pathService.isLocalPath(fileRemote) || fileRemote === '/';
    await this.downloadService.download(fileRemote, path, fileName, isLocal);
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
