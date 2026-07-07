import { Component, input, output, computed, ChangeDetectionStrategy } from '@angular/core';
import { NgClass, NgStyle } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { DiskUsage } from '@app/types';
import { FormatFileSizePipe } from '@app/pipes';

@Component({
  selector: 'app-disk-usage-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgClass,
    NgStyle,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    FormatFileSizePipe,
    TranslatePipe,
  ],
  styleUrls: ['./disk-usage-panel.component.scss'],
  template: `
    @let cfg = config();

    <mat-card>
      <mat-card-header style="padding-bottom: var(--space-xs);">
        <mat-card-title>
          <mat-icon svgIcon="disk" aria-hidden="true"></mat-icon>
          <span>{{ 'detailShared.diskUsage.title' | translate }}</span>
        </mat-card-title>

        <div class="header-actions">
          @if (!cfg.notSupported && !cfg.error) {
            @if (cfg.loading) {
              <span class="usage-badge skeleton animate-shimmer" aria-hidden="true"></span>
            } @else {
              <span class="usage-badge" [ngClass]="usageSeverity()">
                {{ usagePercentageLabel() }}
              </span>
            }
          }

          @if (!cfg.notSupported) {
            <button
              mat-icon-button
              (click)="retry.emit()"
              [disabled]="cfg.loading"
              [attr.aria-label]="'detailShared.diskUsage.retry' | translate"
            >
              <mat-icon svgIcon="rotate-right" [class.animate-spin]="cfg.loading"></mat-icon>
            </button>
          }
        </div>
      </mat-card-header>

      <mat-card-content>
        @if (cfg.notSupported) {
          <div class="inline-status warning" role="status">
            <mat-icon svgIcon="circle-exclamation" aria-hidden="true"></mat-icon>
            <span>{{ 'detailShared.diskUsage.notSupported' | translate }}</span>
          </div>
        } @else if (cfg.error) {
          <div class="inline-status error" [title]="cfg.errorMessage" role="alert">
            <mat-icon svgIcon="circle-exclamation" aria-hidden="true"></mat-icon>
            <span>{{ 'detailShared.diskUsage.errorLoading' | translate }}</span>
          </div>
        } @else {
          <div class="progress-track" [class.loading]="cfg.loading" aria-hidden="true">
            <div
              class="progress-fill"
              [class.loading]="cfg.loading"
              [ngClass]="cfg.loading ? '' : usageSeverity()"
              [ngStyle]="{
                width: (cfg.loading ? 100 : usagePercentage()) + '%',
                'min-width': !cfg.loading && (cfg.used ?? 0) > 0 ? '8px' : '0',
              }"
            ></div>
          </div>

          <div class="legend" [class.loading]="cfg.loading">
            @if (cfg.loading) {
              <div class="legend-item">
                <span class="legend-dot skeleton animate-shimmer" aria-hidden="true"></span>
                <span class="skeleton-text animate-shimmer" style="width: 36px;"></span>
                <span class="skeleton-text animate-shimmer" style="width: 54px;"></span>
              </div>

              <div class="legend-item">
                <span class="legend-dot skeleton animate-shimmer" aria-hidden="true"></span>
                <span class="skeleton-text animate-shimmer" style="width: 36px;"></span>
                <span class="skeleton-text animate-shimmer" style="width: 54px;"></span>
              </div>

              <div class="legend-item total-item">
                <span class="skeleton-text animate-shimmer" style="width: 32px;"></span>
                <span class="skeleton-text animate-shimmer" style="width: 54px;"></span>
              </div>
            } @else {
              <div class="legend-item">
                <span class="legend-dot used" [ngClass]="usageSeverity()" aria-hidden="true"></span>
                <span class="legend-label">{{ 'detailShared.diskUsage.used' | translate }}</span>
                <span class="legend-value">{{ cfg.used ?? 0 | formatFileSize }}</span>
              </div>

              <div class="legend-item">
                <span class="legend-dot free" aria-hidden="true"></span>
                <span class="legend-label">{{ 'detailShared.diskUsage.free' | translate }}</span>
                <span class="legend-value">{{ cfg.free ?? 0 | formatFileSize }}</span>
              </div>

              <div class="legend-item total-item">
                <span class="legend-label">{{ 'detailShared.diskUsage.total' | translate }}</span>
                <span class="legend-value">{{ cfg.total ?? 0 | formatFileSize }}</span>
              </div>
            }
          </div>
        }
      </mat-card-content>
    </mat-card>
  `,
})
export class DiskUsagePanelComponent {
  readonly config = input.required<DiskUsage>();
  readonly retry = output<void>();

  readonly usagePercentage = computed(() => this.config().usagePercentage ?? 0);
  readonly usagePercentageLabel = computed(() => this.config().usagePercentageLabel ?? '0%');
  readonly usageSeverity = computed(() => this.config().usageSeverity ?? 'healthy');
}
