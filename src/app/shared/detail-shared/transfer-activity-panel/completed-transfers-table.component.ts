import { Component, input, inject, ChangeDetectionStrategy } from '@angular/core';
import { NgClass } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FormatFileSizePipe } from '../../pipes/format-file-size.pipe';
import { CompletedTransfer } from '@app/types';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';

@Component({
  selector: 'app-completed-transfers-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgClass, MatIconModule, MatTooltipModule, TranslateModule, FormatFileSizePipe],
  template: `
    <div class="transfer-table-container">
      @if (transfers().length > 0) {
        <div class="transfer-list">
          @for (transfer of transfers(); track $index) {
            <div
              class="transfer-row-item completed-item"
              [ngClass]="{
                error: transfer.status === 'failed',
                checked: transfer.status === 'checked',
                partial: transfer.status === 'partial',
                success: transfer.status === 'completed',
              }"
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
                  @switch (transfer.status) {
                    @case ('failed') {
                      <span class="app-pill p-warn" [matTooltip]="transfer.error">
                        <mat-icon svgIcon="circle-exclamation"></mat-icon>
                        {{ 'shared.transferActivity.status.failed' | translate }}
                      </span>
                    }
                    @case ('checked') {
                      <span class="app-pill p-accent" [matTooltip]="transfer.error">
                        <mat-icon svgIcon="circle-check"></mat-icon>
                        {{ 'shared.transferActivity.status.checked' | translate }}
                      </span>
                    }
                    @case ('partial') {
                      <span class="app-pill p-orange" [matTooltip]="transfer.error">
                        <mat-icon svgIcon="circle-exclamation"></mat-icon>
                        {{ 'shared.transferActivity.status.partial' | translate }}
                      </span>
                    }
                    @default {
                      <span class="app-pill p-primary" [matTooltip]="transfer.error">
                        <mat-icon svgIcon="circle-check"></mat-icon>
                        {{ 'shared.transferActivity.status.completed' | translate }}
                      </span>
                    }
                  }
                </div>
              </div>

              <!-- Path Display (srcFs -> dstFs) -->
              @if (transfer.srcFs || transfer.dstFs) {
                <div class="transfer-paths">
                  <span class="path-pill src">
                    {{ transfer.srcFs || '?' }}
                  </span>
                  <mat-icon svgIcon="right-arrow" class="arrow-icon"></mat-icon>
                  <span class="path-pill dst">
                    {{ transfer.dstFs || '?' }}
                  </span>
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
                      {{ getRelativeTime(transfer.completedAt) }}
                    </span>
                  }
                  @if (
                    transfer.startedAt && transfer.completedAt && transfer.status === 'completed'
                  ) {
                    <span class="duration-badge">{{
                      getDuration(transfer.startedAt, transfer.completedAt)
                    }}</span>
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

  protected readonly pathService = inject(PathService);
  private readonly translate = inject(TranslateService);

  getRelativeTime(timestamp: string): string {
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

  getDuration(startedAt: string, completedAt: string): string {
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
