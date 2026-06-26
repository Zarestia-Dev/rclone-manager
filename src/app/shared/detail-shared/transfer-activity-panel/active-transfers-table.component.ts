import {
  Component,
  input,
  inject,
  ChangeDetectionStrategy,
  computed,
  signal,
  effect,
} from '@angular/core';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { FormatFileSizePipe, FormatTimePipe } from '@app/pipes';
import { TransferFile } from '@app/types';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { FileViewerService } from 'src/app/services/ui/file-viewer.service';
import { isHeadlessMode } from 'src/app/services/infrastructure/platform/api-client.service';

@Component({
  selector: 'app-active-transfers-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatProgressBarModule,
    MatIconModule,
    MatTooltipModule,
    MatButtonModule,
    TranslatePipe,
    FormatFileSizePipe,
    FormatTimePipe,
  ],
  template: `
    <div class="card-list-container">
      @if (transfers().length > 0) {
        @if (enrichedTransfers().length > 0) {
          @for (transfer of enrichedTransfers(); track transfer.name) {
            <div class="card-row-item">
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
                  @if (transfer.isError) {
                    <mat-icon
                      svgIcon="circle-exclamation"
                      class="error-badge-icon warn"
                      [matTooltip]="
                        transfer.error ||
                        ('shared.transferActivity.status.transferError' | translate)
                      "
                    ></mat-icon>
                  }
                  @if (transfer.isCompleted) {
                    <mat-icon
                      svgIcon="circle-check"
                      class="success-badge-icon primary"
                      [matTooltip]="'shared.transferActivity.status.transferCompleted' | translate"
                    ></mat-icon>
                  }
                </div>
                <div class="card-info-right progress-badge">
                  @if (transfer.isPreparing) {
                    <span class="percentage-text preparing">{{
                      'shared.transferActivity.status.preparing' | translate
                    }}</span>
                  } @else if (transfer.percentage === 100) {
                    <span class="percentage-text finalizing">{{
                      'shared.transferActivity.status.finalizing' | translate
                    }}</span>
                  } @else {
                    <span class="percentage-text">{{ transfer.percentage }}%</span>
                  }
                </div>
              </div>

              @if (transfer.srcFs || transfer.dstFs) {
                <div class="card-paths-v2">
                  <div class="path-group src">
                    <code class="path-pill src" [title]="transfer.srcFs">{{
                      transfer.srcFs || '?'
                    }}</code>
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
                            [class.animate-spin]="downloadingIds().has(transfer.uniqueId + '-src')"
                          ></mat-icon>
                        </button>
                      }
                    </div>
                  </div>

                  <mat-icon svgIcon="right-arrow" class="arrow-icon"></mat-icon>

                  <div class="path-group dst">
                    <code class="path-pill dst" [title]="transfer.dstFs">{{
                      transfer.dstFs || '?'
                    }}</code>
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
                            [class.animate-spin]="downloadingIds().has(transfer.uniqueId + '-dst')"
                          ></mat-icon>
                        </button>
                      }
                    </div>
                  </div>
                </div>
              } @else if (remoteName()) {
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
                    </div>
                  </div>
                </div>
              }

              <div class="card-progress">
                <mat-progress-bar
                  [mode]="transfer.isPreparing ? 'indeterminate' : 'determinate'"
                  [value]="transfer.isPreparing ? 0 : transfer.percentage"
                ></mat-progress-bar>
              </div>

              <div class="card-footer">
                <div class="card-footer-left">
                  <span class="size-text">
                    {{ transfer.bytes | formatFileSize }} / {{ transfer.size | formatFileSize }}
                  </span>
                </div>
                <div class="card-footer-right">
                  @if (transfer.speed > 0) {
                    <span class="speed-text">
                      <span class="speed-dot" [class]="transfer.speedClass"></span>
                      {{ transfer.speed | formatFileSize }}/s
                    </span>
                  }
                  @if (transfer.eta > 0 && !transfer.isCompleted) {
                    <span class="eta-text">{{ transfer.eta | formatTime }}</span>
                  }
                </div>
              </div>
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
          <mat-icon svgIcon="download"></mat-icon>
          <span>{{ 'shared.transferActivity.empty.noActive' | translate }}</span>
          <p>{{ 'shared.transferActivity.empty.activeHint' | translate }}</p>
        </div>
      }
    </div>
  `,
})
export class ActiveTransfersTableComponent {
  readonly transfers = input.required<TransferFile[]>();
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
    const search = this.searchTerm().toLowerCase().trim();
    let items = this.transfers();
    if (search) {
      items = items.filter(t => t.name.toLowerCase().includes(search));
    }

