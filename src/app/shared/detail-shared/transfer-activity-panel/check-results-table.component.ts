import { Component, input, inject, ChangeDetectionStrategy, computed, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TranslatePipe } from '@ngx-translate/core';
import { CompletedTransfer, TransferActivityPanelConfig } from '@app/types';
import { FormatFileSizePipe, FormatTimePipe } from '@app/pipes';
import { CopyToClipboardDirective } from '../../directives/copy-to-clipboard.directive';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { TransferOperationsService } from './transfer-operations.service';
import { BaseTransfersTableComponent } from './base-transfers-table.component';

export interface EnrichedCheckResult extends CompletedTransfer {
  uniqueId: string;
  badgeClass: string;
  badgeIcon: string;
  badgeText: string;
  relativeTime: string;
  rowClass: string;
  resolveIcon: string;
  resolveTooltip: string;
  resolvePercentage: number;
  resolveIsPreparing: boolean;
  resolveBytes: number;
  resolveSize: number;
  resolveSpeed: number;
  resolveSpeedClass: string;
  resolveEta: number;
  resolveError?: string;
  resolveStatus?: string;
}

@Component({
  selector: 'app-check-results-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [TransferOperationsService],
  imports: [
    MatIconModule,
    MatTooltipModule,
    MatButtonModule,
    MatProgressBarModule,
    TranslatePipe,
    CopyToClipboardDirective,
    FormatFileSizePipe,
    FormatTimePipe,
  ],
  template: `
    <div class="card-list-container" (scroll)="onScroll($event)">
      @if (processedItems().length > 0) {
        @for (item of slicedItems(); track item.uniqueId + '-' + $index) {
          <div [class]="'card-row-item completed-item check-item ' + item.rowClass">
            <div class="card-header">
              <div class="card-info-left">
                <mat-icon
                  svgIcon="file"
                  class="card-primary-icon file-icon"
                  [matTooltip]="item.name"
                ></mat-icon>
                <span
                  class="card-title-text file-name"
                  [appCopyToClipboard]="item.name"
                  [matTooltip]="'common.copy' | translate"
                  >{{ item.name }}</span
                >
              </div>
              <div class="card-info-right actions-group">
                @if (item.status !== 'checked') {
                  <button
                    type="button"
                    class="action-button"
                    (click)="onResolve(item)"
                    [disabled]="isResolving(item)"
                    [matTooltip]="item.resolveTooltip | translate"
                  >
                    <mat-icon
                      [svgIcon]="isResolving(item) ? 'spinner' : item.resolveIcon"
                      class="colorful-spinner"
                    ></mat-icon>
                  </button>
                }
              </div>
            </div>

            @if (item.srcFs || item.dstFs) {
              <div class="card-paths-v2">
                <div class="path-group src">
                  <code class="path-pill src" [title]="item.srcFs">{{ item.srcFs || '?' }}</code>
                  @let canCopySrc = ops.canCopyUrlSource(item, config().jobType || 'check');
                  @let canDownloadSrc = ops.canDownloadSource(item, config().jobType || 'check');
                  @let canDeleteSrc = ops.canDeleteSource(item, config().jobType || 'check');
                  @let hasSrcActions = canCopySrc || canDownloadSrc || canDeleteSrc;
                  @if (hasSrcActions) {
                    <div class="path-actions">
                      @if (canCopySrc) {
                        @let loading =
                          ops.loadingUrlIds().has(item.uniqueId + '-src') ||
                          ops.isFeaturesLoading(item.srcFs);
                        <button
                          class="small-action-btn"
                          (click)="ops.copyUrlSource(item, item.uniqueId); $event.stopPropagation()"
                          [disabled]="loading"
                          [matTooltip]="'shared.transferActivity.actions.copyUrl' | translate"
                        >
                          <mat-icon
                            [svgIcon]="loading ? 'spinner' : 'link'"
                            class="colorful-spinner"
                          ></mat-icon>
                        </button>
                      }
                      @if (canDownloadSrc) {
                        <button
                          class="small-action-btn"
                          (click)="
                            ops.downloadSource(item, item.uniqueId); $event.stopPropagation()
                          "
                          [disabled]="ops.downloadingIds().has(item.uniqueId + '-src')"
                          [matTooltip]="'shared.transferActivity.actions.download' | translate"
                        >
                          <mat-icon
                            [svgIcon]="
                              ops.downloadingIds().has(item.uniqueId + '-src')
                                ? 'spinner'
                                : 'download'
                            "
                            class="colorful-spinner"
                          ></mat-icon>
                        </button>
                      }
                      @if (canDeleteSrc) {
                        <button
                          class="small-action-btn delete-btn"
                          (click)="onDeleteSource(item); $event.stopPropagation()"
                          [disabled]="ops.deletingIds().has(item.uniqueId + '-src-del')"
                          [matTooltip]="'common.delete' | translate"
                        >
                          <mat-icon
                            [svgIcon]="
                              ops.deletingIds().has(item.uniqueId + '-src-del')
                                ? 'spinner'
                                : 'trash'
                            "
                            class="colorful-spinner"
                          ></mat-icon>
                        </button>
                      }
                    </div>
                  }
                </div>

                <mat-icon svgIcon="right-arrow" class="arrow-icon"></mat-icon>

                <div class="path-group dst">
                  <code class="path-pill dst" [title]="item.dstFs">{{ item.dstFs || '?' }}</code>
                  @let canCopyDst = ops.canCopyUrlDst(item, config().jobType || 'check');
                  @let canDownloadDst = ops.canDownloadDst(item, config().jobType || 'check');
                  @let canDeleteDst = ops.canDeleteDst(item, config().jobType || 'check');
                  @let hasDstActions = canCopyDst || canDownloadDst || canDeleteDst;
                  @if (hasDstActions) {
                    <div class="path-actions">
                      @if (canCopyDst) {
                        @let loading =
                          ops.loadingUrlIds().has(item.uniqueId + '-dst') ||
                          ops.isFeaturesLoading(item.dstFs);
                        <button
                          class="small-action-btn"
                          (click)="ops.copyUrlDst(item, item.uniqueId); $event.stopPropagation()"
                          [disabled]="loading"
                          [matTooltip]="'shared.transferActivity.actions.copyUrl' | translate"
                        >
                          <mat-icon
                            [svgIcon]="loading ? 'spinner' : 'link'"
                            class="colorful-spinner"
                          ></mat-icon>
                        </button>
                      }
                      @if (canDownloadDst) {
                        <button
                          class="small-action-btn"
                          (click)="ops.downloadDst(item, item.uniqueId); $event.stopPropagation()"
                          [disabled]="ops.downloadingIds().has(item.uniqueId + '-dst')"
                          [matTooltip]="'shared.transferActivity.actions.download' | translate"
                        >
                          <mat-icon
                            [svgIcon]="
                              ops.downloadingIds().has(item.uniqueId + '-dst')
                                ? 'spinner'
                                : 'download'
                            "
                            class="colorful-spinner"
                          ></mat-icon>
                        </button>
                      }
                      @if (canDeleteDst) {
                        <button
                          class="small-action-btn delete-btn"
                          (click)="onDeleteDst(item); $event.stopPropagation()"
                          [disabled]="ops.deletingIds().has(item.uniqueId + '-dst-del')"
                          [matTooltip]="'common.delete' | translate"
                        >
                          <mat-icon
                            [svgIcon]="
                              ops.deletingIds().has(item.uniqueId + '-dst-del')
                                ? 'spinner'
                                : 'trash'
                            "
                            class="colorful-spinner"
                          ></mat-icon>
                        </button>
                      }
                    </div>
                  }
                </div>
              </div>
            } @else if (config().remoteName) {
              <div class="card-paths-v2">
                <div class="path-group dst">
                  <code class="path-pill dst" [title]="config().remoteName">{{
                    config().remoteName
                  }}</code>
                  @let canCopyFb =
                    ops.canCopyUrlFallback(item, config().jobType || 'check', config().remoteName);
                  @let canDownloadFb =
                    ops.canDownloadFallback(item, config().jobType || 'check', config().remoteName);
                  @let canDeleteFb =
                    ops.canDeleteFallback(item, config().jobType || 'check', config().remoteName);
                  @let hasFbActions = canCopyFb || canDownloadFb || canDeleteFb;
                  @if (hasFbActions) {
                    <div class="path-actions">
                      @if (canCopyFb) {
                        @let loading =
                          ops.loadingUrlIds().has(item.uniqueId + '-fallback') ||
                          ops.isFallbackFeaturesLoading(config().remoteName);
                        <button
                          class="small-action-btn"
                          (click)="
                            ops.copyUrlFallback(item, item.uniqueId, config().remoteName);
                            $event.stopPropagation()
                          "
                          [disabled]="loading"
                          [matTooltip]="'shared.transferActivity.actions.copyUrl' | translate"
                        >
                          <mat-icon
                            [svgIcon]="loading ? 'spinner' : 'link'"
                            class="colorful-spinner"
                          ></mat-icon>
                        </button>
                      }
                      @if (canDownloadFb) {
                        <button
                          class="small-action-btn"
                          (click)="
                            ops.downloadFallback(item, item.uniqueId, config().remoteName);
                            $event.stopPropagation()
                          "
                          [disabled]="ops.downloadingIds().has(item.uniqueId + '-fallback')"
                          [matTooltip]="'shared.transferActivity.actions.download' | translate"
                        >
                          <mat-icon
                            [svgIcon]="
                              ops.downloadingIds().has(item.uniqueId + '-fallback')
                                ? 'spinner'
                                : 'download'
                            "
                            class="colorful-spinner"
                          ></mat-icon>
                        </button>
                      }
                      @if (canDeleteFb) {
                        <button
                          class="small-action-btn delete-btn"
                          (click)="onDeleteFallback(item); $event.stopPropagation()"
                          [disabled]="ops.deletingIds().has(item.uniqueId + '-fallback-del')"
                          [matTooltip]="'common.delete' | translate"
                        >
                          <mat-icon
                            [svgIcon]="
                              ops.deletingIds().has(item.uniqueId + '-fallback-del')
                                ? 'spinner'
                                : 'trash'
                            "
                            class="colorful-spinner"
                          ></mat-icon>
                        </button>
                      }
                    </div>
                  }
                </div>
              </div>
            }

            @if (isResolving(item)) {
              <div class="card-progress">
                <mat-progress-bar
                  [mode]="item.resolveIsPreparing ? 'indeterminate' : 'determinate'"
                  [value]="item.resolveIsPreparing ? 0 : item.resolvePercentage"
                ></mat-progress-bar>
              </div>
            }

            <div class="card-footer">
              @if (isResolving(item)) {
                <div class="card-footer-left">
                  <span class="size-text"
                    >{{ item.resolveBytes | formatFileSize }} /
                    {{ item.resolveSize | formatFileSize }}</span
                  >
                </div>
                <div class="card-footer-right">
                  @if (item.resolveSpeed && item.resolveSpeed > 0) {
                    <span class="speed-text">
                      <span class="speed-dot" [class]="item.resolveSpeedClass"></span>
                      {{ item.resolveSpeed | formatFileSize }}/s
                    </span>
                  }
                  @if (item.resolveEta && item.resolveEta > 0) {
                    <span class="eta-text"> ETA: {{ item.resolveEta | formatTime }} </span>
                  }
                </div>
              } @else {
                <div class="card-footer-left">
                  <span [class]="'app-pill ' + item.badgeClass" [matTooltip]="item.error || ''">
                    <mat-icon [svgIcon]="item.badgeIcon"></mat-icon>
                    {{ item.badgeText | translate }}
                  </span>
                </div>
                <div class="card-footer-right">
                  @if (item.completedAt) {
                    <span class="time-text">{{ item.relativeTime }}</span>
                  }
                </div>
              }
            </div>
          </div>
        }
        @if (processedItems().length > displayLimit()) {
          <div class="infinite-scroll-loader">
            <mat-icon svgIcon="spinner" class="colorful-spinner"></mat-icon>
            <span>{{ 'common.loading' | translate }}</span>
          </div>
        }
      } @else if (searchTerm()) {
        <div class="empty-state">
          <mat-icon svgIcon="search"></mat-icon>
          <span>{{ 'shared.search.title' | translate }}</span>
          <p>{{ 'shared.search.description' | translate }}</p>
        </div>
      } @else {
        <div class="empty-state">
          <mat-icon svgIcon="check-circle"></mat-icon>
          <span>{{ 'shared.transferActivity.empty.noRecentCheck' | translate }}</span>
          <p>{{ 'shared.transferActivity.empty.recentHintCheck' | translate }}</p>
        </div>
      }
    </div>
  `,
})
export class CheckResultsTableComponent extends BaseTransfersTableComponent<EnrichedCheckResult> {
  readonly config = input.required<TransferActivityPanelConfig>();

  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly notifications = inject(NotificationService);
  private readonly pathService = inject(PathService);

