import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
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
  ],
  styleUrls: ['./disk-usage-panel.component.scss'],
  template: `
    <mat-card>
      <mat-card-header>
        <mat-card-title>
          <mat-icon svgIcon="hard-drive"></mat-icon>
          <span>Disk Usage</span>
        </mat-card-title>
      </mat-card-header>
      <mat-card-content>
        <div class="usage-bar-container">
          <div class="disk-usage-bar" [ngStyle]="getDiskBarStyle()">
            @if (config.notSupported) {
              <div class="usage-status-text">
                {{ config.notSupported ? 'Not Supported' : 'Unknown' }}
              </div>
            } @else {
              <div class="usage-fill" [style.width]="getUsagePercentage() + '%'"></div>
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
                <span class="legend-text"
                  >Total: {{ config.total_space ?? 0 | formatFileSize }}</span
                >
              </div>
              <div class="legend-item">
                <div class="legend-color used"></div>
                <span class="legend-text">Used: {{ config.used_space ?? 0 | formatFileSize }}</span>
              </div>
              <div class="legend-item">
                <div class="legend-color free"></div>
                <span class="legend-text">Free: {{ config.free_space ?? 0 | formatFileSize }}</span>
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
      backgroundColor: 'var(--yellow)',
      border: '3px solid transparent',
      transition: 'all 0.5s ease-in-out',
    };
  }

  private getLoadingStyle(): Record<string, string> {
    return {
      backgroundColor: 'var(--orange)',
      border: '3px solid transparent',
      backgroundImage:
        'linear-gradient(120deg, rgba(255,255,255,0.15) 25%, rgba(255,255,255,0.35) 50%, rgba(255,255,255,0.15) 75%)',
      backgroundSize: '200% 100%',
      animation: 'diskLoadingShimmer 2s linear infinite',
      transition: 'all 0.5s ease-in-out',
    };
  }

  private getMountedStyle(): Record<string, string> {
    return {
      backgroundColor: '#cecece',
      border: '3px solid var(--light-blue)',
      transition: 'all 0.5s ease-in-out',
    };
  }
}
