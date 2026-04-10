import { Component, ChangeDetectionStrategy, computed, input } from '@angular/core';
import { NgClass } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { StatsPanelConfig } from '../../types';

@Component({
  selector: 'app-stats-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgClass,
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
          <mat-icon [svgIcon]="config().icon" style="color: var(--op-color);"></mat-icon>
          <span>{{ config().title }}</span>
        </mat-card-title>
      </mat-card-header>

      <mat-card-content>
        @if (hasActiveStats()) {
          <div class="stats-grid" [ngClass]="config().operationClass">
            @for (stat of config().stats; track stat.label) {
              <div
                class="stat-item"
                [class.primary]="stat.isPrimary"
                [class.has-error]="stat.hasError"
                [matTooltip]="stat.tooltip ?? ''"
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
                    ></mat-progress-bar>
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
            <mat-icon [svgIcon]="config().icon"></mat-icon>
            <span>{{ 'detailShared.stats.emptyTitle' | translate }}</span>
            <p>{{ 'detailShared.stats.emptyMessage' | translate }}</p>
          </div>
        }
      </mat-card-content>
    </mat-card>
  `,
})
export class StatsPanelComponent {
  readonly config = input.required<StatsPanelConfig>();

  readonly hasActiveStats = computed(() => {
    const stats = this.config().stats;
    if (!stats?.length) return false;

    const ZERO_VALUES = new Set(['0', '0 B', '0/0', '-', '0 B / 0 B', '']);

    return stats.some(stat => {
      if (stat.hasError) return true;
      if (stat.progress && stat.progress > 0) return true;
      return !ZERO_VALUES.has(String(stat.value ?? ''));
    });
  });
}
