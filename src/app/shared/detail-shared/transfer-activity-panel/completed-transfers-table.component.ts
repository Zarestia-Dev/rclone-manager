import {
  Component,
  input,
  inject,
  ChangeDetectionStrategy,
  computed,
  signal,
  effect,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonModule } from '@angular/material/button';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FormatFileSizePipe } from '@app/pipes';
import { CompletedTransfer } from '@app/types';
import { toSignal } from '@angular/core/rxjs-interop';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { FileViewerService } from 'src/app/services/ui/file-viewer.service';
import { isHeadlessMode } from 'src/app/services/infrastructure/platform/api-client.service';

@Component({
  selector: 'app-completed-transfers-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, MatTooltipModule, MatButtonModule, TranslateModule, FormatFileSizePipe],
  template: `
    <div class="card-list-container" (scroll)="onScroll($event)">
      @if (transfers().length > 0) {
        @if (enrichedTransfers().length > 0) {
          @for (transfer of slicedTransfers(); track transfer.uniqueId) {
            <div class="card-row-item completed-item" [class]="transfer.status">
              <div class="card-header">
                <div class="card-info-left">
                  <mat-icon
                    svgIcon="file"
                    class="card-primary-icon file-icon"
                    [matTooltip]="transfer.name"
                  ></mat-icon>
                  <span class="card-title-text file-name" [title]="transfer.name">{{
                    transfer.name
                  }}</span>
                </div>
                <div class="card-info-right">
                  <div class="status-badge">
                    <span
                      class="app-pill"
                      [class]="transfer.badgeClass"
                      [matTooltip]="transfer.error"
                    >
                      <mat-icon [svgIcon]="transfer.badgeIcon"></mat-icon>
                      {{ transfer.badgeText | translate }}
                    </span>
                  </div>
                </div>
              </div>

              @if (transfer.srcFs || transfer.dstFs) {
                <div class="card-paths-v2">
                  <div class="path-group src">
                    <code class="path-pill src" [title]="transfer.srcFs">{{
                      transfer.srcFs || '?'
                    }}</code>
                    @if (transfer.status !== 'checked') {
                      <div class="path-actions">
                        @if (canCopyUrlSource(transfer)) {
                          <button
                            class="small-action-btn"
                            (click)="onCopyUrlSource(transfer); $event.stopPropagation()"
                            [disabled]="
                              loadingUrlIds().has(transfer.uniqueId + '-src') ||
                              isFeaturesLoading(transfer.srcFs)
                            "
                            [matTooltip]="'shared.transferActivity.actions.copyUrl' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                loadingUrlIds().has(transfer.uniqueId + '-src') ||
                                isFeaturesLoading(transfer.srcFs)
                                  ? 'refresh'
                                  : 'link'
                              "
                              [class.animate-spin]="
                                loadingUrlIds().has(transfer.uniqueId + '-src') ||
                                isFeaturesLoading(transfer.srcFs)
                              "
                            ></mat-icon>
                          </button>
                        }
                        @if (canDownloadSource(transfer)) {
                          <button
                            class="small-action-btn"
                            (click)="onDownloadSource(transfer); $event.stopPropagation()"
                            [disabled]="downloadingIds().has(transfer.uniqueId + '-src')"
                            [matTooltip]="'shared.transferActivity.actions.download' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                downloadingIds().has(transfer.uniqueId + '-src')
                                  ? 'refresh'
                                  : 'download'
                              "
                              [class.animate-spin]="
                                downloadingIds().has(transfer.uniqueId + '-src')
                              "
                            ></mat-icon>
                          </button>
                        }
                        @if (canDeleteSource(transfer)) {
                          <button
                            class="small-action-btn delete-btn"
                            (click)="onDeleteSource(transfer); $event.stopPropagation()"
                            [disabled]="deletingIds().has(transfer.uniqueId + '-src-del')"
                            [matTooltip]="'common.delete' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                deletingIds().has(transfer.uniqueId + '-src-del')
                                  ? 'refresh'
                                  : 'trash'
                              "
                              [class.animate-spin]="
                                deletingIds().has(transfer.uniqueId + '-src-del')
                              "
                            ></mat-icon>
                          </button>
                        }
                      </div>
                    }
                  </div>

                  <mat-icon svgIcon="right-arrow" class="arrow-icon"></mat-icon>

                  <div class="path-group dst">
                    <code class="path-pill dst" [title]="transfer.dstFs">{{
                      transfer.dstFs || '?'
                    }}</code>
                    @if (transfer.status !== 'checked') {
                      <div class="path-actions">
                        @if (canCopyUrlDst(transfer)) {
                          <button
                            class="small-action-btn"
                            (click)="onCopyUrlDst(transfer); $event.stopPropagation()"
                            [disabled]="
                              loadingUrlIds().has(transfer.uniqueId + '-dst') ||
                              isFeaturesLoading(transfer.dstFs)
                            "
                            [matTooltip]="'shared.transferActivity.actions.copyUrl' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                loadingUrlIds().has(transfer.uniqueId + '-dst') ||
                                isFeaturesLoading(transfer.dstFs)
                                  ? 'refresh'
                                  : 'link'
                              "
                              [class.animate-spin]="
                                loadingUrlIds().has(transfer.uniqueId + '-dst') ||
                                isFeaturesLoading(transfer.dstFs)
                              "
                            ></mat-icon>
                          </button>
                        }
                        @if (canDownloadDst(transfer)) {
                          <button
                            class="small-action-btn"
                            (click)="onDownloadDst(transfer); $event.stopPropagation()"
                            [disabled]="downloadingIds().has(transfer.uniqueId + '-dst')"
                            [matTooltip]="'shared.transferActivity.actions.download' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                downloadingIds().has(transfer.uniqueId + '-dst')
                                  ? 'refresh'
                                  : 'download'
                              "
                              [class.animate-spin]="
                                downloadingIds().has(transfer.uniqueId + '-dst')
                              "
                            ></mat-icon>
                          </button>
                        }
                        @if (canDeleteDst(transfer)) {
                          <button
                            class="small-action-btn delete-btn"
                            (click)="onDeleteDst(transfer); $event.stopPropagation()"
                            [disabled]="deletingIds().has(transfer.uniqueId + '-dst-del')"
                            [matTooltip]="'common.delete' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                deletingIds().has(transfer.uniqueId + '-dst-del')
                                  ? 'refresh'
                                  : 'trash'
                              "
                              [class.animate-spin]="
                                deletingIds().has(transfer.uniqueId + '-dst-del')
                              "
                            ></mat-icon>
                          </button>
                        }
                      </div>
                    }
                  </div>
                </div>
              } @else if (remoteName() && transfer.status !== 'checked') {
                <div class="card-paths-v2">
                  <div class="path-group dst">
                    <code class="path-pill dst" [title]="remoteName()">{{ remoteName() }}</code>
                    <div class="path-actions">
                      @if (canCopyUrlFallback(transfer)) {
                        <button
                          class="small-action-btn"
                          (click)="onCopyUrlFallback(transfer); $event.stopPropagation()"
                          [disabled]="
                            loadingUrlIds().has(transfer.uniqueId + '-fallback') ||
                            isFallbackFeaturesLoading()
                          "
                          [matTooltip]="'shared.transferActivity.actions.copyUrl' | translate"
                        >
                          <mat-icon
                            [svgIcon]="
                              loadingUrlIds().has(transfer.uniqueId + '-fallback') ||
                              isFallbackFeaturesLoading()
                                ? 'refresh'
                                : 'link'
                            "
                            [class.animate-spin]="
                              loadingUrlIds().has(transfer.uniqueId + '-fallback') ||
                              isFallbackFeaturesLoading()
                            "
                          ></mat-icon>
                        </button>
                      }
                      @if (canDownloadFallback(transfer)) {
                        <button
                          class="small-action-btn"
                          (click)="onDownloadFallback(transfer); $event.stopPropagation()"
                          [disabled]="downloadingIds().has(transfer.uniqueId + '-fallback')"
                          [matTooltip]="'shared.transferActivity.actions.download' | translate"
                        >
                          <mat-icon
                            [svgIcon]="
                              downloadingIds().has(transfer.uniqueId + '-fallback')
                                ? 'refresh'
                                : 'download'
                            "
                            [class.animate-spin]="
                              downloadingIds().has(transfer.uniqueId + '-fallback')
                            "
                          ></mat-icon>
                        </button>
                      }
                      @if (canDeleteFallback(transfer)) {
                        <button
                          class="small-action-btn delete-btn"
                          (click)="onDeleteFallback(transfer); $event.stopPropagation()"
                          [disabled]="deletingIds().has(transfer.uniqueId + '-fallback-del')"
                          [matTooltip]="'common.delete' | translate"
                        >
                          <mat-icon
                            [svgIcon]="
                              deletingIds().has(transfer.uniqueId + '-fallback-del')
                                ? 'refresh'
                                : 'trash'
                            "
                            [class.animate-spin]="
                              deletingIds().has(transfer.uniqueId + '-fallback-del')
                            "
                          ></mat-icon>
                        </button>
                      }
                    </div>
                  </div>
                </div>
              }

              <div class="card-footer">
                <div class="card-footer-left">
                  <span class="size-text">
                    {{ transfer.size | formatFileSize }}
                    @if (transfer.bytes !== transfer.size && transfer.bytes > 0) {
                      <span class="size-transferred">
                        ({{
                          'shared.transferActivity.table.transferred'
                            | translate: { bytes: (transfer.bytes | formatFileSize) }
                        }})
                      </span>
                    }
                    @if (transfer.status === 'checked' && transfer.size > 0) {
                      <span class="size-transferred">
                        ({{ 'shared.transferActivity.table.alreadyExisted' | translate }})
                      </span>
                    }
                  </span>
                </div>
                <div class="card-footer-right">
                  @if (transfer.completedAt) {
                    <span class="time-text">{{ transfer.relativeTime }}</span>
                  }
                  @if (transfer.duration) {
                    <span class="duration-badge">{{ transfer.duration }}</span>
                  }
                </div>
              </div>
            </div>
          }
          @if (enrichedTransfers().length > displayLimit()) {
            <div class="infinite-scroll-loader">
              <mat-icon svgIcon="refresh" class="animate-spin"></mat-icon>
              <span>{{ 'common.loading' | translate }}</span>
            </div>
          }
        } @else {
          <div class="empty-state">
            <mat-icon svgIcon="search"></mat-icon>
            <span>{{ 'shared.search.title' | translate }}</span>
            <p>{{ 'shared.search.description' | translate }}</p>
          </div>
        }
      } @else {
        <div class="empty-state">
          <mat-icon svgIcon="circle-check"></mat-icon>
          <span>{{
            (jobType() === 'check'
              ? 'shared.transferActivity.empty.noRecentCheck'
              : 'shared.transferActivity.empty.noRecent'
            ) | translate
          }}</span>
          <p>
            {{
              (jobType() === 'check'
                ? 'shared.transferActivity.empty.recentHintCheck'
                : 'shared.transferActivity.empty.recentHint'
              ) | translate
            }}
          </p>
        </div>
      }
    </div>
  `,
})
export class CompletedTransfersTableComponent {
  readonly transfers = input.required<CompletedTransfer[]>();
  readonly jobType = input<string>('sync');
  readonly remoteName = input<string>('');
  readonly searchTerm = input('');

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
  readonly hiddenIds = signal<Set<string>>(new Set());
  readonly displayLimit = signal(50);

