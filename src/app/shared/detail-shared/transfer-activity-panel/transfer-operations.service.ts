import * as pathUtils from 'src/app/shared/utils/path.utils';
import { Clipboard } from '@angular/cdk/clipboard';
import { inject, Injectable, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import {
  JOB_STATUS,
  RCLONE_ACTIVITY,
  TRANSFER_STATUS,
  CompletedTransfer,
  JobActionType,
  RemoteFeatures,
} from '@app/types';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { DownloadService } from 'src/app/services/operations/download.service';
import { ActivityActionItem, ActivityTarget, isDeleteActivity } from './activity.utils';

type ActivityFileAction = 'link' | 'download' | 'delete';

@Injectable()
export class TransferOperationsService {
  private readonly translate = inject(TranslateService);
  private readonly clipboard = inject(Clipboard);
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly remoteManagement = inject(RemoteManagementService);
  private readonly notifications = inject(NotificationService);
  private readonly pathService = inject(PathService);
  private readonly downloadService = inject(DownloadService);

  private readonly _pendingActions = signal<ReadonlyMap<string, ActivityFileAction>>(new Map());
  readonly pendingActions = this._pendingActions.asReadonly();

  private getRemoteName(fs: string): string {
    if (!fs || this.pathService.isLocalPath(fs)) return '';
    const idx = fs.indexOf(':');
    if (idx <= 0 || fs.includes('://')) return '';
    return fs.substring(0, idx);
  }

  getFs(item: ActivityActionItem, target: ActivityTarget): string {
    return (target === 'src' ? item.srcFs : item.dstFs) || '';
  }

  canAccess(item: ActivityActionItem, target: ActivityTarget, jobType: JobActionType): boolean {
    if (!this.getRemoteName(this.getFs(item, target))) return false;
    if (item.resolveState?.status === JOB_STATUS.Running) return false;
    if (isDeleteActivity(item, jobType)) return false;
    const repaired = item.resolveState?.status === JOB_STATUS.Completed;
    if (target === 'src') {
      if (item.status === TRANSFER_STATUS.MissingSource && !repaired) return false;
      // A skipped check did not remove the source of a move operation.
      if (item.status === TRANSFER_STATUS.Checked) return true;
      const moving =
        jobType === 'move' ||
        item.what === RCLONE_ACTIVITY.Moving ||
        item.what === RCLONE_ACTIVITY.Renaming;
      return !moving || item.status === TRANSFER_STATUS.Failed;
    }
    return (
      repaired ||
      (!!item.status &&
        item.status !== TRANSFER_STATUS.Failed &&
        item.status !== TRANSFER_STATUS.MissingDestination)
    );
  }

  getLinkFeatures(fs: string): RemoteFeatures | undefined {
    const remote = this.getRemoteName(fs);
    return remote ? this.remoteManagement.getFeaturesSignal(remote)() : undefined;
  }

  copyFile(item: CompletedTransfer, reverse = false): Promise<string> {
    const source = (reverse ? item.dstFs : item.srcFs) || '';
    const destination = (reverse ? item.srcFs : item.dstFs) || '';
    return this.remoteOps.transferItems(
      [
        {
          remote: source,
          path: item.name,
          name: pathUtils.extractName(item.name),
          isDir: false,
        },
      ],
      destination,
      this.pathService.getParentPath(item.name),
      'copy',
      'dashboard',
      undefined,
      item.jobid
    );
  }

  private beginAction(key: string, action: ActivityFileAction): boolean {
    if (this.pendingActions().has(key)) return false;
    this._pendingActions.update(actions => new Map(actions).set(key, action));
    return true;
  }

  private endAction(key: string): void {
    this._pendingActions.update(actions => {
      const next = new Map(actions);
      next.delete(key);
      return next;
    });
  }

  async copyUrl(item: ActivityActionItem, target: ActivityTarget, key: string): Promise<void> {
    const fs = this.getFs(item, target);
    if (!fs || !this.beginAction(key, 'link')) return;
    try {
      const result = await this.remoteOps.getPublicLink(
        fs,
        item.name,
        false,
        undefined,
        'dashboard'
      );
      if (!result?.url)
        throw new Error(this.translate.instant('shared.transferActivity.actions.failCopyUrl'));
      if (!this.clipboard.copy(result.url))
        throw new Error(this.translate.instant('common.copyFailed'));
      this.notifications.showSuccess(
        this.translate.instant('shared.transferActivity.actions.successCopyUrl')
      );
    } catch (error) {
      this.notifications.showError(
        this.translate.instant('shared.transferActivity.actions.failCopyUrl') + ': ' + String(error)
      );
    } finally {
      this.endAction(key);
    }
  }

  async download(item: ActivityActionItem, target: ActivityTarget, key: string): Promise<void> {
    const fs = this.getFs(item, target);
    if (!fs || !this.beginAction(key, 'download')) return;
    try {
      await this.downloadService.download(fs, item.name, pathUtils.extractName(item.name), false);
    } catch (error) {
      this.notifications.showError(
        this.translate.instant('shared.transferActivity.actions.failDownload') +
          ': ' +
          String(error)
      );
    } finally {
      this.endAction(key);
    }
  }

  async deleteFile(item: ActivityActionItem, target: ActivityTarget, key: string): Promise<void> {
    const fs = this.getFs(item, target);
    if (!fs || !this.beginAction(key, 'delete')) return;
    try {
      const confirmed = await this.notifications.confirmModal(
        this.translate.instant('nautilus.modals.delete.title'),
        this.translate.instant('nautilus.modals.delete.messageSingle', {
          name: pathUtils.extractName(item.name),
        }),
        'common.delete',
        'common.cancel',
        { icon: 'trash', color: 'warn' }
      );
      if (!confirmed) return;
      await this.remoteOps.deleteItems(
        [{ remote: fs, path: item.name, isDir: false }],
        'dashboard'
      );
      this.notifications.showSuccess(
        this.translate.instant('nautilus.notifications.deleteStarted', { count: 1 })
      );
      // Enqueuing a delete is not confirmation that the file was removed.
      // Keep the original activity record; the delete has its own job outcome.
    } catch (error) {
      this.notifications.showError(
        this.translate.instant('nautilus.errors.deleteFailed', { count: 1, total: 1 }) +
          ': ' +
          String(error)
      );
    } finally {
      this.endAction(key);
    }
  }
}