  readonly localStatusOverrides = signal<Map<string, { status: string; error?: string }>>(
    new Map()
  );

  protected override readonly processedItems = computed<EnrichedCheckResult[]>(() => {
    this.lang();
    const search = this.searchTerm().toLowerCase().trim();
    const hidden = this.hiddenIds();
    const overrides = this.localStatusOverrides();
    const items = this.transfers();

    // 1. Filter out structural updates early to prevent useless allocations
    const rawFiltered = search
      ? items.filter(
          t => t.name.toLowerCase().includes(search) && !hidden.has(`${t.jobid}-${t.name}`)
        )
      : items.filter(t => !hidden.has(`${t.jobid}-${t.name}`));

    // 2. Perform mapping step exclusively on confirmed nodes
    return rawFiltered.map(t => {
      const uniqueId = `${t.jobid}-${t.name}`;
      let status = t.status;
      let error = t.error;
      let resolveStatus: string | undefined;
      let resolveError: string | undefined;
      let resolvePercentage = 0;
      let resolveIsPreparing = true;
      let resolveBytes = 0;
      let resolveSize = 0;
      let resolveSpeed = 0;
      let resolveSpeedClass = 'speed-slow';
      let resolveEta = 0;

      const resolveState = t.resolveState;
      if (resolveState) {
        resolveStatus = resolveState.status;
        if (resolveState.status === 'Failed') {
          resolveError = resolveState.error || 'Resolve job failed';
        }
        resolvePercentage = resolveState.percentage;
        resolveIsPreparing = resolveState.isPreparing;
        resolveBytes = resolveState.bytes;
        resolveSize = resolveState.size;
        resolveSpeed = resolveState.speed;
        resolveSpeedClass = resolveState.speedClass;
        resolveEta = resolveState.eta;
      }

      if (resolveStatus === 'Completed') {
        status = 'checked';
      } else if (resolveStatus === 'Failed') {
        status = 'failed';
        error = resolveError || 'Resolve job failed';
      }

      const override = overrides.get(uniqueId);
      if (override) {
        if (override.error !== undefined) error = override.error;
        resolveStatus = undefined;
      }

      let rowClass = '';
      let badgeClass = 'p-warn';
      let badgeIcon = 'circle-xmark';
      let badgeText = 'shared.transferActivity.status.error';

      switch (status) {
        case 'missing_dst':
          rowClass = 'missing-dst';
          badgeClass = 'p-warn';
          badgeIcon = 'circle-exclamation';
          badgeText = 'shared.transferActivity.status.missingDst';
          break;
        case 'missing_src':
          rowClass = 'missing-src';
          badgeClass = 'p-warn';
          badgeIcon = 'circle-exclamation';
          badgeText = 'shared.transferActivity.status.missingSrc';
          break;
        case 'partial':
          rowClass = 'differ';
          badgeClass = 'p-orange';
          badgeIcon = 'circle-exclamation';
          badgeText = 'shared.transferActivity.status.differ';
          break;
        case 'checked':
          badgeClass = 'p-accent';
          badgeIcon = 'check-circle';
          badgeText = 'shared.transferActivity.status.checked';
          break;
        case 'failed':
          rowClass = 'error';
          break;
      }

      if (resolveStatus === 'Failed') rowClass = 'error';

      const resolveIcon = status === 'missing_src' ? 'left-arrow' : 'right-arrow';
      const resolveTooltip =
        status === 'missing_dst'
          ? 'shared.transferActivity.actions.resolveToDst'
          : status === 'missing_src'
            ? 'shared.transferActivity.actions.resolveToSrc'
            : 'shared.transferActivity.actions.resolveOverwrite';

      return {
        ...t,
        status,
        error,
        uniqueId,
        resolvePercentage,
        resolveIsPreparing,
        resolveBytes,
        resolveSize,
        resolveSpeed,
        resolveSpeedClass,
        resolveEta,
        resolveError,
        resolveStatus,
        rowClass,
        badgeClass,
        badgeIcon,
        badgeText,
        resolveIcon,
        resolveTooltip,
        relativeTime: t.completedAt ? this.getRelativeTime(t.completedAt) : '',
      };
    });
  });

