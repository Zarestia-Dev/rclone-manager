import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { DiskUsage } from '@app/types';
import { FormatFileSizePipe } from '@app/pipes';

@Component({
  selector: 'app-disk-usage-panel',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatIconModule,
    MatProgressSpinnerModule,
    FormatFileSizePipe,
    TranslateModule,
  ],
  styleUrls: ['./disk-usage-panel.component.scss'],
  template: `
    <mat-card>
      <mat-card-header>
        <mat-card-title>
          <mat-icon svgIcon="hard-drive"></mat-icon>
          <span>{{ 'detailShared.diskUsage.title' | translate }}</span>
        </mat-card-title>
      </mat-card-header>
      <mat-card-content>
        <div class="usage-bar-container">
          <div class="disk-usage-bar" [ngStyle]="getDiskBarStyle()">
            @if (config.notSupported) {
              <div class="usage-status-text">
                {{
                  config.notSupported
                    ? ('detailShared.diskUsage.notSupported' | translate)
                    : ('detailShared.diskUsage.unknown' | translate)
                }}
              </div>
            } @else {
              <div class="usage-fill" [ngStyle]="getUsageFillStyle()"></div>
            }
          </div>
        </div>
        @if (config && !config.notSupported) {
          <div class="usage-legend">
            @if (config.loading) {
              <div
                class="legend-spinner"
                style="display:flex;align-items:center;justify-content:center;height:40px;"
              >
                <mat-progress-spinner
                  diameter="24"
                  mode="indeterminate"
                  color="primary"
                ></mat-progress-spinner>
              </div>
            } @else {
              <div class="legend-item">
                <div class="legend-color total"></div>
                <span class="legend-text">{{
                  'detailShared.diskUsage.total'
                    | translate: { value: (config.total_space ?? 0 | formatFileSize) }
                }}</span>
              </div>
              <div class="legend-item">
                <div class="legend-color used" [ngStyle]="getUsedLegendStyle()"></div>
                <span class="legend-text">{{
                  'detailShared.diskUsage.used'
                    | translate: { value: (config.used_space ?? 0 | formatFileSize) }
                }}</span>
              </div>
              <div class="legend-item">
                <div class="legend-color free"></div>
                <span class="legend-text">{{
                  'detailShared.diskUsage.free'
                    | translate: { value: (config.free_space ?? 0 | formatFileSize) }
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
  @Input() config!: DiskUsage;

  getDiskBarStyle(): Record<string, string> {
    if (this.config.notSupported) {
      return this.getUnsupportedStyle();
    }

    if (this.config.loading) {
      return this.getLoadingStyle();
    }

    return this.getMountedStyle();
  }

  getUsagePercentage(): number {
    if (!this.config || this.config.notSupported) {
      return 0;
    }

    const used = this.config.used_space || 0;
    const total = this.config.total_space || 1;

    return total > 0 ? (used / total) * 100 : 0;
  }

  private getUnsupportedStyle(): Record<string, string> {
    return {
      backgroundColor: 'rgba(var(--yellow-rgb), 0.3)',
      boxShadow: 'inset 0 0 0 2px var(--yellow)',
    };
  }

  private getLoadingStyle(): Record<string, string> {
    return {
      backgroundColor: 'rgba(var(--orange-rgb), 0.2)',
      boxShadow: 'inset 0 0 0 2px var(--orange)',
      backgroundImage:
        'linear-gradient(90deg, transparent 0%, rgba(var(--orange-rgb), 0.3) 50%, transparent 100%)',
      backgroundSize: '200% 100%',
      animation: 'diskLoadingShimmer 1.5s ease-in-out infinite',
    };
  }

  private getMountedStyle(): Record<string, string> {
    const colorVar = this.getUsageColorVar();
    return {
      backgroundColor: 'rgba(var(--window-fg-color-rgb), 0.08)',
      boxShadow: `inset 0 0 0 2px var(${colorVar})`,
    };
  }

  getUsageFillStyle(): Record<string, string> {
    return {
      width: `${this.getUsagePercentage()}%`,
      background: `var(${this.getUsageColorVar()})`,
    };
  }

  getUsedLegendStyle(): Record<string, string> {
    return {
      background: `var(${this.getUsageColorVar()})`,
    };
  }

  private getUsageColorVar(): string {
    const percentage = this.getUsagePercentage();

    if (percentage >= 90) {
      return '--warn-color'; // Red - Critical
    } else if (percentage >= 80) {
      return '--orange'; // Orange - High
    } else if (percentage >= 60) {
      return '--yellow'; // Yellow - Warning
    }
    return '--primary-color'; // Green - Healthy
  }
}