  // Automatically reset limit when input data or search term changes
  private readonly _resetLimitEffect = effect(
    () => {
      this.transfers();
      this.searchTerm();
      this.displayLimit.set(50);
    },
    { allowSignalWrites: true }
  );

  protected readonly slicedTransfers = computed(() => {
    return this.enrichedTransfers().slice(0, this.displayLimit());
  });

  private readonly lang = toSignal(this.translate.onLangChange, { initialValue: null });

  constructor() {
    effect(() => {
      const items = this.transfers();
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
    });
  }

  private getRemoteName(fs: string): string {
    if (!fs || this.pathService.isLocalPath(fs)) return '';
    const parts = fs.split(':');
    if (parts.length > 1) {
      const name = parts[0];
      if (name === 'http' || name === 'https' || name === 'ftp') return '';
      return name;
    }
    return '';
  }

  protected readonly enrichedTransfers = computed(() => {
    this.lang();
    const hidden = this.hiddenIds();
    const search = this.searchTerm().toLowerCase().trim();

    let items = this.transfers();
    if (search) {
      items = items.filter(t => t.name.toLowerCase().includes(search));
    }

    return items
      .map(transfer => {
        let badgeClass = 'p-primary';
        let badgeIcon = 'circle-check';
        let badgeText = 'shared.transferActivity.status.completed';

        switch (transfer.status) {
          case 'failed':
            badgeClass = 'p-warn';
            badgeIcon = 'circle-exclamation';
            badgeText = 'shared.transferActivity.status.failed';
            break;
          case 'checked':
            badgeClass = 'p-accent';
            badgeIcon = 'circle-check';
            badgeText = 'shared.transferActivity.status.checked';
            break;
          case 'partial':
            badgeClass = 'p-orange';
            badgeIcon = 'circle-exclamation';
            badgeText = 'shared.transferActivity.status.partial';
            break;
        }

        return {
          ...transfer,
          relativeTime: transfer.completedAt ? this.getRelativeTime(transfer.completedAt) : '',
          duration:
            transfer.startedAt && transfer.completedAt && transfer.status === 'completed'
              ? this.getDuration(transfer.startedAt, transfer.completedAt)
              : '',
          badgeClass,
          badgeIcon,
          badgeText,
          uniqueId: `${transfer.jobid}-${transfer.name}`,
        };
      })
      .filter(t => !hidden.has(t.uniqueId));
  });

