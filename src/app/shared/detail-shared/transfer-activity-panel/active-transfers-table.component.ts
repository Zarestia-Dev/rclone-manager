import {
  Component,
  input,
  inject,
  ChangeDetectionStrategy,
  computed,
  effect,
  untracked,
} from '@angular/core';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import { FormatFileSizePipe, FormatTimePipe } from '@app/pipes';
import { TransferFile } from '@app/types';
import { TransferOperationsService } from './transfer-operations.service';

@Component({
  selector: 'app-active-transfers-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [TransferOperationsService],
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
      @if (enrichedTransfers().length > 0) {
        @for (transfer of enrichedTransfers(); track transfer.uniqueId) {
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
                      transfer.error || ('shared.transferActivity.status.transferError' | translate)
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
                    formatFsName(transfer.srcFs) || '?'
                  }}</code>
                  @let canCopySrc = ops.canCopyUrlSource(transfer, jobType());
                  @let canDownloadSrc = ops.canDownloadSource(transfer, jobType());
                  @let hasSrcActions = canCopySrc || canDownloadSrc;
                  @if (hasSrcActions) {
                    <div class="path-actions">
                      @if (canCopySrc) {
                        @let loading =
                          ops.loadingUrlIds().has(transfer.uniqueId + '-src') ||
                          ops.isFeaturesLoading(transfer.srcFs);
                        <button
                          class="small-action-btn"
                          (click)="
                            ops.copyUrlSource(transfer, transfer.uniqueId); $event.stopPropagation()
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
                    </div>
                  }
                </div>

                <mat-icon svgIcon="right-arrow" class="arrow-icon"></mat-icon>

                <div class="path-group dst">
                  <code class="path-pill dst" [title]="transfer.dstFs">{{
                    formatFsName(transfer.dstFs) || '?'
                  }}</code>
                  @let canCopyDst = ops.canCopyUrlDst(transfer, jobType());
                  @let canDownloadDst = ops.canDownloadDst(transfer, jobType());
                  @let hasDstActions = canCopyDst || canDownloadDst;
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
                    </div>
                  }
                </div>
              </div>
            } @else if (remoteName()) {
              <div class="card-paths-v2">
                <div class="path-group dst">
                  <code class="path-pill dst" [title]="remoteName()">{{
                    formatFsName(remoteName())
                  }}</code>
                  @let canCopyFb = ops.canCopyUrlFallback(transfer, jobType(), remoteName());
                  @let canDownloadFb = ops.canDownloadFallback(transfer, jobType(), remoteName());
                  @let hasFbActions = canCopyFb || canDownloadFb;
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
                    </div>
                  }
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
                <span class="size-text"
                  >{{ transfer.bytes | formatFileSize }} /
                  {{ transfer.size | formatFileSize }}</span
                >
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
      } @else if (searchTerm()) {
        <div class="empty-state">
          <mat-icon svgIcon="search"></mat-icon>
          <span>{{ 'shared.search.title' | translate }}</span>
          <p>{{ 'shared.search.description' | translate }}</p>
        </div>
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

  protected readonly ops = inject(TransferOperationsService);

  protected formatFsName(fs?: string): string {
    if (!fs) return '';
    if (/^[a-zA-Z]:$/.test(fs)) {
      return fs;
    }
    return fs.endsWith(':') ? fs.slice(0, -1) : fs;
  }

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

  protected readonly enrichedTransfers = computed(() => {
    const search = this.searchTerm().toLowerCase().trim();
    const items = this.transfers();

    const filtered = search ? items.filter(t => t.name.toLowerCase().includes(search)) : items;

    return filtered.map(transfer => ({
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
}