    return items.map(transfer => ({
      ...transfer,
      isPreparing: transfer.percentage == null || isNaN(transfer.percentage),
      speedClass:
        transfer.speed > 10485760
          ? 'speed-fast'
          : transfer.speed > 1048576
            ? 'speed-medium'
            : 'speed-slow',
      uniqueId: `${transfer.group || ''}-${transfer.name}`,
    }));
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

  canCopyUrlSource(item: TransferFile): boolean {
    const isMove = this.jobType() === 'move' || item.group?.split('/')[0]?.toLowerCase() === 'move';
    const isDelete =
      ['delete', 'cleanup', 'rmdirs'].includes(this.jobType()) ||
      ['delete', 'cleanup', 'rmdirs'].includes(item.group?.split('/')[0]?.toLowerCase() || '');
    if (isMove || isDelete) {
      return false;
    }

    const srcRemote = this.getRemoteName(item.srcFs || '');
    if (!srcRemote) return false;
    const feats = this.remoteManagement.getFeaturesSignal(srcRemote)();
    return feats.PublicLink || !!feats.loading;
  }

  canCopyUrlDst(item: TransferFile): boolean {
    const isDelete =
      ['delete', 'cleanup', 'rmdirs'].includes(this.jobType()) ||
      ['delete', 'cleanup', 'rmdirs'].includes(item.group?.split('/')[0]?.toLowerCase() || '');
    if (isDelete) return false;

    const dstRemote = this.getRemoteName(item.dstFs || '');
    if (!dstRemote) return false;
    const feats = this.remoteManagement.getFeaturesSignal(dstRemote)();
    return feats.PublicLink || !!feats.loading;
  }

  canCopyUrlFallback(item: TransferFile): boolean {
    if (!this.remoteName()) return false;
    const isDelete =
      ['delete', 'cleanup', 'rmdirs'].includes(this.jobType()) ||
      ['delete', 'cleanup', 'rmdirs'].includes(item.group?.split('/')[0]?.toLowerCase() || '');
    if (isDelete) return false;

    const fallback = this.pathService.normalizeRemoteName(this.remoteName());
    if (!fallback) return false;
    const feats = this.remoteManagement.getFeaturesSignal(fallback)();
    return feats.PublicLink || !!feats.loading;
  }

  canDownloadSource(item: TransferFile): boolean {
    const isMove = this.jobType() === 'move' || item.group?.split('/')[0]?.toLowerCase() === 'move';
    const isDelete =
      ['delete', 'cleanup', 'rmdirs'].includes(this.jobType()) ||
      ['delete', 'cleanup', 'rmdirs'].includes(item.group?.split('/')[0]?.toLowerCase() || '');
    if (isMove || isDelete) {
      return false;
    }

    const srcRemote = this.getRemoteName(item.srcFs || '');
    return !!srcRemote;
  }

  canDownloadDst(item: TransferFile): boolean {
    const isDelete =
      ['delete', 'cleanup', 'rmdirs'].includes(this.jobType()) ||
      ['delete', 'cleanup', 'rmdirs'].includes(item.group?.split('/')[0]?.toLowerCase() || '');
    if (isDelete) return false;

    const dstRemote = this.getRemoteName(item.dstFs || '');
    return !!dstRemote;
  }

  canDownloadFallback(item: TransferFile): boolean {
    if (!this.remoteName()) return false;
    const isDelete =
      ['delete', 'cleanup', 'rmdirs'].includes(this.jobType()) ||
      ['delete', 'cleanup', 'rmdirs'].includes(item.group?.split('/')[0]?.toLowerCase() || '');
    if (isDelete) return false;

    const fallback = this.pathService.normalizeRemoteForRclone(this.remoteName());
    return !this.pathService.isLocalPath(fallback);
  }

  async onCopyUrlSource(item: any): Promise<void> {
    const uniqueId = `${item.uniqueId}-src`;
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

  async onCopyUrlDst(item: any): Promise<void> {
    const uniqueId = `${item.uniqueId}-dst`;
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

  async onCopyUrlFallback(item: any): Promise<void> {
    const uniqueId = `${item.uniqueId}-fallback`;
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

  async onDownloadSource(item: any): Promise<void> {
    const uniqueId = `${item.uniqueId}-src`;
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

  async onDownloadDst(item: any): Promise<void> {
    const uniqueId = `${item.uniqueId}-dst`;
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

  async onDownloadFallback(item: any): Promise<void> {
    const uniqueId = `${item.uniqueId}-fallback`;
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
}
