import { Component, input, inject, ChangeDetectionStrategy, computed } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FormatFileSizePipe } from '../../pipes/format-file-size.pipe';
import { CompletedTransfer } from '@app/types';
import { toSignal } from '@angular/core/rxjs-interop';

@Component({
  selector: 'app-completed-transfers-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, MatTooltipModule, TranslateModule, FormatFileSizePipe],
  template: `
    <div class="card-list-container">
      @if (transfers().length > 0) {
        @for (transfer of enrichedTransfers(); track transfer.uniqueId) {
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
              <div class="card-info-right status-badge">
                <span class="app-pill" [class]="transfer.badgeClass" [matTooltip]="transfer.error">
                  <mat-icon [svgIcon]="transfer.badgeIcon"></mat-icon>
                  {{ transfer.badgeText | translate }}
                </span>
              </div>
            </div>

            @if (transfer.srcFs || transfer.dstFs) {
              <div class="card-paths">
                <code class="path-pill src">{{ transfer.srcFs || '?' }}</code>
                <mat-icon svgIcon="right-arrow" class="arrow-icon"></mat-icon>
                <code class="path-pill dst">{{ transfer.dstFs || '?' }}</code>
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
      } @else {
        <div class="empty-state">
          <mat-icon svgIcon="circle-check"></mat-icon>
          <span>{{ 'shared.transferActivity.empty.noRecent' | translate }}</span>
          <p>{{ 'shared.transferActivity.empty.recentHint' | translate }}</p>
        </div>
      }
    </div>
  `,
})
export class CompletedTransfersTableComponent {
  readonly transfers = input.required<CompletedTransfer[]>();

  private readonly translate = inject(TranslateService);
  private readonly lang = toSignal(this.translate.onLangChange, { initialValue: null });

  protected readonly enrichedTransfers = computed(() => {
    this.lang();

    return this.transfers().map(transfer => {
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
    });
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
}
