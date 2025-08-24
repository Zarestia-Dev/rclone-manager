import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { DiskUsageConfig } from '../../types';

@Component({
  selector: 'app-disk-usage-panel',
  standalone: true,
  imports: [CommonModule, MatCardModule, MatIconModule],
  styleUrls: ['./disk-usage-panel.component.scss'],
  template: `
    <mat-card class="detail-panel disk-panel">
      <mat-card-header class="panel-header">
        <mat-card-title class="panel-title-content">
          <mat-icon svgIcon="hard-drive" class="panel-icon"></mat-icon>
          <span>Disk Usage</span>
        </mat-card-title>
      </mat-card-header>
      <mat-card-content class="panel-content">
        <div class="disk-usage-section">
          <div class="usage-bar-container">
            <div class="disk-usage-bar" [ngStyle]="getDiskBarStyle()">
              @if (config.mounted === 'error' || config.diskUsage?.notSupported) {
                <div class="usage-status-text">
                  {{
                    config.diskUsage?.notSupported
                      ? 'Not Supported'
                      : config.mounted === 'error'
                        ? 'Error'
                        : 'Unknown'
                  }}
                </div>
              } @else {
                <div class="usage-fill" [style.width]="getUsagePercentage() + '%'"></div>
              }
            </div>
          </div>
          @if (config.diskUsage && !config.diskUsage.notSupported) {
            <div class="usage-legend">
              <div class="legend-item">
                <div class="legend-color total"></div>
                <span class="legend-text">Total: {{ config.diskUsage.total_space }}</span>
              </div>
              <div class="legend-item">
                <div class="legend-color used"></div>
                <span class="legend-text">Used: {{ config.diskUsage.used_space }}</span>
              </div>
              <div class="legend-item">
                <div class="legend-color free"></div>
                <span class="legend-text">Free: {{ config.diskUsage.free_space }}</span>
              </div>
            </div>
          }
        </div>
      </mat-card-content>
    </mat-card>
  `,
})
export class DiskUsagePanelComponent {
  @Input() config!: DiskUsageConfig;

  getDiskBarStyle(): Record<string, string> {
    if (this.config.mounted === 'error') {
      return this.getErrorStyle();
    }

    if (this.config.diskUsage?.notSupported) {
      return this.getUnsupportedStyle();
    }

    if (this.config.diskUsage?.loading) {
      return this.getLoadingStyle();
    }

    return this.getMountedStyle();
  }

  getUsagePercentage(): number {
    if (!this.config.diskUsage || this.config.diskUsage.notSupported) {
      return 0;
    }

    const used = this.parseSize(this.config.diskUsage.used_space || '0');
    const total = this.parseSize(this.config.diskUsage.total_space || '1');

    return total > 0 ? (used / total) * 100 : 0;
  }

  private getErrorStyle(): Record<string, string> {
    return {
      backgroundColor: 'var(--red)',
      border: '3px solid transparent',
      transition: 'all 0.5s ease-in-out',
    };
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
      animation: 'diskLoadingShimmer 1.2s linear infinite',
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

  private parseSize(size: string): number {
    const units: Record<string, number> = {
      B: 1,
      KB: 1024,
      MB: 1024 ** 2,
      GB: 1024 ** 3,
      TB: 1024 ** 4,
    };
    const match = size.trim().match(/^([\d.]+)\s*([A-Za-z]+)?$/);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    const unit = (match[2] || 'B').toUpperCase();
    return value * (units[unit] || 1);
  }
}