  async onResolve(item: EnrichedCheckResult): Promise<void> {
    this.resolvingIds.update(s => new Set(s).add(item.uniqueId));
    try {
      const srcFs = item.srcFs || '';
      const dstFs = item.dstFs || '';
      const path = item.name;

      if (item.status === 'missing_dst') {
        await this.remoteOps.transferItems(
          [{ remote: srcFs, path, name: this.pathService.extractName(path), isDir: false }],
          dstFs,
          this.pathService.getParentPath(path),
          'copy',
          'dashboard',
          undefined,
          item.jobid
        );
      } else if (item.status === 'missing_src') {
        await this.remoteOps.transferItems(
          [{ remote: dstFs, path, name: this.pathService.extractName(path), isDir: false }],
          srcFs,
          this.pathService.getParentPath(path),
          'copy',
          'dashboard',
          undefined,
          item.jobid
        );
      } else if (item.status === 'partial') {
        const confirmed = await this.notifications.confirmModal(
          this.translate.instant('shared.transferActivity.actions.resolveOverwriteTitle'),
          this.translate.instant('shared.transferActivity.actions.resolveOverwriteMessage', {
            name: path,
          }),
          'shared.transferActivity.actions.overwriteDst',
          'common.cancel',
          { icon: 'sync', color: 'accent' }
        );
        if (!confirmed) return;

        await this.remoteOps.transferItems(
          [{ remote: srcFs, path, name: this.pathService.extractName(path), isDir: false }],
          dstFs,
          this.pathService.getParentPath(path),
          'copy',
          'dashboard',
          undefined,
          item.jobid
        );
      }
      this.notifications.showSuccess(
        this.translate.instant('shared.transferActivity.actions.successSync')
      );
    } catch (e) {
      console.error('Failed to resolve difference:', e);
      this.notifications.showError(
        this.translate.instant('shared.transferActivity.actions.failSync', {
          error: (e as Error).message || String(e),
        })
      );
    } finally {
      this.resolvingIds.update(s => {
        const next = new Set(s);
        next.delete(item.uniqueId);
        return next;
      });
    }
  }

  async onDeleteSource(item: EnrichedCheckResult): Promise<void> {
    await this.ops.deleteSource(item, item.uniqueId, () => {
      if (item.status === 'partial' || item.status === 'checked') {
        this.localStatusOverrides.update(m =>
          new Map(m).set(item.uniqueId, { status: 'missing_src' })
        );
      } else {
        this.hiddenIds.update(s => new Set(s).add(item.uniqueId));
      }
    });
  }

  async onDeleteDst(item: EnrichedCheckResult): Promise<void> {
    await this.ops.deleteDst(item, item.uniqueId, () => {
      if (item.status === 'partial' || item.status === 'checked') {
        this.localStatusOverrides.update(m =>
          new Map(m).set(item.uniqueId, { status: 'missing_dst' })
        );
      } else {
        this.hiddenIds.update(s => new Set(s).add(item.uniqueId));
      }
    });
  }

  async onDeleteFallback(item: EnrichedCheckResult): Promise<void> {
    await this.ops.deleteFallback(item, item.uniqueId, this.config().remoteName, () => {
      this.hiddenIds.update(s => new Set(s).add(item.uniqueId));
    });
  }
}
