import { Component, input, ChangeDetectionStrategy } from '@angular/core';
import { NgClass } from '@angular/common';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { FormatFileSizePipe } from '../../pipes/format-file-size.pipe';
import { FormatTimePipe } from '../../pipes/format-time.pipe';
import { TransferFile } from '@app/types';
import { inject } from '@angular/core';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';

@Component({
  selector: 'app-active-transfers-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgClass,
    MatProgressBarModule,
    MatIconModule,
    MatTooltipModule,
    TranslateModule,
    FormatFileSizePipe,
    FormatTimePipe,
  ],
  template: `
    <div class="transfer-table-container">
      @if (transfers().length > 0) {
        <div class="transfer-list">
          @for (transfer of transfers(); track trackByName($index, transfer)) {
            <div class="transfer-row-item">
              <!-- Header Row: Icon, File Name, and Percentage -->
              <div class="transfer-header">
                <div class="file-info">
                  <mat-icon
                    svgIcon="file"
                    class="file-icon"
                    [matTooltip]="transfer.name"
                  ></mat-icon>
                  <span class="file-name" [title]="transfer.name">{{ transfer.name }}</span>
                  @if (transfer.isError) {
                    <mat-icon
                      svgIcon="circle-exclamation"
                      class="error-badge-icon warn"
                      [matTooltip]="
                        transfer.error ||
                        ('shared.transferActivity.status.transferError' | translate)
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
                <div class="progress-badge">
                  @if (isPreparing(transfer.percentage)) {
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

              <!-- Path Display (srcFs -> dstFs) -->
              @if (transfer.srcFs || transfer.dstFs) {
                <div class="transfer-paths">
                  <span class="path-pill src">
                    {{ transfer.srcFs || '?' }}
                  </span>
                  <mat-icon svgIcon="right-arrow" class="arrow-icon"></mat-icon>
                  <span class="path-badge dst">
                    {{ transfer.dstFs || '?' }}
                  </span>
                </div>
              }

              <!-- Progress Bar -->
              <div class="transfer-progress">
                <mat-progress-bar
                  [mode]="isPreparing(transfer.percentage) ? 'indeterminate' : 'determinate'"
                  [value]="isPreparing(transfer.percentage) ? 0 : transfer.percentage"
                ></mat-progress-bar>
              </div>

              <!-- Stats Footer -->
              <div class="transfer-footer">
                <div class="stats-left">
                  <span class="size-text">
                    {{ transfer.bytes | formatFileSize }} /
                    {{ transfer.size | formatFileSize }}
                  </span>
                </div>
                <div class="stats-right">
                  @if (transfer.speed > 0) {
                    <span class="speed-text">
                      <span class="speed-dot" [ngClass]="getSpeedClass(transfer.speed)"></span>
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
        </div>
      } @else {
        <div class="empty-state">
          <mat-icon svgIcon="download" class="placeholder-icon"></mat-icon>
          <span>{{ 'shared.transferActivity.empty.noActive' | translate }}</span>
          <p>{{ 'shared.transferActivity.empty.activeHint' | translate }}</p>
        </div>
      }
    </div>
  `,
  styleUrls: ['./transfer-tables.scss'],
})
export class ActiveTransfersTableComponent {
  protected readonly pathService = inject(PathService);

  readonly transfers = input.required<TransferFile[]>();

  trackByName(_index: number, transfer: TransferFile): string {
    return transfer.name;
  }

  getSpeedClass(speed: number): string {
    if (speed > 10 * 1024 * 1024) return 'speed-fast';
    if (speed > 1 * 1024 * 1024) return 'speed-medium';
    return 'speed-slow';
  }

  isPreparing(percentage: number | undefined | null): boolean {
    return percentage === undefined || percentage === null || isNaN(percentage);
  }
}
