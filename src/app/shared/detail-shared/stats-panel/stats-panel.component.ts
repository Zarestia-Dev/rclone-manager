import { Component, Input } from "@angular/core";
import { CommonModule } from "@angular/common";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatTooltipModule } from "@angular/material/tooltip";
import { ThemePalette } from "@angular/material/core";

export interface StatItem {
  value: string | number;
  label: string;
  isPrimary?: boolean;
  hasError?: boolean;
  progress?: number;
  tooltip?: string;
}

export interface StatsPanelConfig {
  title: string;
  icon: string;
  stats: StatItem[];
  operationClass?: string;
  operationColor?: ThemePalette;
}

@Component({
  selector: "app-stats-panel",
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatIconModule,
    MatProgressBarModule,
    MatTooltipModule,
  ],
  styleUrls: ["./stats-panel.component.scss"],
  template: `
    <mat-card class="detail-panel stats-panel">
      <mat-card-header class="panel-header">
        <mat-card-title class="panel-title-content">
          <mat-icon [svgIcon]="config.icon" class="panel-icon"></mat-icon>
          <span>{{ config.title }}</span>
        </mat-card-title>
      </mat-card-header>

      <mat-card-content class="panel-content">
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
              [color]="config.operationColor"
              mode="determinate"
              [value]="stat.progress"
              class="stat-progress"
            >
            </mat-progress-bar>
            } } @else {
            <div class="stat-value">{{ stat.value }}</div>
            <div class="stat-label">{{ stat.label }}</div>
            }
          </div>
          }
        </div>
      </mat-card-content>
    </mat-card>
  `,
})
export class StatsPanelComponent {
  @Input() config!: StatsPanelConfig;
}
