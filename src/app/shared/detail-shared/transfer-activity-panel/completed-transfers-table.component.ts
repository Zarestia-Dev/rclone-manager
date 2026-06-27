import {
  Component,
  input,
  inject,
  ChangeDetectionStrategy,
  computed,
  signal,
  effect,
  linkedSignal,
  untracked,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { FormatFileSizePipe, FormatTimePipe } from '@app/pipes';
import { CompletedTransfer } from '@app/types';
import { toSignal } from '@angular/core/rxjs-interop';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { TransferOperationsService } from './transfer-operations.service';

export interface EnrichedCompletedTransfer extends CompletedTransfer {
  uniqueId: string;
  badgeClass: string;
  badgeIcon: string;
  badgeText: string;
  relativeTime: string;
  duration: string;
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
  selector: 'app-completed-transfers-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [TransferOperationsService],
  imports: [
    MatIconModule,
    MatTooltipModule,
    MatButtonModule,
    TranslatePipe,
    FormatFileSizePipe,
    MatProgressBarModule,
    FormatTimePipe,
  ],
  template: `
    <div class="card-list-container" (scroll)="onScroll($event)">
      @if (processedTransfers().length > 0) {
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
              <div class="card-info-right actions-group">
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

                @if (transfer.status === 'failed' && transfer.srcFs && transfer.dstFs) {
                  <button
                    type="button"
                    class="action-button resolve-btn"
                    (click)="onResolve(transfer)"
                    [disabled]="isResolving(transfer)"
                    [matTooltip]="'shared.transferActivity.actions.resolveToDst' | translate"
                  >
                    <mat-icon
                      [svgIcon]="isResolving(transfer) ? 'refresh' : 'right-arrow'"
                      [class.animate-spin]="isResolving(transfer)"
                    ></mat-icon>
                  </button>
                }
              </div>
            </div>

            @if (transfer.srcFs || transfer.dstFs) {
              <div class="card-paths-v2">
                <div class="path-group src">
                  <code class="path-pill src" [title]="transfer.srcFs">{{
                    formatFsName(transfer.srcFs) || '?'
                  }}</code>
                  @if (transfer.status !== 'checked') {
                    @let canCopySrc = ops.canCopyUrlSource(transfer, jobType());
                    @let canDownloadSrc = ops.canDownloadSource(transfer, jobType());
                    @let canDeleteSrc = ops.canDeleteSource(transfer, jobType());
                    @let hasSrcActions = canCopySrc || canDownloadSrc || canDeleteSrc;
                    @if (hasSrcActions) {
                      <div class="path-actions">
                        @if (canCopySrc) {
                          @let loading =
                            ops.loadingUrlIds().has(transfer.uniqueId + '-src') ||
                            ops.isFeaturesLoading(transfer.srcFs);
                          <button
                            class="small-action-btn"
                            (click)="
                              ops.copyUrlSource(transfer, transfer.uniqueId);
                              $event.stopPropagation()
                            "
                            [disabled]="loading"
                            [matTooltip]="'shared.transferActivity.actions.copyUrl' | translate"
                          >
                            <mat-icon
                              [svgIcon]="loading ? 'refresh' : 'link'"
                              [class.animate-spin]="loading"
                            ></mat-icon>
                          </button>
                        }
                        @if (canDownloadSrc) {
                          <button
                            class="small-action-btn"
                            (click)="
                              ops.downloadSource(transfer, transfer.uniqueId);
                              $event.stopPropagation()
                            "
                            [disabled]="ops.downloadingIds().has(transfer.uniqueId + '-src')"
                            [matTooltip]="'shared.transferActivity.actions.download' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                ops.downloadingIds().has(transfer.uniqueId + '-src')
                                  ? 'refresh'
                                  : 'download'
                              "
                              [class.animate-spin]="
                                ops.downloadingIds().has(transfer.uniqueId + '-src')
                              "
                            ></mat-icon>
                          </button>
                        }
                        @if (canDeleteSrc) {
                          <button
                            class="small-action-btn delete-btn"
                            (click)="onDeleteSource(transfer); $event.stopPropagation()"
                            [disabled]="ops.deletingIds().has(transfer.uniqueId + '-src-del')"
                            [matTooltip]="'common.delete' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                ops.deletingIds().has(transfer.uniqueId + '-src-del')
                                  ? 'refresh'
                                  : 'trash'
                              "
                              [class.animate-spin]="
                                ops.deletingIds().has(transfer.uniqueId + '-src-del')
                              "
                            ></mat-icon>
                          </button>
                        }
                      </div>
                    }
                  }
                </div>

                <mat-icon svgIcon="right-arrow" class="arrow-icon"></mat-icon>

                <div class="path-group dst">
                  <code class="path-pill dst" [title]="transfer.dstFs">{{
                    formatFsName(transfer.dstFs) || '?'
                  }}</code>
                  @if (transfer.status !== 'checked') {
                    @let canCopyDst = ops.canCopyUrlDst(transfer, jobType());
                    @let canDownloadDst = ops.canDownloadDst(transfer, jobType());
                    @let canDeleteDst = ops.canDeleteDst(transfer, jobType());
                    @let hasDstActions = canCopyDst || canDownloadDst || canDeleteDst;
                    @if (hasDstActions) {
                      <div class="path-actions">
                        @if (canCopyDst) {
                          @let loading =
                            ops.loadingUrlIds().has(transfer.uniqueId + '-dst') ||
                            ops.isFeaturesLoading(transfer.dstFs);
                          <button
                            class="small-action-btn"
                            (click)="
                              ops.copyUrlDst(transfer, transfer.uniqueId); $event.stopPropagation()
                            "
                            [disabled]="loading"
                            [matTooltip]="'shared.transferActivity.actions.copyUrl' | translate"
                          >
                            <mat-icon
                              [svgIcon]="loading ? 'refresh' : 'link'"
                              [class.animate-spin]="loading"
                            ></mat-icon>
                          </button>
                        }
                        @if (canDownloadDst) {
                          <button
                            class="small-action-btn"
                            (click)="
                              ops.downloadDst(transfer, transfer.uniqueId); $event.stopPropagation()
                            "
                            [disabled]="ops.downloadingIds().has(transfer.uniqueId + '-dst')"
                            [matTooltip]="'shared.transferActivity.actions.download' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                ops.downloadingIds().has(transfer.uniqueId + '-dst')
                                  ? 'refresh'
                                  : 'download'
                              "
                              [class.animate-spin]="
                                ops.downloadingIds().has(transfer.uniqueId + '-dst')
                              "
                            ></mat-icon>
                          </button>
                        }
                        @if (canDeleteDst) {
                          <button
                            class="small-action-btn delete-btn"
                            (click)="onDeleteDst(transfer); $event.stopPropagation()"
                            [disabled]="ops.deletingIds().has(transfer.uniqueId + '-dst-del')"
                            [matTooltip]="'common.delete' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                ops.deletingIds().has(transfer.uniqueId + '-dst-del')
                                  ? 'refresh'
                                  : 'trash'
                              "
                              [class.animate-spin]="
                                ops.deletingIds().has(transfer.uniqueId + '-dst-del')
                              "
                            ></mat-icon>
                          </button>
                        }
                      </div>
                    }
                  }
                </div>
              </div>
            } @else if (remoteName() && transfer.status !== 'checked') {
              <div class="card-paths-v2">
                <div class="path-group dst">
                  <code class="path-pill dst" [title]="remoteName()">{{
                    formatFsName(remoteName())
                  }}</code>
                  @let canCopyFb = ops.canCopyUrlFallback(transfer, jobType(), remoteName());
                  @let canDownloadFb = ops.canDownloadFallback(transfer, jobType(), remoteName());
                  @let canDeleteFb = ops.canDeleteFallback(transfer, jobType(), remoteName());
                  @let hasFbActions = canCopyFb || canDownloadFb || canDeleteFb;
                  @if (hasFbActions) {
                    <div class="path-actions">
                      @if (canCopyFb) {
                        @let loading =
                          ops.loadingUrlIds().has(transfer.uniqueId + '-fallback') ||
                          ops.isFallbackFeaturesLoading(remoteName());
                        <button
                          class="small-action-btn"
                          (click)="
                            ops.copyUrlFallback(transfer, transfer.uniqueId, remoteName());
                            $event.stopPropagation()
                          "
                          [disabled]="loading"
                          [matTooltip]="'shared.transferActivity.actions.copyUrl' | translate"
                        >
                          <mat-icon
                            [svgIcon]="loading ? 'refresh' : 'link'"
                            [class.animate-spin]="loading"
                          ></mat-icon>
                        </button>
                      }
                      @if (canDownloadFb) {
                        <button
                          class="small-action-btn"
                          (click)="
                            ops.downloadFallback(transfer, transfer.uniqueId, remoteName());
                            $event.stopPropagation()
                          "
                          [disabled]="ops.downloadingIds().has(transfer.uniqueId + '-fallback')"
                          [matTooltip]="'shared.transferActivity.actions.download' | translate"
                        >
                          <mat-icon
                            [svgIcon]="
                              ops.downloadingIds().has(transfer.uniqueId + '-fallback')
                                ? 'refresh'
                                : 'download'
                            "
                            [class.animate-spin]="
                              ops.downloadingIds().has(transfer.uniqueId + '-fallback')
                            "
                          ></mat-icon>
                        </button>
                      }
                      @if (ops.canDeleteFallback(transfer, jobType(), remoteName())) {
                        <button
                          class="small-action-btn delete-btn"
                          (click)="onDeleteFallback(transfer); $event.stopPropagation()"
                          [disabled]="ops.deletingIds().has(transfer.uniqueId + '-fallback-del')"
                          [matTooltip]="'common.delete' | translate"
                        >
                          <mat-icon
                            [svgIcon]="
                              ops.deletingIds().has(transfer.uniqueId + '-fallback-del')
                                ? 'refresh'
                                : 'trash'
                            "
                            [class.animate-spin]="
                              ops.deletingIds().has(transfer.uniqueId + '-fallback-del')
                            "
                          ></mat-icon>
                        </button>
                      }
                    </div>
                  }
                </div>
              </div>
            }

            <div class="card-footer">
              <div class="card-footer-left">
                <span class="size-text">
                  {{ transfer.size | formatFileSize }}
                  @if (transfer.bytes !== transfer.size && transfer.bytes > 0) {
                    <span class="size-transferred"
                      >({{
                        'shared.transferActivity.table.transferred'
                          | translate: { bytes: (transfer.bytes | formatFileSize) }
                      }})</span
                    >
                  }
                  @if (transfer.status === 'checked' && transfer.size > 0) {
                    <span class="size-transferred"
                      >({{ 'shared.transferActivity.table.alreadyExisted' | translate }})</span
                    >
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

            @if (transfer.resolveStatus === 'Running' || isResolving(transfer)) {
              <div class="card-progress resolve-progress">
                <mat-progress-bar
                  [mode]="transfer.resolveIsPreparing ? 'indeterminate' : 'determinate'"
                  [value]="transfer.resolveIsPreparing ? 0 : transfer.resolvePercentage"
                ></mat-progress-bar>
                <span class="percentage-text">
                  @if (transfer.resolveIsPreparing) {
                    {{ 'shared.transferActivity.status.preparing' | translate }}
                  } @else if (transfer.resolvePercentage === 100) {
                    {{ 'shared.transferActivity.status.finalizing' | translate }}
                  } @else {
                    {{ transfer.resolvePercentage }}%
                  }
                </span>
              </div>

              <div class="card-footer resolve-footer">
                <div class="card-footer-left">
                  <span class="size-text"
                    >{{ transfer.resolveBytes | formatFileSize }} /
                    {{ transfer.resolveSize | formatFileSize }}</span
                  >
                </div>
                <div class="card-footer-right">
                  @if (transfer.resolveSpeed > 0) {
                    <span class="speed-text">
                      <span class="speed-dot" [class]="transfer.resolveSpeedClass"></span>
                      {{ transfer.resolveSpeed | formatFileSize }}/s
                    </span>
                  }
                  @if (transfer.resolveEta > 0) {
                    <span class="eta-text">{{ transfer.resolveEta | formatTime }}</span>
                  }
                </div>
              </div>
            }
          </div>
        }
        @if (processedTransfers().length > displayLimit()) {
          <div class="infinite-scroll-loader">
            <mat-icon svgIcon="refresh" class="animate-spin"></mat-icon>
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
  protected readonly ops = inject(TransferOperationsService);
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly notifications = inject(NotificationService);
  private readonly pathService = inject(PathService);

  protected formatFsName(fs?: string): string {
    if (!fs) return '';
    if (/^[a-zA-Z]:$/.test(fs)) {
      return fs;
    }
    return fs.endsWith(':') ? fs.slice(0, -1) : fs;
  }

  readonly hiddenIds = signal<Set<string>>(new Set());
  readonly resolvingIds = signal<Set<string>>(new Set());

  readonly displayLimit = linkedSignal({
    source: () => [this.transfers(), this.searchTerm()] as const,
    computation: () => 50,
  });

  private readonly lang = toSignal(this.translate.onLangChange, { initialValue: null });

  private readonly remotesList = computed(
    () => {
      const remotes = new Set<string>();
      for (const t of this.transfers()) {
        if (t.srcFs) remotes.add(t.srcFs);
        if (t.dstFs) remotes.add(t.dstFs);
      }
      return Array.from(remotes).sort();
    },
    {
      equal: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
    }
  );

  private readonly _preloadEffect = effect(() => {
    const remotes = this.remotesList();
    if (remotes.length > 0) {
      untracked(() => this.ops.preloadFeatures(this.transfers()));
    }
  });

  protected readonly processedTransfers = computed<EnrichedCompletedTransfer[]>(() => {
    this.lang();
    const hidden = this.hiddenIds();
    const search = this.searchTerm().toLowerCase().trim();
    const items = this.transfers();

    const rawFiltered = search
      ? items.filter(
          t => t.name.toLowerCase().includes(search) && !hidden.has(`${t.jobid}-${t.name}`)
        )
      : items.filter(t => !hidden.has(`${t.jobid}-${t.name}`));

    return rawFiltered.map(transfer => {
      let status = transfer.status;
      let error = transfer.error;
      let resolveStatus: string | undefined;
      let resolveError: string | undefined;
      let resolvePercentage = 0;
      let resolveIsPreparing = true;
      let resolveBytes = 0;
      let resolveSize = 0;
      let resolveSpeed = 0;
      let resolveSpeedClass = 'speed-slow';
      let resolveEta = 0;

      const resolveState = transfer.resolveState;
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

      let badgeClass = 'p-primary';
      let badgeIcon = 'circle-check';
      let badgeText = 'shared.transferActivity.status.completed';

      switch (status) {
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
        status,
        error,
        relativeTime: transfer.completedAt ? this.getRelativeTime(transfer.completedAt) : '',
        duration:
          transfer.startedAt && transfer.completedAt && status === 'completed'
            ? this.getDuration(transfer.startedAt, transfer.completedAt)
            : '',
        badgeClass,
        badgeIcon,
        badgeText,
        uniqueId: `${transfer.jobid}-${transfer.name}`,
        resolvePercentage,
        resolveIsPreparing,
        resolveBytes,
        resolveSize,
        resolveSpeed,
        resolveSpeedClass,
        resolveEta,
        resolveError,
        resolveStatus,
      };
    });
  });

  protected readonly slicedTransfers = computed(() => {
    return this.processedTransfers().slice(0, this.displayLimit());
  });

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

  isResolving(item: EnrichedCompletedTransfer): boolean {
    return this.resolvingIds().has(item.uniqueId) || item.resolveState?.status === 'Running';
  }

  async onResolve(item: EnrichedCompletedTransfer): Promise<void> {
    this.resolvingIds.update(s => new Set(s).add(item.uniqueId));
    try {
      const srcFs = item.srcFs || '';
      const dstFs = item.dstFs || '';
      const path = item.name;

      await this.remoteOps.transferItems(
        [{ remote: srcFs, path, name: this.pathService.extractName(path), isDir: false }],
        dstFs,
        this.pathService.getParentPath(path),
        'copy',
        'dashboard',
        undefined,
        item.jobid
      );

      this.notifications.showSuccess(
        this.translate.instant('shared.transferActivity.messages.resolveStarted', {
          name: this.pathService.extractName(path),
        })
      );
    } catch (e) {
      console.error('Failed to resolve failed transfer:', e);
      this.notifications.showError(
        this.translate.instant('shared.transferActivity.messages.resolveFailed', { error: e })
      );
    } finally {
      this.resolvingIds.update(s => {
        const next = new Set(s);
        next.delete(item.uniqueId);
        return next;
      });
    }
  }

  async onDeleteSource(item: CompletedTransfer): Promise<void> {
    const uniqueId = item.uniqueId || `${item.jobid}-${item.name}`;
    await this.ops.deleteSource(item, uniqueId, () => {
      this.hiddenIds.update(s => new Set(s).add(uniqueId));
    });
  }

  async onDeleteDst(item: CompletedTransfer): Promise<void> {
    const uniqueId = item.uniqueId || `${item.jobid}-${item.name}`;
    await this.ops.deleteDst(item, uniqueId, () => {
      this.hiddenIds.update(s => new Set(s).add(uniqueId));
    });
  }

  async onDeleteFallback(item: CompletedTransfer): Promise<void> {
    const uniqueId = item.uniqueId || `${item.jobid}-${item.name}`;
    await this.ops.deleteFallback(item, uniqueId, this.remoteName(), () => {
      this.hiddenIds.update(s => new Set(s).add(uniqueId));
    });
  }

  onScroll(event: Event): void {
    const target = event.target as HTMLElement;
    if (!target) return;

    if (target.scrollHeight - (target.scrollTop + target.clientHeight) < 150) {
      const currentLimit = this.displayLimit();
      const totalCount = this.processedTransfers().length;
      if (currentLimit < totalCount) {
        this.displayLimit.set(Math.min(currentLimit + 50, totalCount));
      }
    }
  }
}