  isFeaturesLoading(fs: string | undefined): boolean {
    const remote = this.getRemoteName(fs || '');
    if (!remote) return false;
    return !!this.remoteManagement.getFeaturesSignal(remote)().loading;
  }

  isFallbackFeaturesLoading(): boolean {
    const fallback = this.pathService.normalizeRemoteName(this.remoteName());
    if (!fallback) return false;
    return !!this.remoteManagement.getFeaturesSignal(fallback)().loading;
  }

  canCopyUrlSource(item: CompletedTransfer): boolean {
    if (item.status === 'missing_src') return false;

    const isMove = this.jobType() === 'move' || item.group?.split('/')[0]?.toLowerCase() === 'move';
    const isDelete =
      ['delete', 'cleanup', 'rmdirs'].includes(this.jobType()) ||
      ['delete', 'cleanup', 'rmdirs'].includes(item.group?.split('/')[0]?.toLowerCase() || '');
    if ((isMove || isDelete) && item.status !== 'failed') {
      return false;
    }

    const srcRemote = this.getRemoteName(item.srcFs || '');
    if (!srcRemote) return false;
    const feats = this.remoteManagement.getFeaturesSignal(srcRemote)();
    return feats.PublicLink || !!feats.loading;
  }

  canCopyUrlDst(item: CompletedTransfer): boolean {
    if (item.status === 'failed' || item.status === 'missing_dst') return false;

    const isDelete =
      ['delete', 'cleanup', 'rmdirs'].includes(this.jobType()) ||
      ['delete', 'cleanup', 'rmdirs'].includes(item.group?.split('/')[0]?.toLowerCase() || '');
    if (isDelete) return false;

    const dstRemote = this.getRemoteName(item.dstFs || '');
    if (!dstRemote) return false;
    const feats = this.remoteManagement.getFeaturesSignal(dstRemote)();
    return feats.PublicLink || !!feats.loading;
  }

