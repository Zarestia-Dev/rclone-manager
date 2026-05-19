import { Component, input, output, computed } from '@angular/core';
import { NgClass, NgStyle } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { DiskUsage } from '@app/types';
import { FormatFileSizePipe } from '@app/pipes';

@Component({
  selector: 'app-disk-usage-panel',
  standalone: true,
  imports: [
    NgClass,
    NgStyle,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    FormatFileSizePipe,
    TranslateModule,
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
            @if (!cfg.loading) {
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
          <div class="progress-track" aria-hidden="true">
            <div
              class="progress-fill"
              [class.loading]="cfg.loading"
              [ngClass]="usageSeverity()"
              [ngStyle]="
                cfg.loading
                  ? {}
                  : {
                      width: usagePercentage() + '%',
                      'min-width': (cfg.used_space ?? 0) > 0 ? '8px' : '0',
                    }
              "
            ></div>
          </div>

          @if (!cfg.loading) {
            <div class="legend">
              <div class="legend-item">
                <span class="legend-dot used" [ngClass]="usageSeverity()" aria-hidden="true"></span>
                <span class="legend-label">{{ 'detailShared.diskUsage.used' | translate }}</span>
                <span class="legend-value">{{ cfg.used_space ?? 0 | formatFileSize }}</span>
              </div>

              <div class="legend-item">
                <span class="legend-dot free" aria-hidden="true"></span>
                <span class="legend-label">{{ 'detailShared.diskUsage.free' | translate }}</span>
                <span class="legend-value">{{ cfg.free_space ?? 0 | formatFileSize }}</span>
              </div>

              <div class="legend-item total-item">
                <span class="legend-label">{{ 'detailShared.diskUsage.total' | translate }}</span>
                <span class="legend-value">{{ cfg.total_space ?? 0 | formatFileSize }}</span>
              </div>
            </div>
          }
        }
      </mat-card-content>
    </mat-card>
  `,
})
export class DiskUsagePanelComponent {
  readonly config = input.required<DiskUsage>();
  readonly retry = output<void>();

  readonly usagePercentage = computed(() => {
    const conf = this.config();
    if (conf.notSupported || conf.error) return 0;
    const used = conf.used_space ?? 0;
    const total = conf.total_space;
    if (!total) return 0;
    return (used / total) * 100;
  });

  readonly usagePercentageLabel = computed(() => `${Math.round(this.usagePercentage())}%`);

  readonly usageSeverity = computed(() => {
    const pct = this.usagePercentage();
    if (pct >= 90) return 'critical';
    if (pct >= 80) return 'high';
    if (pct >= 60) return 'warning';
    return 'healthy';
  });
}
