import { Component, input, output, computed } from '@angular/core';
import { NgStyle } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { DiskUsage } from '@app/types';
import { FormatFileSizePipe } from '@app/pipes';

@Component({
  selector: 'app-disk-usage-panel',
  standalone: true,
  imports: [
    NgStyle,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    FormatFileSizePipe,
    TranslateModule,
  ],
  styleUrls: ['./disk-usage-panel.component.scss'],
  template: `
    @let cfg = config();

    <mat-card>
      <mat-card-header>
        <mat-card-title>
          <mat-icon svgIcon="hard-drive"></mat-icon>
          <span>{{ 'detailShared.diskUsage.title' | translate }}</span>
        </mat-card-title>
        <div class="header-actions">
          @if (!cfg.notSupported) {
            <button mat-icon-button (click)="retry.emit()" [disabled]="cfg.loading">
              <mat-icon svgIcon="rotate-right" [class.animate-spin]="cfg.loading"></mat-icon>
            </button>
          }
        </div>
      </mat-card-header>

      <mat-card-content>
        <div class="usage-bar-container">
          <div class="disk-usage-bar" [ngStyle]="diskBarStyle()">
            @if (cfg.notSupported) {
              <div class="usage-status-text">
                {{ 'detailShared.diskUsage.notSupported' | translate }}
              </div>
            } @else if (cfg.error) {
              <div class="usage-status-error" [title]="cfg.errorMessage">
                <mat-icon svgIcon="circle-exclamation" class="error-icon"></mat-icon>
                <span>{{ 'detailShared.diskUsage.errorLoading' | translate }}</span>
              </div>
            } @else {
              <div
                class="usage-fill"
                [ngStyle]="usageFillStyle()"
                [class.hidden]="cfg.loading"
              ></div>
            }
          </div>
        </div>
        @if (!cfg.notSupported && !cfg.error) {
          <div class="usage-legend">
            @if (cfg.loading) {
              <div class="legend-spinner">
                <mat-progress-spinner diameter="24" mode="indeterminate"></mat-progress-spinner>
              </div>
            } @else {
              <div class="legend-item">
                <div class="legend-color total"></div>
                <span class="legend-text">{{
                  'detailShared.diskUsage.total'
                    | translate: { value: (cfg.total_space ?? 0 | formatFileSize) }
                }}</span>
              </div>
              <div class="legend-item">
                <div class="legend-color used" [ngStyle]="usedLegendStyle()"></div>
                <span class="legend-text">{{
                  'detailShared.diskUsage.used'
                    | translate: { value: (cfg.used_space ?? 0 | formatFileSize) }
                }}</span>
              </div>
              <div class="legend-item">
                <div class="legend-color free"></div>
                <span class="legend-text">{{
                  'detailShared.diskUsage.free'
                    | translate: { value: (cfg.free_space ?? 0 | formatFileSize) }
                }}</span>
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

  readonly usagePercentage = computed(() => {
    const conf = this.config();
    if (conf.notSupported) return 0;

    const used = conf.used_space ?? 0;
    const total = conf.total_space;
    if (!total) return 0;

    return (used / total) * 100;
  });

  readonly usageColorVar = computed(() => {
    const pct = this.usagePercentage();
    if (pct >= 90) return '--warn-color'; // Critical
    if (pct >= 80) return '--orange'; // High
    if (pct >= 60) return '--yellow'; // Warning
    return '--primary-color'; // Healthy
  });

  readonly diskBarStyle = computed(() => {
    const conf = this.config();

    if (conf.notSupported) {
      return {
        backgroundColor: 'rgba(var(--yellow-rgb), 0.3)',
        boxShadow: 'inset 0 0 0 2px var(--yellow)',
      };
    }

    if (conf.error) {
      return {
        backgroundColor: 'rgba(var(--warn-color-rgb), 0.15)',
        boxShadow: 'inset 0 0 0 2px var(--warn-color)',
        cursor: 'help',
      };
    }

    if (conf.loading) {
      return {
        backgroundColor: 'rgba(var(--orange-rgb), 0.2)',
        boxShadow: 'inset 0 0 0 2px var(--orange)',
        backgroundImage:
          'linear-gradient(90deg, transparent 0%, rgba(var(--orange-rgb), 0.3) 50%, transparent 100%)',
        backgroundSize: '200% 100%',
        animation: 'diskLoadingShimmer 1.5s ease-in-out infinite',
      };
    }

    const colorVar = this.usageColorVar();
    return {
      backgroundColor: 'rgba(var(--window-fg-color-rgb), 0.08)',
      boxShadow: `inset 0 0 0 2px var(${colorVar})`,
    };
  });

  readonly usageFillStyle = computed(() => ({
    width: `${this.usagePercentage()}%`,
    background: `var(${this.usageColorVar()})`,
  }));

  readonly usedLegendStyle = computed(() => ({
    background: `var(${this.usageColorVar()})`,
  }));
}
