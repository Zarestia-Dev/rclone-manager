import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

export interface StatusBadgeConfig {
  isActive: boolean;
  isError?: boolean;
  isLoading?: boolean;
  activeLabel: string;
  inactiveLabel: string;
  errorLabel?: string;
  loadingLabel?: string;
}

@Component({
  selector: 'app-status-badge',
  standalone: true,
  imports: [CommonModule, MatProgressSpinnerModule],
  styleUrls: ['./status-badge.component.scss'],
  template: `
    <div
      class="status-badge"
      [ngClass]="{
        active: config.isActive && !config.isError,
        error: config.isError,
        inactive: !config.isActive && !config.isError,
      }"
    >
      <div class="status-dot"></div>
      <span>{{ getStatusLabel() }}</span>
      @if (config.isLoading) {
        <mat-spinner diameter="16"></mat-spinner>
      }
    </div>
  `,
})
export class StatusBadgeComponent {
  @Input() config!: StatusBadgeConfig;

  getStatusLabel(): string {
    if (this.config.isLoading && this.config.loadingLabel) {
      return this.config.loadingLabel;
    }
    if (this.config.isError && this.config.errorLabel) {
      return this.config.errorLabel;
    }
    return this.config.isActive ? this.config.activeLabel : this.config.inactiveLabel;
  }
}
