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
import { CompletedTransfer, TransferActivityPanelConfig } from '@app/types';
import { FormatFileSizePipe, FormatTimePipe } from '@app/pipes';
import { CopyToClipboardDirective } from '../../directives/copy-to-clipboard.directive';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { isHeadlessMode } from 'src/app/services/infrastructure/platform/api-client.service';
import { FileViewerService } from 'src/app/services/ui/file-viewer.service';
import { JobManagementService } from 'src/app/services/operations/job-management.service';

@Component({
  selector: 'app-check-results-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
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
                    @if (getEffectiveStatus(item) !== 'checked') {
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
                        @if (canCopyUrlSource(item)) {
                          <button
                            class="small-action-btn"
                            (click)="onCopyUrlSource(item); $event.stopPropagation()"
                            [disabled]="
                              loadingUrlIds().has(item.uniqueId + '-src') ||
                              isFeaturesLoading(item.srcFs)
                            "
                            [matTooltip]="'shared.transferActivity.actions.copyUrl' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                loadingUrlIds().has(item.uniqueId + '-src') ||
                                isFeaturesLoading(item.srcFs)
                                  ? 'refresh'
                                  : 'link'
                              "
                              [class.animate-spin]="
                                loadingUrlIds().has(item.uniqueId + '-src') ||
                                isFeaturesLoading(item.srcFs)
                              "
                            ></mat-icon>
                          </button>
                        }
                        @if (canDownloadSource(item)) {
                          <button
                            class="small-action-btn"
                            (click)="onDownloadSource(item); $event.stopPropagation()"
                            [disabled]="downloadingIds().has(item.uniqueId + '-src')"
                            [matTooltip]="'shared.transferActivity.actions.download' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                downloadingIds().has(item.uniqueId + '-src')
                                  ? 'refresh'
                                  : 'download'
                              "
                              [class.animate-spin]="downloadingIds().has(item.uniqueId + '-src')"
                            ></mat-icon>
                          </button>
                        }
                        @if (canDeleteSource(item)) {
                          <button
                            class="small-action-btn delete-btn"
                            (click)="onDeleteSource(item); $event.stopPropagation()"
                            [disabled]="deletingIds().has(item.uniqueId + '-src-del')"
                            [matTooltip]="'common.delete' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                deletingIds().has(item.uniqueId + '-src-del') ? 'refresh' : 'trash'
                              "
                              [class.animate-spin]="deletingIds().has(item.uniqueId + '-src-del')"
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
                        @if (canCopyUrlDst(item)) {
                          <button
                            class="small-action-btn"
                            (click)="onCopyUrlDst(item); $event.stopPropagation()"
                            [disabled]="
                              loadingUrlIds().has(item.uniqueId + '-dst') ||
                              isFeaturesLoading(item.dstFs)
                            "
                            [matTooltip]="'shared.transferActivity.actions.copyUrl' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                loadingUrlIds().has(item.uniqueId + '-dst') ||
                                isFeaturesLoading(item.dstFs)
                                  ? 'refresh'
                                  : 'link'
                              "
                              [class.animate-spin]="
                                loadingUrlIds().has(item.uniqueId + '-dst') ||
                                isFeaturesLoading(item.dstFs)
                              "
                            ></mat-icon>
                          </button>
                        }
                        @if (canDownloadDst(item)) {
                          <button
                            class="small-action-btn"
                            (click)="onDownloadDst(item); $event.stopPropagation()"
                            [disabled]="downloadingIds().has(item.uniqueId + '-dst')"
                            [matTooltip]="'shared.transferActivity.actions.download' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                downloadingIds().has(item.uniqueId + '-dst')
                                  ? 'refresh'
                                  : 'download'
                              "
                              [class.animate-spin]="downloadingIds().has(item.uniqueId + '-dst')"
                            ></mat-icon>
                          </button>
                        }
                        @if (canDeleteDst(item)) {
                          <button
                            class="small-action-btn delete-btn"
                            (click)="onDeleteDst(item); $event.stopPropagation()"
                            [disabled]="deletingIds().has(item.uniqueId + '-dst-del')"
                            [matTooltip]="'common.delete' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                deletingIds().has(item.uniqueId + '-dst-del') ? 'refresh' : 'trash'
                              "
                              [class.animate-spin]="deletingIds().has(item.uniqueId + '-dst-del')"
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
                        @if (canCopyUrlFallback(item)) {
                          <button
                            class="small-action-btn"
                            (click)="onCopyUrlFallback(item); $event.stopPropagation()"
                            [disabled]="
                              loadingUrlIds().has(item.uniqueId + '-fallback') ||
                              isFallbackFeaturesLoading()
                            "
                            [matTooltip]="'shared.transferActivity.actions.copyUrl' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                loadingUrlIds().has(item.uniqueId + '-fallback') ||
                                isFallbackFeaturesLoading()
                                  ? 'refresh'
                                  : 'link'
                              "
                              [class.animate-spin]="
                                loadingUrlIds().has(item.uniqueId + '-fallback') ||
                                isFallbackFeaturesLoading()
                              "
                            ></mat-icon>
                          </button>
                        }
                        @if (canDownloadFallback(item)) {
                          <button
                            class="small-action-btn"
                            (click)="onDownloadFallback(item); $event.stopPropagation()"
                            [disabled]="downloadingIds().has(item.uniqueId + '-fallback')"
                            [matTooltip]="'shared.transferActivity.actions.download' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                downloadingIds().has(item.uniqueId + '-fallback')
                                  ? 'refresh'
                                  : 'download'
                              "
                              [class.animate-spin]="
                                downloadingIds().has(item.uniqueId + '-fallback')
                              "
                            ></mat-icon>
                          </button>
                        }
                        @if (canDeleteFallback(item)) {
                          <button
                            class="small-action-btn delete-btn"
                            (click)="onDeleteFallback(item); $event.stopPropagation()"
                            [disabled]="deletingIds().has(item.uniqueId + '-fallback-del')"
                            [matTooltip]="'common.delete' | translate"
                          >
                            <mat-icon
                              [svgIcon]="
                                deletingIds().has(item.uniqueId + '-fallback-del')
                                  ? 'refresh'
                                  : 'trash'
                              "
                              [class.animate-spin]="
                                deletingIds().has(item.uniqueId + '-fallback-del')
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
                      @if (item.resolveSpeed > 0) {
                        <span class="speed-text">
                          <span class="speed-dot" [class]="item.resolveSpeedClass"></span>
                          {{ item.resolveSpeed | formatFileSize }}/s
                        </span>
                      }
                      @if (item.resolveEta > 0) {
                        <span class="eta-text"> ETA: {{ item.resolveEta | formatTime }} </span>
                      }
                    </div>
                  } @else {
                    <div class="card-footer-left">
                      <span
                        [class]="'app-pill ' + getBadgeClass(item)"
                        [matTooltip]="getEffectiveError(item)"
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

  private readonly translate = inject(TranslateService);
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly notifications = inject(NotificationService);
  private readonly pathService = inject(PathService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly fileViewerService = inject(FileViewerService);
  private readonly remoteManagement = inject(RemoteManagementService);

  readonly searchTerm = input('');

  private readonly jobService = inject(JobManagementService);

  readonly activeResolveJobs = signal<Map<string, number>>(new Map());

  readonly resolveJobStates = computed(() => {
    const activeMap = this.activeResolveJobs();
    const allJobs = this.jobService.jobs();
    const result = new Map<
      string,
      {
        status: string;
        percentage: number;
        isPreparing: boolean;
        bytes: number;
        size: number;
        speed: number;
        speedClass: string;
        eta: number;
        error?: string;
      }
    >();

    // 1. Map active resolve jobs started in this session
    const jobMap = new Map(allJobs.map(j => [j.jobid, j]));
    for (const [uniqueId, jobId] of activeMap.entries()) {
      const job = jobMap.get(jobId);
      if (job) {
        let percentage = 0;
        let isPreparing = true;
        let bytes = 0;
        let size = 0;
        let speed = 0;
        let speedClass = 'speed-slow';
        let eta = 0;

        if (job.stats) {
          if (job.stats.totalBytes > 0) {
            percentage = Math.floor((job.stats.bytes / job.stats.totalBytes) * 100);
            isPreparing = false;
            bytes = job.stats.bytes || 0;
            size = job.stats.totalBytes || 0;
            speed = job.stats.speed || 0;
            eta = job.stats.eta || 0;
          } else if (job.stats.transferring && job.stats.transferring.length > 0) {
            const tf = job.stats.transferring[0];
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

        result.set(uniqueId, {
          status: job.status,
          percentage,
          isPreparing,
          bytes,
          size,
          speed,
          speedClass,
          eta,
          error: job.error,
        });
      } else {
        result.set(uniqueId, {
          status: 'Running',
          percentage: 0,
          isPreparing: true,
          bytes: 0,
          size: 0,
          speed: 0,
          speedClass: 'speed-slow',
          eta: 0,
        });
      }
    }

    // 2. Scan all jobs to find past/present sub-jobs belonging to this check job and match by name (enables tracking persistence after page reloads)
    const transfersList = this.transfers();
    if (transfersList.length === 0) return result;

    const parentJobId = transfersList[0].jobid;
    const subJobs = allJobs.filter(j => j.parent_job_id === parentJobId);

    for (const item of transfersList) {
      const uniqueId = `${item.jobid}-${item.name}`;

      const matchingJobs = subJobs.filter(subJob => {
        if (!Array.isArray(subJob.source)) return false;
        return subJob.source.some(src => {
          const normalizedSrc = src.replace(/\\/g, '/');
          const normalizedName = item.name.replace(/\\/g, '/');
          return (
            normalizedSrc.endsWith('/' + normalizedName) ||
            normalizedSrc.endsWith(':' + normalizedName)
          );
        });
      });

      const matchingJob =
        matchingJobs.length > 0
          ? matchingJobs.reduce((prev, curr) => (prev.jobid > curr.jobid ? prev : curr))
          : null;

      if (matchingJob) {
        let percentage = 0;
        let isPreparing = true;
        let bytes = 0;
        let size = 0;
        let speed = 0;
        let speedClass = 'speed-slow';
        let eta = 0;

        if (matchingJob.stats) {
          if (matchingJob.stats.totalBytes > 0) {
            percentage = Math.floor((matchingJob.stats.bytes / matchingJob.stats.totalBytes) * 100);
            isPreparing = false;
            bytes = matchingJob.stats.bytes || 0;
            size = matchingJob.stats.totalBytes || 0;
            speed = matchingJob.stats.speed || 0;
            eta = matchingJob.stats.eta || 0;
          } else if (matchingJob.stats.transferring && matchingJob.stats.transferring.length > 0) {
            const tf = matchingJob.stats.transferring[0];
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

        result.set(uniqueId, {
          status: matchingJob.status,
          percentage,
          isPreparing,
          bytes,
          size,
          speed,
          speedClass,
          eta,
          error: matchingJob.error,
        });
      }
    }

    return result;
  });

  isResolving(item: CompletedTransfer): boolean {
    const uniqueId = item.uniqueId || `${item.jobid}-${item.name}`;
    if (this.resolvingIds().has(uniqueId)) return true;
    return this.resolveJobStates().get(uniqueId)?.status === 'Running';
  }

  readonly resolvingIds = signal<Set<string>>(new Set());
  readonly loadingUrlIds = signal<Set<string>>(new Set());
  readonly downloadingIds = signal<Set<string>>(new Set());
  readonly deletingIds = signal<Set<string>>(new Set());
  readonly localStatusOverrides = signal<Map<string, { status: string; error?: string }>>(
    new Map()
  );
  readonly hiddenIds = signal<Set<string>>(new Set());
  readonly displayLimit = signal(50);

  protected readonly slicedItems = computed(() => {
    return this.filteredItems().slice(0, this.displayLimit());
  });

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

  // Enriched transfers with unique IDs and hiding mechanism
  readonly enrichedTransfers = computed(() => {
    const hidden = this.hiddenIds();
    const resolveStates = this.resolveJobStates();
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

        const resolveState = resolveStates.get(uniqueId);
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

        const override = overrides.get(uniqueId);
        if (override) {
          status = override.status as any;
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

  getEffectiveStatus(item: CompletedTransfer): string {
    if (item.resolveStatus === 'Completed') return 'checked';
    if (item.resolveStatus === 'Failed') return 'failed';
    return item.status;
  }

  getEffectiveError(item: CompletedTransfer): string {
    return item.resolveError || item.error || '';
  }

  getRowClass(item: CompletedTransfer): string {
    if (item.resolveStatus === 'Failed') return 'error';
    if (item.status === 'missing_dst') return 'missing-dst';
    if (item.status === 'missing_src') return 'missing-src';
    if (item.status === 'partial') return 'differ';
    if (item.status === 'failed') return 'error';
    return '';
  }

  getBadgeClass(item: CompletedTransfer): string {
    const status = this.getEffectiveStatus(item);
    if (status === 'missing_dst') return 'p-warn';
    if (status === 'missing_src') return 'p-warn';
    if (status === 'partial') return 'p-orange';
    if (status === 'checked') return 'p-accent';
    return 'p-warn';
  }

  getBadgeIcon(item: CompletedTransfer): string {
    const status = this.getEffectiveStatus(item);
    if (status === 'missing_dst') return 'circle-exclamation';
    if (status === 'missing_src') return 'circle-exclamation';
    if (status === 'partial') return 'circle-exclamation';
    if (status === 'checked') return 'circle-check';
    return 'circle-xmark';
  }

  getBadgeText(item: CompletedTransfer): string {
    const status = this.getEffectiveStatus(item);
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

  isFeaturesLoading(fs: string | undefined): boolean {
    const remote = this.getRemoteName(fs || '');
    if (!remote) return false;
    return !!this.remoteManagement.getFeaturesSignal(remote)().loading;
  }

  isFallbackFeaturesLoading(): boolean {
    const remote = this.config().remoteName;
    if (!remote) return false;
    const fallback = this.pathService.normalizeRemoteName(remote);
    if (!fallback) return false;
    return !!this.remoteManagement.getFeaturesSignal(fallback)().loading;
  }

  canCopyUrlSource(item: CompletedTransfer): boolean {
    const isCompleted = item.resolveStatus === 'Completed';
    if (!isCompleted && (item.status === 'missing_src' || item.status === 'failed')) return false;

    const srcRemote = this.getRemoteName(item.srcFs || '');
    if (!srcRemote) return false;
    const feats = this.remoteManagement.getFeaturesSignal(srcRemote)();
    return feats.PublicLink || !!feats.loading;
  }

  canCopyUrlDst(item: CompletedTransfer): boolean {
    const isCompleted = item.resolveStatus === 'Completed';
    if (!isCompleted && (item.status === 'missing_dst' || item.status === 'failed')) return false;

    const dstRemote = this.getRemoteName(item.dstFs || '');
    if (!dstRemote) return false;
    const feats = this.remoteManagement.getFeaturesSignal(dstRemote)();
    return feats.PublicLink || !!feats.loading;
  }

  canCopyUrlFallback(item: CompletedTransfer): boolean {
    const remote = this.config().remoteName;
    if (!remote) return false;
    const isCompleted = item.resolveStatus === 'Completed';
    if (!isCompleted && item.status === 'failed') return false;

    const fallback = this.pathService.normalizeRemoteName(remote);
    if (!fallback) return false;
    const feats = this.remoteManagement.getFeaturesSignal(fallback)();
    return feats.PublicLink || !!feats.loading;
  }

  canDownloadSource(item: CompletedTransfer): boolean {
    const isCompleted = item.resolveStatus === 'Completed';
    if (!isCompleted && (item.status === 'missing_src' || item.status === 'failed')) return false;

    const srcRemote = this.getRemoteName(item.srcFs || '');
    return !!srcRemote;
  }

  canDownloadDst(item: CompletedTransfer): boolean {
    const isCompleted = item.resolveStatus === 'Completed';
    if (!isCompleted && (item.status === 'missing_dst' || item.status === 'failed')) return false;

    const dstRemote = this.getRemoteName(item.dstFs || '');
    return !!dstRemote;
  }

  canDownloadFallback(item: CompletedTransfer): boolean {
    const remote = this.config().remoteName;
    if (!remote) return false;
    const isCompleted = item.resolveStatus === 'Completed';
    if (!isCompleted && item.status === 'failed') return false;

    const fallback = this.pathService.normalizeRemoteForRclone(remote);
    return !this.pathService.isLocalPath(fallback);
  }

  canDeleteSource(item: CompletedTransfer): boolean {
    if (this.isResolving(item)) return false;
    const isCompleted = item.resolveStatus === 'Completed';
    if (!isCompleted && (item.status === 'missing_src' || item.status === 'failed')) return false;
    return !!item.srcFs;
  }

  canDeleteDst(item: CompletedTransfer): boolean {
    if (this.isResolving(item)) return false;
    const isCompleted = item.resolveStatus === 'Completed';
    if (!isCompleted && (item.status === 'missing_dst' || item.status === 'failed')) return false;
    return !!item.dstFs;
  }

  canDeleteFallback(item: CompletedTransfer): boolean {
    if (this.isResolving(item)) return false;
    const remote = this.config().remoteName;
    if (!remote) return false;
    const isCompleted = item.resolveStatus === 'Completed';
    if (!isCompleted && item.status === 'failed') return false;
    return true;
  }

  getResolveIcon(item: CompletedTransfer): string {
    if (item.status === 'missing_dst') return 'right-arrow';
    if (item.status === 'missing_src') return 'left-arrow';
    return 'sync';
  }

  getResolveTooltip(item: CompletedTransfer): string {
    if (item.status === 'missing_dst') return 'shared.transferActivity.actions.resolveToDst';
    if (item.status === 'missing_src') return 'shared.transferActivity.actions.resolveToSrc';
    return 'shared.transferActivity.actions.resolveOverwrite';
  }

  // Action: Resolve / Sync
  async onResolve(item: CompletedTransfer): Promise<void> {
    const uniqueId = item.uniqueId || '';
    this.resolvingIds.update(s => new Set(s).add(uniqueId));

    try {
      const srcFs = item.srcFs || '';
      const dstFs = item.dstFs || '';
      const path = item.name;
      let jobIdStr = '';

      if (item.status === 'missing_dst') {
        // Copy from source to destination
        jobIdStr = await this.remoteOps.transferItems(
          [{ remote: srcFs, path, name: this.pathService.extractName(path), isDir: false }],
          dstFs,
          this.pathService.getParentPath(path),
          'copy',
          'dashboard',
          undefined,
          item.jobid
        );
      } else if (item.status === 'missing_src') {
        // Copy from destination to source
        jobIdStr = await this.remoteOps.transferItems(
          [{ remote: dstFs, path, name: this.pathService.extractName(path), isDir: false }],
          srcFs,
          this.pathService.getParentPath(path),
          'copy',
          'dashboard',
          undefined,
          item.jobid
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

        jobIdStr = await this.remoteOps.transferItems(
          [{ remote: srcFs, path, name: this.pathService.extractName(path), isDir: false }],
          dstFs,
          this.pathService.getParentPath(path),
          'copy',
          'dashboard',
          undefined,
          item.jobid
        );
      }

      const jobId = parseInt(jobIdStr, 10);
      if (!isNaN(jobId)) {
        this.activeResolveJobs.update(m => {
          const next = new Map(m);
          next.set(uniqueId, jobId);
          return next;
        });
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
      const remote = this.config().remoteName;
      const fallback = this.pathService.normalizeRemoteForRclone(remote);
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
      const remote = this.config().remoteName;
      const fallback = this.pathService.normalizeRemoteForRclone(remote);
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

  async onDeleteSource(item: CompletedTransfer): Promise<void> {
    const uniqueId = `${item.uniqueId || `${item.jobid}-${item.name}`}-src-del`;
    const remote = item.srcFs || '';
    if (!remote) return;
    await this.confirmAndDelete(item, remote, uniqueId, true);
  }

  async onDeleteDst(item: CompletedTransfer): Promise<void> {
    const uniqueId = `${item.uniqueId || `${item.jobid}-${item.name}`}-dst-del`;
    const remote = item.dstFs || '';
    if (!remote) return;
    await this.confirmAndDelete(item, remote, uniqueId, false);
  }

  async onDeleteFallback(item: CompletedTransfer): Promise<void> {
    const uniqueId = `${item.uniqueId || `${item.jobid}-${item.name}`}-fallback-del`;
    const remote = this.pathService.normalizeRemoteForRclone(this.config().remoteName);
    await this.confirmAndDelete(item, remote, uniqueId, false);
  }

  private async confirmAndDelete(
    item: CompletedTransfer,
    remote: string,
    uniqueId: string,
    isSource: boolean
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

      const uniqueKey = item.uniqueId || `${item.jobid}-${item.name}`;
      const currentStatus = this.getEffectiveStatus(item);

      if (currentStatus === 'partial' || currentStatus === 'checked') {
        const nextStatus = isSource ? 'missing_src' : 'missing_dst';
        this.localStatusOverrides.update(m => {
          const next = new Map(m);
          next.set(uniqueKey, { status: nextStatus });
          return next;
        });
      } else {
        this.hiddenIds.update(s => new Set(s).add(uniqueKey));
      }
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
      const totalCount = this.filteredItems().length;
      if (currentLimit < totalCount) {
        this.displayLimit.set(Math.min(currentLimit + 50, totalCount));
      }
    }
  }
}