  canCopyUrlFallback(item: CompletedTransfer): boolean {
    if (item.status === 'failed' || !this.remoteName()) return false;
    const isDelete =
      ['delete', 'cleanup', 'rmdirs'].includes(this.jobType()) ||
      ['delete', 'cleanup', 'rmdirs'].includes(item.group?.split('/')[0]?.toLowerCase() || '');
    if (isDelete) return false;

    const fallback = this.pathService.normalizeRemoteName(this.remoteName());
    if (!fallback) return false;
    const feats = this.remoteManagement.getFeaturesSignal(fallback)();
    return feats.PublicLink || !!feats.loading;
  }

  canDownloadSource(item: CompletedTransfer): boolean {
    if (item.status === 'missing_src') return false;

    const isMove = this.jobType() === 'move' || item.group?.split('/')[0]?.toLowerCase() === 'move';
    const isDelete =
      ['delete', 'cleanup', 'rmdirs'].includes(this.jobType()) ||
      ['delete', 'cleanup', 'rmdirs'].includes(item.group?.split('/')[0]?.toLowerCase() || '');
    if ((isMove || isDelete) && item.status !== 'failed') {
      return false;
    }

    const srcRemote = this.getRemoteName(item.srcFs || '');
    return !!srcRemote;
  }

  canDownloadDst(item: CompletedTransfer): boolean {
    if (item.status === 'failed' || item.status === 'missing_dst') return false;

    const isDelete =
      ['delete', 'cleanup', 'rmdirs'].includes(this.jobType()) ||
      ['delete', 'cleanup', 'rmdirs'].includes(item.group?.split('/')[0]?.toLowerCase() || '');
    if (isDelete) return false;

    const dstRemote = this.getRemoteName(item.dstFs || '');
    return !!dstRemote;
  }

