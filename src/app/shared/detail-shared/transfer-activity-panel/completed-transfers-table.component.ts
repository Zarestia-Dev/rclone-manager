import { Component, input, inject, ChangeDetectionStrategy, computed } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FormatFileSizePipe } from '../../pipes/format-file-size.pipe';
import { CompletedTransfer } from '@app/types';

@Component({
  selector: 'app-completed-transfers-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, MatTooltipModule, TranslateModule, FormatFileSizePipe],
  template: `
    <div class="transfer-table-container">
      @if (transfers().length > 0) {
        <div class="transfer-list">
          @for (transfer of enrichedTransfers(); track transfer.uniqueId) {
            <div
              class="transfer-row-item completed-item"
              [class.error]="transfer.status === 'failed'"
              [class.checked]="transfer.status === 'checked'"
              [class.partial]="transfer.status === 'partial'"
              [class.success]="transfer.status === 'completed'"
            >
              <!-- Header Row -->
              <div class="transfer-header">
                <div class="file-info">
                  <mat-icon
                    svgIcon="file"
                    class="file-icon"
                    [matTooltip]="transfer.name"
                  ></mat-icon>
                  <span class="file-name" [title]="transfer.name">{{ transfer.name }}</span>
                </div>
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

              <!-- Path Display (srcFs -> dstFs) -->
              @if (transfer.srcFs || transfer.dstFs) {
                <div class="transfer-paths">
                  <code class="path-pill src">
                    {{ transfer.srcFs || '?' }}
                  </code>
                  <mat-icon svgIcon="right-arrow" class="arrow-icon"></mat-icon>
                  <code class="path-pill dst">
                    {{ transfer.dstFs || '?' }}
                  </code>
                </div>
              }

              <!-- Footer Stats -->
              <div class="transfer-footer">
                <div class="stats-left">
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
                <div class="stats-right">
                  @if (transfer.completedAt) {
                    <span class="time-text">
                      {{ transfer.relativeTime }}
                    </span>
                  }
                  @if (transfer.duration) {
                    <span class="duration-badge">{{ transfer.duration }}</span>
                  }
                </div>
              </div>
            </div>
          }
        </div>
      } @else {
        <div class="empty-state">
          <mat-icon svgIcon="circle-check" class="placeholder-icon"></mat-icon>
          <span>{{ 'shared.transferActivity.empty.noRecent' | translate }}</span>
          <p>{{ 'shared.transferActivity.empty.recentHint' | translate }}</p>
        </div>
      }
    </div>
  `,
  styleUrls: ['./transfer-tables.scss'],
})
export class CompletedTransfersTableComponent {
  readonly transfers = input.required<CompletedTransfer[]>();

  private readonly translate = inject(TranslateService);
  private readonly lang = toSignal(this.translate.onLangChange, { initialValue: null });

  protected readonly enrichedTransfers = computed(() => {
    this.lang();

    return this.transfers().map(transfer => {
      const relativeTime = transfer.completedAt ? this.getRelativeTime(transfer.completedAt) : '';
      const duration =
        transfer.startedAt && transfer.completedAt && transfer.status === 'completed'
          ? this.getDuration(transfer.startedAt, transfer.completedAt)
          : '';

      let badgeClass = 'p-primary';
      let badgeIcon = 'circle-check';
      let badgeText = 'shared.transferActivity.status.completed';

      if (transfer.status === 'failed') {
        badgeClass = 'p-warn';
        badgeIcon = 'circle-exclamation';
        badgeText = 'shared.transferActivity.status.failed';
      } else if (transfer.status === 'checked') {
        badgeClass = 'p-accent';
        badgeIcon = 'circle-check';
        badgeText = 'shared.transferActivity.status.checked';
      } else if (transfer.status === 'partial') {
        badgeClass = 'p-orange';
        badgeIcon = 'circle-exclamation';
        badgeText = 'shared.transferActivity.status.partial';
      }

      return {
        ...transfer,
        relativeTime,
        duration,
        badgeClass,
        badgeIcon,
        badgeText,
        uniqueId: `${transfer.jobid}-${transfer.name}`,
      };
    });
  });

  private getRelativeTime(timestamp: string): string {
    const diff = Date.now() - new Date(timestamp).getTime();
    const minutes = Math.floor(diff / 60_000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0)
      return this.translate.instant('shared.transferActivity.time.daysAgo', { count: days });
    if (hours > 0)
      return this.translate.instant('shared.transferActivity.time.hoursAgo', { count: hours });
    if (minutes > 0)
      return this.translate.instant('shared.transferActivity.time.minutesAgo', { count: minutes });
    return this.translate.instant('shared.transferActivity.time.justNow');
  }

  private getDuration(startedAt: string, completedAt: string): string {
    const diff = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    if (diff < 1000)
      return this.translate.instant('shared.transferActivity.time.duration.lessThanSecond');

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0)
      return this.translate.instant('shared.transferActivity.time.duration.hours', {
        hours,
        minutes: minutes % 60,
      });
    if (minutes > 0)
      return this.translate.instant('shared.transferActivity.time.duration.minutes', {
        minutes,
        seconds: seconds % 60,
      });
    return this.translate.instant('shared.transferActivity.time.duration.seconds', { seconds });
  }
}
