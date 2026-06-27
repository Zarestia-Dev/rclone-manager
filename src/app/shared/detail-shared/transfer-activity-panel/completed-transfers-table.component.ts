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
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { FormatFileSizePipe } from '@app/pipes';
import { CompletedTransfer } from '@app/types';
import { toSignal } from '@angular/core/rxjs-interop';
import { TransferOperationsService } from './transfer-operations.service';

@Component({
  selector: 'app-completed-transfers-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [TransferOperationsService],
  imports: [MatIconModule, MatTooltipModule, MatButtonModule, TranslatePipe, FormatFileSizePipe],
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
                        @if (ops.canCopyUrlSource(transfer, jobType())) {
                          <button
                            class="small-action-btn"
                            (click)="
                              ops.copyUrlSource(transfer, transfer.uniqueId);
                              $event.stopPropagation()
                            "
                            [disabled]="
                              ops.loadingUrlIds().has(transfer.uniqueId + '-src') ||
                              ops.isFeaturesLoading(transfer.srcFs)
                            "
                            [matTooltip]="'shared.transferActivity.actions.copyUrl' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                ops.loadingUrlIds().has(transfer.uniqueId + '-src') ||
                                ops.isFeaturesLoading(transfer.srcFs)
                                  ? 'refresh'
                                  : 'link'
                              "
                              [class.animate-spin]="
                                ops.loadingUrlIds().has(transfer.uniqueId + '-src') ||
                                ops.isFeaturesLoading(transfer.srcFs)
                              "
                            ></mat-icon>
                          </button>
                        }
                        @if (ops.canDownloadSource(transfer, jobType())) {
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
                        @if (ops.canDeleteSource(transfer, jobType())) {
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
                  </div>

                  <mat-icon svgIcon="right-arrow" class="arrow-icon"></mat-icon>

                  <div class="path-group dst">
                    <code class="path-pill dst" [title]="transfer.dstFs">{{
                      transfer.dstFs || '?'
                    }}</code>
                    @if (transfer.status !== 'checked') {
                      <div class="path-actions">
                        @if (ops.canCopyUrlDst(transfer, jobType())) {
                          <button
                            class="small-action-btn"
                            (click)="
                              ops.copyUrlDst(transfer, transfer.uniqueId); $event.stopPropagation()
                            "
                            [disabled]="
                              ops.loadingUrlIds().has(transfer.uniqueId + '-dst') ||
                              ops.isFeaturesLoading(transfer.dstFs)
                            "
                            [matTooltip]="'shared.transferActivity.actions.copyUrl' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                ops.loadingUrlIds().has(transfer.uniqueId + '-dst') ||
                                ops.isFeaturesLoading(transfer.dstFs)
                                  ? 'refresh'
                                  : 'link'
                              "
                              [class.animate-spin]="
                                ops.loadingUrlIds().has(transfer.uniqueId + '-dst') ||
                                ops.isFeaturesLoading(transfer.dstFs)
                              "
                            ></mat-icon>
                          </button>
                        }
                        @if (ops.canDownloadDst(transfer, jobType())) {
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
                        @if (ops.canDeleteDst(transfer, jobType())) {
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
                  </div>
                </div>
              } @else if (remoteName() && transfer.status !== 'checked') {
                <div class="card-paths-v2">
                  <div class="path-group dst">
                    <code class="path-pill dst" [title]="remoteName()">{{ remoteName() }}</code>
                    <div class="path-actions">
                      @if (ops.canCopyUrlFallback(transfer, jobType(), remoteName())) {
                        <button
                          class="small-action-btn"
                          (click)="
                            ops.copyUrlFallback(transfer, transfer.uniqueId, remoteName());
                            $event.stopPropagation()
                          "
                          [disabled]="
                            ops.loadingUrlIds().has(transfer.uniqueId + '-fallback') ||
                            ops.isFallbackFeaturesLoading(remoteName())
                          "
                          [matTooltip]="'shared.transferActivity.actions.copyUrl' | translate"
                        >
                          <mat-icon
                            [svgIcon]="
                              ops.loadingUrlIds().has(transfer.uniqueId + '-fallback') ||
                              ops.isFallbackFeaturesLoading(remoteName())
                                ? 'refresh'
                                : 'link'
                            "
                            [class.animate-spin]="
                              ops.loadingUrlIds().has(transfer.uniqueId + '-fallback') ||
                              ops.isFallbackFeaturesLoading(remoteName())
                            "
                          ></mat-icon>
                        </button>
                      }
                      @if (ops.canDownloadFallback(transfer, jobType(), remoteName())) {
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
  protected readonly ops = inject(TransferOperationsService);

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
      this.ops.preloadFeatures(this.transfers());
    });
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
