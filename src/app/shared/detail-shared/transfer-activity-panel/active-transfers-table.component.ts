import { Component, input, ChangeDetectionStrategy, computed } from '@angular/core';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { FormatFileSizePipe } from '../../pipes/format-file-size.pipe';
import { FormatTimePipe } from '../../pipes/format-time.pipe';
import { TransferFile } from '@app/types';

@Component({
  selector: 'app-active-transfers-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatProgressBarModule,
    MatIconModule,
    MatTooltipModule,
    TranslateModule,
    FormatFileSizePipe,
    FormatTimePipe,
  ],
  template: `
    <div class="card-list-container">
      @if (transfers().length > 0) {
        @for (transfer of enrichedTransfers(); track transfer.name) {
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
              <div class="card-paths">
                <code class="path-pill src">{{ transfer.srcFs || '?' }}</code>
                <mat-icon svgIcon="right-arrow" class="arrow-icon"></mat-icon>
                <code class="path-pill dst">{{ transfer.dstFs || '?' }}</code>
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
                <span class="size-text">
                  {{ transfer.bytes | formatFileSize }} / {{ transfer.size | formatFileSize }}
                </span>
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

  protected readonly enrichedTransfers = computed(() => {
    return this.transfers().map(transfer => ({
      ...transfer,
      isPreparing: transfer.percentage == null || isNaN(transfer.percentage),
      speedClass:
        transfer.speed > 10485760
          ? 'speed-fast'
          : transfer.speed > 1048576
            ? 'speed-medium'
            : 'speed-slow',
    }));
  });
}
