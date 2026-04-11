import { Component, input, inject, ChangeDetectionStrategy } from '@angular/core';
import { NgClass } from '@angular/common';
import { MatTableModule } from '@angular/material/table';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatChipsModule } from '@angular/material/chips';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FormatFileSizePipe } from '../../pipes/format-file-size.pipe';
import { CompletedTransfer } from '@app/types';

@Component({
  selector: 'app-completed-transfers-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgClass,
    MatTableModule,
    MatIconModule,
    MatTooltipModule,
    MatChipsModule,
    TranslateModule,
    FormatFileSizePipe,
  ],
  template: `
    <div class="transfer-table-container">
      @if (transfers().length > 0) {
        <table mat-table [dataSource]="transfers()" class="transfer-table">
          <ng-container matColumnDef="name">
            <th mat-header-cell *matHeaderCellDef>
              {{ 'shared.transferActivity.table.file' | translate }}
            </th>
            <td mat-cell *matCellDef="let transfer" class="name-cell">
              <div class="file-info">
                <mat-icon svgIcon="file" class="file-icon" [matTooltip]="transfer.name"></mat-icon>
                <span class="file-name" [title]="transfer.name">{{
                  getFileName(transfer.name)
                }}</span>
              </div>
            </td>
          </ng-container>

          <ng-container matColumnDef="status">
            <th mat-header-cell *matHeaderCellDef>
              {{ 'shared.transferActivity.table.status' | translate }}
            </th>
            <td mat-cell *matCellDef="let transfer" class="status-cell">
              @switch (transfer.status) {
                @case ('failed') {
                  <mat-chip class="status-chip error" [matTooltip]="transfer.error">
                    <span>
                      <mat-icon svgIcon="circle-exclamation" class="chip-icon"></mat-icon>
                      {{ 'shared.transferActivity.status.failed' | translate }}
                    </span>
                  </mat-chip>
                }
                @case ('checked') {
                  <mat-chip class="status-chip checked" [matTooltip]="transfer.error">
                    <span>
                      <mat-icon svgIcon="circle-check" class="chip-icon accent"></mat-icon>
                      {{ 'shared.transferActivity.status.checked' | translate }}
                    </span>
                  </mat-chip>
                }
                @case ('partial') {
                  <mat-chip class="status-chip partial" [matTooltip]="transfer.error">
                    <span>
                      <mat-icon svgIcon="circle-exclamation" class="chip-icon warn"></mat-icon>
                      {{ 'shared.transferActivity.status.partial' | translate }}
                    </span>
                  </mat-chip>
                }
                @default {
                  <mat-chip class="status-chip success" [matTooltip]="transfer.error">
                    <span>
                      <mat-icon svgIcon="circle-check" class="chip-icon accent"></mat-icon>
                      {{ 'shared.transferActivity.status.completed' | translate }}
                    </span>
                  </mat-chip>
                }
              }
            </td>
          </ng-container>

          <ng-container matColumnDef="size">
            <th mat-header-cell *matHeaderCellDef>
              {{ 'shared.transferActivity.table.size' | translate }}
            </th>
            <td mat-cell *matCellDef="let transfer" class="size-cell">
              <div class="size-info">
                <span class="size-value">{{ transfer.size | formatFileSize }}</span>
                @if (transfer.bytes !== transfer.size && transfer.bytes > 0) {
                  <span class="size-transferred"
                    >({{
                      'shared.transferActivity.table.transferred'
                        | translate: { bytes: (transfer.bytes | formatFileSize) }
                    }})</span
                  >
                }
                @if (transfer.status === 'checked' && transfer.size > 0) {
                  <span class="size-note"
                    >({{ 'shared.transferActivity.table.alreadyExisted' | translate }})</span
                  >
                }
              </div>
            </td>
          </ng-container>

          <ng-container matColumnDef="path">
            <th mat-header-cell *matHeaderCellDef>
              {{ 'shared.transferActivity.table.path' | translate }}
            </th>
            <td mat-cell *matCellDef="let transfer" class="path-cell">
              <div class="path-info">
                @if (transfer.srcFs && transfer.dstFs) {
                  <span
                    class="src"
                    [matTooltip]="
                      'shared.transferActivity.table.source' | translate: { path: transfer.srcFs }
                    "
                    >{{ transfer.srcFs }}</span
                  >
                  <mat-icon svgIcon="right-arrow" class="arrow-icon"></mat-icon>
                  <span
                    class="dst"
                    [matTooltip]="
                      'shared.transferActivity.table.destination'
                        | translate: { path: transfer.dstFs }
                    "
                    >{{ transfer.dstFs }}</span
                  >
                } @else {
                  <span class="no-path">-</span>
                }
              </div>
            </td>
          </ng-container>

          <ng-container matColumnDef="time">
            <th mat-header-cell *matHeaderCellDef>
              {{ 'shared.transferActivity.table.completed' | translate }}
            </th>
            <td mat-cell *matCellDef="let transfer" class="time-cell">
              <div class="time-info">
                @if (transfer.completedAt) {
                  <span class="time-relative">{{ getRelativeTime(transfer.completedAt) }}</span>
                } @else {
                  <span class="time-value">-</span>
                }
                @if (
                  transfer.startedAt && transfer.completedAt && transfer.status === 'completed'
                ) {
                  <span class="duration">{{
                    getDuration(transfer.startedAt, transfer.completedAt)
                  }}</span>
                }
              </div>
            </td>
          </ng-container>

          <tr mat-header-row *matHeaderRowDef="displayedColumns; sticky: true"></tr>
          <tr
            mat-row
            *matRowDef="let row; columns: displayedColumns"
            class="transfer-row"
            [ngClass]="{
              error: row.status === 'failed',
              checked: row.status === 'checked',
              partial: row.status === 'partial',
              success: row.status === 'completed',
            }"
          ></tr>
        </table>
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

  readonly displayedColumns = ['name', 'status', 'size', 'path', 'time'];

  getFileName(path: string): string {
    return path.split('/').pop() ?? path;
  }

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
