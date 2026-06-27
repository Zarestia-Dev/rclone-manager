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
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  CompletedTransfer,
  TransferActivityPanelConfig,
  JobInfo,
  TransferFile,
  GlobalStats,
} from '@app/types';
import { FormatFileSizePipe, FormatTimePipe } from '@app/pipes';
import { CopyToClipboardDirective } from '../../directives/copy-to-clipboard.directive';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { TransferOperationsService } from './transfer-operations.service';

export interface EnrichedCheckResult extends CompletedTransfer {
  uniqueId: string;
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
  standalone: true,
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
    <div class="detail-panel">
      <div class="card-list-container" (scroll)="onScroll($event)">
        @if (transfers().length > 0) {
          @if (filteredItems().length > 0) {
            @for (item of slicedItems(); track item.uniqueId) {
              <div [class]="'card-row-item completed-item check-item ' + getRowClass(item)">
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
                    <!-- Resolve Action -->
                    @if (item.status !== 'checked') {
                      <button
                        mat-icon-button
                        (click)="onResolve(item)"
                        [disabled]="isResolving(item)"
                        [matTooltip]="getResolveTooltip(item) | translate"
                      >
                        <mat-icon
                          [svgIcon]="isResolving(item) ? 'refresh' : getResolveIcon(item)"
                          [class.animate-spin]="isResolving(item)"
                        ></mat-icon>
                      </button>
                    }
                  </div>
                </div>

                @if (item.srcFs || item.dstFs) {
                  <div class="card-paths-v2">
                    <div class="path-group src">
                      <code class="path-pill src" [title]="item.srcFs">{{
                        item.srcFs || '?'
                      }}</code>
                      <div class="path-actions">
                        @if (ops.canCopyUrlSource(item, config().jobType || 'check')) {
                          <button
                            class="small-action-btn"
                            (click)="
                              ops.copyUrlSource(item, item.uniqueId); $event.stopPropagation()
                            "
                            [disabled]="
                              ops.loadingUrlIds().has(item.uniqueId + '-src') ||
                              ops.isFeaturesLoading(item.srcFs)
                            "
                            [matTooltip]="'shared.transferActivity.actions.copyUrl' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                ops.loadingUrlIds().has(item.uniqueId + '-src') ||
                                ops.isFeaturesLoading(item.srcFs)
                                  ? 'refresh'
                                  : 'link'
                              "
                              [class.animate-spin]="
                                ops.loadingUrlIds().has(item.uniqueId + '-src') ||
                                ops.isFeaturesLoading(item.srcFs)
                              "
                            ></mat-icon>
                          </button>
                        }
                        @if (ops.canDownloadSource(item, config().jobType || 'check')) {
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
                                  ? 'refresh'
                                  : 'download'
                              "
                              [class.animate-spin]="
                                ops.downloadingIds().has(item.uniqueId + '-src')
                              "
                            ></mat-icon>
                          </button>
                        }
                        @if (ops.canDeleteSource(item, config().jobType || 'check')) {
                          <button
                            class="small-action-btn delete-btn"
                            (click)="onDeleteSource(item); $event.stopPropagation()"
                            [disabled]="ops.deletingIds().has(item.uniqueId + '-src-del')"
                            [matTooltip]="'common.delete' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                ops.deletingIds().has(item.uniqueId + '-src-del')
                                  ? 'refresh'
                                  : 'trash'
                              "
                              [class.animate-spin]="
                                ops.deletingIds().has(item.uniqueId + '-src-del')
                              "
                            ></mat-icon>
                          </button>
                        }
                      </div>
                    </div>

                    <mat-icon svgIcon="right-arrow" class="arrow-icon"></mat-icon>

                    <div class="path-group dst">
                      <code class="path-pill dst" [title]="item.dstFs">{{
                        item.dstFs || '?'
                      }}</code>
                      <div class="path-actions">
                        @if (ops.canCopyUrlDst(item, config().jobType || 'check')) {
                          <button
                            class="small-action-btn"
                            (click)="ops.copyUrlDst(item, item.uniqueId); $event.stopPropagation()"
                            [disabled]="
                              ops.loadingUrlIds().has(item.uniqueId + '-dst') ||
                              ops.isFeaturesLoading(item.dstFs)
                            "
                            [matTooltip]="'shared.transferActivity.actions.copyUrl' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                ops.loadingUrlIds().has(item.uniqueId + '-dst') ||
                                ops.isFeaturesLoading(item.dstFs)
                                  ? 'refresh'
                                  : 'link'
                              "
                              [class.animate-spin]="
                                ops.loadingUrlIds().has(item.uniqueId + '-dst') ||
                                ops.isFeaturesLoading(item.dstFs)
                              "
                            ></mat-icon>
                          </button>
                        }
                        @if (ops.canDownloadDst(item, config().jobType || 'check')) {
                          <button
                            class="small-action-btn"
                            (click)="ops.downloadDst(item, item.uniqueId); $event.stopPropagation()"
                            [disabled]="ops.downloadingIds().has(item.uniqueId + '-dst')"
                            [matTooltip]="'shared.transferActivity.actions.download' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                ops.downloadingIds().has(item.uniqueId + '-dst')
                                  ? 'refresh'
                                  : 'download'
                              "
                              [class.animate-spin]="
                                ops.downloadingIds().has(item.uniqueId + '-dst')
                              "
                            ></mat-icon>
                          </button>
                        }
                        @if (ops.canDeleteDst(item, config().jobType || 'check')) {
                          <button
                            class="small-action-btn delete-btn"
                            (click)="onDeleteDst(item); $event.stopPropagation()"
                            [disabled]="ops.deletingIds().has(item.uniqueId + '-dst-del')"
                            [matTooltip]="'common.delete' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                ops.deletingIds().has(item.uniqueId + '-dst-del')
                                  ? 'refresh'
                                  : 'trash'
                              "
                              [class.animate-spin]="
                                ops.deletingIds().has(item.uniqueId + '-dst-del')
                              "
                            ></mat-icon>
                          </button>
                        }
                      </div>
                    </div>
                  </div>
                } @else if (config().remoteName) {
                  <div class="card-paths-v2">
                    <div class="path-group dst">
                      <code class="path-pill dst" [title]="config().remoteName">{{
                        config().remoteName
                      }}</code>
                      <div class="path-actions">
                        @if (
                          ops.canCopyUrlFallback(
                            item,
                            config().jobType || 'check',
                            config().remoteName
                          )
                        ) {
                          <button
                            class="small-action-btn"
                            (click)="
                              ops.copyUrlFallback(item, item.uniqueId, config().remoteName);
                              $event.stopPropagation()
                            "
                            [disabled]="
                              ops.loadingUrlIds().has(item.uniqueId + '-fallback') ||
                              ops.isFallbackFeaturesLoading(config().remoteName)
                            "
                            [matTooltip]="'shared.transferActivity.actions.copyUrl' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                ops.loadingUrlIds().has(item.uniqueId + '-fallback') ||
                                ops.isFallbackFeaturesLoading(config().remoteName)
                                  ? 'refresh'
                                  : 'link'
                              "
                              [class.animate-spin]="
                                ops.loadingUrlIds().has(item.uniqueId + '-fallback') ||
                                ops.isFallbackFeaturesLoading(config().remoteName)
                              "
                            ></mat-icon>
                          </button>
                        }
                        @if (
                          ops.canDownloadFallback(
                            item,
                            config().jobType || 'check',
                            config().remoteName
                          )
                        ) {
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
                                  ? 'refresh'
                                  : 'download'
                              "
                              [class.animate-spin]="
                                ops.downloadingIds().has(item.uniqueId + '-fallback')
                              "
                            ></mat-icon>
                          </button>
                        }
                        @if (
                          ops.canDeleteFallback(
                            item,
                            config().jobType || 'check',
                            config().remoteName
                          )
                        ) {
                          <button
                            class="small-action-btn delete-btn"
                            (click)="onDeleteFallback(item); $event.stopPropagation()"
                            [disabled]="ops.deletingIds().has(item.uniqueId + '-fallback-del')"
                            [matTooltip]="'common.delete' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                ops.deletingIds().has(item.uniqueId + '-fallback-del')
                                  ? 'refresh'
                                  : 'trash'
                              "
                              [class.animate-spin]="
                                ops.deletingIds().has(item.uniqueId + '-fallback-del')
                              "
                            ></mat-icon>
                          </button>
                        }
                      </div>
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
                      <span class="size-text">
                        {{ item.resolveBytes | formatFileSize }} /
                        {{ item.resolveSize | formatFileSize }}
                      </span>
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
                      <span
                        [class]="'app-pill ' + getBadgeClass(item)"
                        [matTooltip]="item.error || ''"
                      >
                        <mat-icon [svgIcon]="getBadgeIcon(item)"></mat-icon>
                        {{ getBadgeText(item) | translate }}
                      </span>
                    </div>
                    <div class="card-footer-right">
                      @if (item.completedAt) {
                        <span class="time-text">{{ getRelativeTime(item.completedAt) }}</span>
                      }
                    </div>
                  }
                </div>
              </div>
            }
            @if (filteredItems().length > displayLimit()) {
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
            <span>{{ 'shared.transferActivity.empty.noRecentCheck' | translate }}</span>
            <p>{{ 'shared.transferActivity.empty.recentHintCheck' | translate }}</p>
          </div>
        }
      </div>
    </div>
  `,
})
export class CheckResultsTableComponent {
  readonly transfers = input.required<CompletedTransfer[]>();
  readonly config = input.required<TransferActivityPanelConfig>();
  readonly searchTerm = input('');

  private readonly translate = inject(TranslateService);
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly notifications = inject(NotificationService);
  private readonly pathService = inject(PathService);
  private readonly jobService = inject(JobManagementService);
  protected readonly ops = inject(TransferOperationsService);

  readonly localStatusOverrides = signal<Map<string, { status: string; error?: string }>>(
    new Map()
  );
  readonly hiddenIds = signal<Set<string>>(new Set());
  readonly displayLimit = signal(50);

  readonly resolvingIds = signal<Set<string>>(new Set());

  protected readonly slicedItems = computed(() => {
    return this.filteredItems().slice(0, this.displayLimit());
  });

  constructor() {
    effect(() => {
      this.ops.preloadFeatures(this.transfers());
    });
  }

  findJobForItem(item: CompletedTransfer): JobInfo | null {
    const allJobs = this.jobService.jobs();
    const normalizedItemName = item.name.replace(/\\/g, '/');

    const matchingJobs = allJobs.filter(job => {
      // 1. Check if the job's source contains the item name
      if (Array.isArray(job.source)) {
        const matchesSource = job.source.some(src => {
          const normSrc = src.replace(/\\/g, '/');
          return (
            normSrc.endsWith('/' + normalizedItemName) || normSrc.endsWith(':' + normalizedItemName)
          );
        });
        if (matchesSource) return true;
      } else if (typeof job.source === 'string') {
        const normSrc = job.source.replace(/\\/g, '/');
        if (
          normSrc.endsWith('/' + normalizedItemName) ||
          normSrc.endsWith(':' + normalizedItemName)
        )
          return true;
      }

      // 2. Check if the job is currently transferring or has completed this file
      const stats = job.stats as GlobalStats | undefined;
      if (stats) {
        if (Array.isArray(stats.transferring)) {
          const matchesTransferring = stats.transferring.some((t: TransferFile) => {
            const normName = (t.name || '').replace(/\\/g, '/');
            return normName === normalizedItemName || normName.endsWith('/' + normalizedItemName);
          });
          if (matchesTransferring) return true;
        }
        if (Array.isArray(job.completed_transfers)) {
          const matchesCompleted = job.completed_transfers.some((t: CompletedTransfer) => {
            const normName = (t.name || '').replace(/\\/g, '/');
            return normName === normalizedItemName || normName.endsWith('/' + normalizedItemName);
          });
          if (matchesCompleted) return true;
        }
      }

      // 3. Fallback to matching by parent_job_id if the job is a child of this check job
      if (job.parent_job_id === item.jobid) {
        return true;
      }

      return false;
    });

    if (matchingJobs.length === 0) return null;

    // Return the latest job matching
    return matchingJobs.reduce((prev, curr) => (prev.jobid > curr.jobid ? prev : curr));
  }

  getResolveState(item: CompletedTransfer): {
    status: string;
    percentage: number;
    isPreparing: boolean;
    bytes: number;
    size: number;
    speed: number;
    speedClass: string;
    eta: number;
    error?: string;
  } | null {
    const job = this.findJobForItem(item);
    if (!job) return null;

    const normalizedItemName = item.name.replace(/\\/g, '/');
    let percentage = 0;
    let isPreparing = true;
    let bytes = 0;
    let size = 0;
    let speed = 0;
    let speedClass = 'speed-slow';
    let eta = 0;

    const stats = job.stats as GlobalStats | undefined;
    if (stats) {
      if (stats.totalBytes > 0) {
        percentage = Math.floor((stats.bytes / stats.totalBytes) * 100);
        isPreparing = false;
        bytes = stats.bytes || 0;
        size = stats.totalBytes || 0;
        speed = stats.speed || 0;
        eta = stats.eta || 0;
      } else if (stats.transferring && stats.transferring.length > 0) {
        const tf =
          stats.transferring.find((t: TransferFile) => {
            const normName = (t.name || '').replace(/\\/g, '/');
            return normName === normalizedItemName || normName.endsWith('/' + normalizedItemName);
          }) || stats.transferring[0];

        percentage = tf.percentage || 0;
        isPreparing = false;
        bytes = tf.bytes || 0;
        size = tf.size || 0;
        speed = tf.speed || 0;
        eta = tf.eta || 0;
      }

      if (speed > 1024 * 1024 * 5) {
        speedClass = 'speed-fast';
      } else if (speed > 1024 * 1024) {
        speedClass = 'speed-medium';
      }
    }

    return {
      status: job.status,
      percentage,
      isPreparing,
      bytes,
      size,
      speed,
      speedClass,
      eta,
      error: job.error,
    };
  }

  isResolving(item: EnrichedCheckResult): boolean {
    const uniqueId = item.uniqueId || `${item.jobid}-${item.name}`;
    if (this.resolvingIds().has(uniqueId)) return true;
    const state = this.getResolveState(item);
    return state?.status === 'Running';
  }

  // Enriched transfers with unique IDs and hiding mechanism
  readonly enrichedTransfers = computed<EnrichedCheckResult[]>(() => {
    const hidden = this.hiddenIds();
    const overrides = this.localStatusOverrides();

    return this.transfers()
      .map(t => {
        const uniqueId = `${t.jobid}-${t.name}`;
        let status = t.status;
        let error = t.error;
        let resolveStatus: string | undefined = undefined;
        let resolveError: string | undefined = undefined;
        let resolvePercentage = 0;
        let resolveIsPreparing = true;
        let resolveBytes = 0;
        let resolveSize = 0;
        let resolveSpeed = 0;
        let resolveSpeedClass = 'speed-slow';
        let resolveEta = 0;

        const resolveState = this.getResolveState(t);
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
          status = override.status as CompletedTransfer['status'];
          if (override.error !== undefined) {
            error = override.error;
          }
          resolveStatus = undefined; // Reset resolve status for manual status override
        }

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
        };
      })
      .filter(t => !hidden.has(t.uniqueId));
  });

  readonly filteredItems = computed(() => {
    const search = this.searchTerm().toLowerCase().trim();
    let items = this.enrichedTransfers();

    if (search) {
      items = items.filter(t => t.name.toLowerCase().includes(search));
    }

    return items;
  });

  getRowClass(item: EnrichedCheckResult): string {
    if (item.resolveStatus === 'Failed') return 'error';
    if (item.status === 'missing_dst') return 'missing-dst';
    if (item.status === 'missing_src') return 'missing-src';
    if (item.status === 'partial') return 'differ';
    if (item.status === 'failed') return 'error';
    return '';
  }

  getBadgeClass(item: EnrichedCheckResult): string {
    const status = item.status;
    if (status === 'missing_dst') return 'p-warn';
    if (status === 'missing_src') return 'p-warn';
    if (status === 'partial') return 'p-orange';
    if (status === 'checked') return 'p-accent';
    return 'p-warn';
  }

  getBadgeIcon(item: EnrichedCheckResult): string {
    const status = item.status;
    if (status === 'missing_dst') return 'circle-exclamation';
    if (status === 'missing_src') return 'circle-exclamation';
    if (status === 'partial') return 'circle-exclamation';
    if (status === 'checked') return 'circle-check';
    return 'circle-xmark';
  }

  getBadgeText(item: EnrichedCheckResult): string {
    const status = item.status;
    if (status === 'missing_dst') return 'shared.transferActivity.status.missingDst';
    if (status === 'missing_src') return 'shared.transferActivity.status.missingSrc';
    if (status === 'partial') return 'shared.transferActivity.status.differ';
    if (status === 'checked') return 'shared.transferActivity.status.checked';
    return 'shared.transferActivity.status.error';
  }

  getRelativeTime(timestamp: string): string {
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

  getResolveIcon(item: EnrichedCheckResult): string {
    if (item.status === 'missing_dst') return 'right-arrow';
    if (item.status === 'missing_src') return 'left-arrow';
    return 'sync';
  }

  getResolveTooltip(item: EnrichedCheckResult): string {
    if (item.status === 'missing_dst') return 'shared.transferActivity.actions.resolveToDst';
    if (item.status === 'missing_src') return 'shared.transferActivity.actions.resolveToSrc';
    return 'shared.transferActivity.actions.resolveOverwrite';
  }

  // Action: Resolve / Sync
  async onResolve(item: EnrichedCheckResult): Promise<void> {
    const uniqueId = item.uniqueId || '';
    this.resolvingIds.update(s => new Set(s).add(uniqueId));

    try {
      const srcFs = item.srcFs || '';
      const dstFs = item.dstFs || '';
      const path = item.name;

      if (item.status === 'missing_dst') {
        // Copy from source to destination
        await this.remoteOps.transferItems(
          [{ remote: srcFs, path, name: this.pathService.extractName(path), isDir: false }],
          dstFs,
          this.pathService.getParentPath(path),
          'copy',
          'dashboard'
        );
      } else if (item.status === 'missing_src') {
        // Copy from destination to source
        await this.remoteOps.transferItems(
          [{ remote: dstFs, path, name: this.pathService.extractName(path), isDir: false }],
          srcFs,
          this.pathService.getParentPath(path),
          'copy',
          'dashboard'
        );
      } else if (item.status === 'partial') {
        // Offer choices or overwrite destination by default
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
          'dashboard'
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
        next.delete(uniqueId);
        return next;
      });
    }
  }

  async onDeleteSource(item: EnrichedCheckResult): Promise<void> {
    const uniqueId = item.uniqueId || `${item.jobid}-${item.name}`;
    await this.ops.deleteSource(item, uniqueId, () => {
      const currentStatus = item.status;
      if (currentStatus === 'partial' || currentStatus === 'checked') {
        this.localStatusOverrides.update(m => {
          const next = new Map(m);
          next.set(uniqueId, { status: 'missing_src' });
          return next;
        });
      } else {
        this.hiddenIds.update(s => new Set(s).add(uniqueId));
      }
    });
  }

  async onDeleteDst(item: EnrichedCheckResult): Promise<void> {
    const uniqueId = item.uniqueId || `${item.jobid}-${item.name}`;
    await this.ops.deleteDst(item, uniqueId, () => {
      const currentStatus = item.status;
      if (currentStatus === 'partial' || currentStatus === 'checked') {
        this.localStatusOverrides.update(m => {
          const next = new Map(m);
          next.set(uniqueId, { status: 'missing_dst' });
          return next;
        });
      } else {
        this.hiddenIds.update(s => new Set(s).add(uniqueId));
      }
    });
  }

  async onDeleteFallback(item: EnrichedCheckResult): Promise<void> {
    const uniqueId = item.uniqueId || `${item.jobid}-${item.name}`;
    await this.ops.deleteFallback(item, uniqueId, this.config().remoteName, () => {
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
      const totalCount = this.filteredItems().length;
      if (currentLimit < totalCount) {
        this.displayLimit.set(Math.min(currentLimit + 50, totalCount));
      }
    }
  }
}