  canDownloadFallback(item: CompletedTransfer): boolean {
    if (item.status === 'failed' || !this.remoteName()) return false;
    const isDelete =
      ['delete', 'cleanup', 'rmdirs'].includes(this.jobType()) ||
      ['delete', 'cleanup', 'rmdirs'].includes(item.group?.split('/')[0]?.toLowerCase() || '');
    if (isDelete) return false;

    const fallback = this.pathService.normalizeRemoteForRclone(this.remoteName());
    return !this.pathService.isLocalPath(fallback);
  }

  canDeleteSource(item: CompletedTransfer): boolean {
    return this.canDownloadSource(item);
  }

  canDeleteDst(item: CompletedTransfer): boolean {
    return this.canDownloadDst(item);
  }

  canDeleteFallback(item: CompletedTransfer): boolean {
    return this.canDownloadFallback(item);
  }

  async onCopyUrlSource(item: CompletedTransfer): Promise<void> {
    const uniqueId = `${item.uniqueId || `${item.jobid}-${item.name}`}-src`;
    this.loadingUrlIds.update(s => new Set(s).add(uniqueId));

    try {
      const result = await this.remoteOps.getPublicLink(
        item.srcFs || '',
        item.name,
        false,
        undefined,
        'dashboard'
      );

      if (result && result.url) {
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
        next.delete(uniqueId);
        return next;
      });
    }
  }

  async onCopyUrlDst(item: CompletedTransfer): Promise<void> {
    const uniqueId = `${item.uniqueId || `${item.jobid}-${item.name}`}-dst`;
    this.loadingUrlIds.update(s => new Set(s).add(uniqueId));

    try {
      const result = await this.remoteOps.getPublicLink(
        item.dstFs || '',
        item.name,
        false,
        undefined,
        'dashboard'
      );

      if (result && result.url) {
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
        next.delete(uniqueId);
        return next;
      });
    }
  }

  async onCopyUrlFallback(item: CompletedTransfer): Promise<void> {
    const uniqueId = `${item.uniqueId || `${item.jobid}-${item.name}`}-fallback`;
    this.loadingUrlIds.update(s => new Set(s).add(uniqueId));

    try {
      const fallback = this.pathService.normalizeRemoteForRclone(this.remoteName());
      const result = await this.remoteOps.getPublicLink(
        fallback,
        item.name,
        false,
        undefined,
        'dashboard'
      );

      if (result && result.url) {
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
        next.delete(uniqueId);
        return next;
      });
    }
  }

  async onDownloadSource(item: CompletedTransfer): Promise<void> {
    const uniqueId = `${item.uniqueId || `${item.jobid}-${item.name}`}-src`;
    this.downloadingIds.update(s => new Set(s).add(uniqueId));

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
        next.delete(uniqueId);
        return next;
      });
    }
  }

  async onDownloadDst(item: CompletedTransfer): Promise<void> {
    const uniqueId = `${item.uniqueId || `${item.jobid}-${item.name}`}-dst`;
    this.downloadingIds.update(s => new Set(s).add(uniqueId));

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
        next.delete(uniqueId);
        return next;
      });
    }
  }

  async onDownloadFallback(item: CompletedTransfer): Promise<void> {
    const uniqueId = `${item.uniqueId || `${item.jobid}-${item.name}`}-fallback`;
    this.downloadingIds.update(s => new Set(s).add(uniqueId));

    try {
      const fallback = this.pathService.normalizeRemoteForRclone(this.remoteName());
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
        next.delete(uniqueId);
        return next;
      });
    }
  }

  private async performDownload(fileRemote: string, path: string, fileName: string): Promise<void> {
    if (isHeadlessMode()) {
      const isLocal = this.pathService.isLocalPath(fileRemote) || fileRemote === '/';
      const rawUrl = await this.fileViewerService.generateUrl(
        { Path: path, Name: fileName } as any,
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

  private getRelativeTime(timestamp: string): string {
    const diff = Date.now() - Date.parse(timestamp);
    const minutes = Math.floor(diff / 60000);
    if (minutes <= 0) return this.translate.instant('shared.transferActivity.time.justNow');
    const hours = Math.floor(minutes / 60);
    if (hours <= 0)
      return this.translate.instant('shared.transferActivity.time.minutesAgo', { count: minutes });
    const days = Math.floor(hours / 24);
    if (days <= 0)
      return this.translate.instant('shared.transferActivity.time.hoursAgo', { count: hours });
    return this.translate.instant('shared.transferActivity.time.daysAgo', { count: days });
  }

  private getDuration(startedAt: string, completedAt: string): string {
    const diff = Date.parse(completedAt) - Date.parse(startedAt);
    if (diff < 1000)
      return this.translate.instant('shared.transferActivity.time.duration.lessThanSecond');

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    if (minutes <= 0)
      return this.translate.instant('shared.transferActivity.time.duration.seconds', { seconds });
    const hours = Math.floor(minutes / 60);
    if (hours <= 0)
      return this.translate.instant('shared.transferActivity.time.duration.minutes', {
        minutes,
        seconds: seconds % 60,
      });
    return this.translate.instant('shared.transferActivity.time.duration.hours', {
      hours,
      minutes: minutes % 60,
    });
  }

  async onDeleteSource(item: CompletedTransfer): Promise<void> {
    const uniqueId = `${item.uniqueId || `${item.jobid}-${item.name}`}-src-del`;
    const remote = item.srcFs || '';
    if (!remote) return;
    await this.confirmAndDelete(item, remote, uniqueId);
  }

  async onDeleteDst(item: CompletedTransfer): Promise<void> {
    const uniqueId = `${item.uniqueId || `${item.jobid}-${item.name}`}-dst-del`;
    const remote = item.dstFs || '';
    if (!remote) return;
    await this.confirmAndDelete(item, remote, uniqueId);
  }

  async onDeleteFallback(item: CompletedTransfer): Promise<void> {
    const uniqueId = `${item.uniqueId || `${item.jobid}-${item.name}`}-fallback-del`;
    const remote = this.pathService.normalizeRemoteForRclone(this.remoteName());
    await this.confirmAndDelete(item, remote, uniqueId);
  }

  private async confirmAndDelete(
    item: CompletedTransfer,
    remote: string,
    uniqueId: string
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

    this.deletingIds.update(s => new Set(s).add(uniqueId));
    try {
      await this.remoteOps.deleteItems([{ remote, path: item.name, isDir: false }], 'dashboard');
      this.notifications.showSuccess(
        this.translate.instant('nautilus.notifications.deleteStarted', { count: 1 })
      );
      this.hiddenIds.update(s => new Set(s).add(item.uniqueId || `${item.jobid}-${item.name}`));
    } catch (e) {
      console.error('Delete failed:', e);
      this.notifications.showError(
        this.translate.instant('nautilus.errors.deleteFailed', { count: 1, total: 1 })
      );
    } finally {
      this.deletingIds.update(s => {
        const next = new Set(s);
        next.delete(uniqueId);
        return next;
      });
    }
  }

  onScroll(event: Event): void {
    const target = event.target as HTMLElement;
    if (!target) return;

    const threshold = 150;
    const position = target.scrollTop + target.clientHeight;
    const max = target.scrollHeight;

    if (max - position < threshold) {
      const currentLimit = this.displayLimit();
      const totalCount = this.enrichedTransfers().length;
      if (currentLimit < totalCount) {
        this.displayLimit.set(Math.min(currentLimit + 50, totalCount));
      }
    }
  }
}
