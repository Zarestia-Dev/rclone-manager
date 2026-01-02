import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { StatsPanelConfig } from '../../types';

@Component({
  selector: 'app-stats-panel',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatIconModule,
    MatProgressBarModule,
    MatTooltipModule,
    TranslateModule,
  ],
  styleUrls: ['./stats-panel.component.scss'],
  template: `
    <mat-card>
      <mat-card-header>
        <mat-card-title>
          <mat-icon [svgIcon]="config.icon"></mat-icon>
          <span>{{ config.title }}</span>
        </mat-card-title>
      </mat-card-header>

      <mat-card-content>
        @if (hasActiveStats()) {
          <div class="stats-grid" [ngClass]="config.operationClass">
            @for (stat of config.stats; track stat.label) {
              <div
                class="stat-item"
                [class.primary]="stat.isPrimary"
                [class.has-error]="stat.hasError"
                [matTooltip]="stat.tooltip"
                [matTooltipDisabled]="!stat.tooltip"
              >
                @if (stat.isPrimary) {
                  <div class="stat-header">
                    <div class="stat-value">{{ stat.value }}</div>
                    <div class="stat-label">{{ stat.label }}</div>
                  </div>
                  @if (stat.progress !== undefined) {
                    <mat-progress-bar
                      mode="determinate"
                      [value]="stat.progress"
                      class="stat-progress"
                    >
                    </mat-progress-bar>
                  }
                } @else {
                  <div class="stat-value">{{ stat.value }}</div>
                  <div class="stat-label">{{ stat.label }}</div>
                }
              </div>
            }
          </div>
        } @else {
          <div class="empty-state">
            <mat-icon [svgIcon]="config.icon"></mat-icon>
            <span>{{ 'detailShared.stats.emptyTitle' | translate }}</span>
            <p>{{ 'detailShared.stats.emptyMessage' | translate }}</p>
          </div>
        }
      </mat-card-content>
    </mat-card>
  `,
})
export class StatsPanelComponent {
  @Input() config!: StatsPanelConfig;

  /**
   * Check if there are any meaningful stats to display.
   * Returns true if any stat has a non-zero/non-default value.
   */
  hasActiveStats(): boolean {
    if (!this.config?.stats?.length) return false;

    // Check if any stat has a meaningful value (not 0, not "0 B", not "0/0", etc.)
    return this.config.stats.some(stat => {
      const value = stat.value?.toString() || '';
      // Consider it "active" if it has progress, errors, or non-zero values
      if (stat.progress && stat.progress > 0) return true;
      if (stat.hasError) return true;
      // Skip if value looks like a zero/empty state
      if (
        value === '0' ||
        value === '0 B' ||
        value === '0/0' ||
        value === '-' ||
        value === '0 B / 0 B'
      ) {
        return false;
      }
      return true;
    });
  }
}
