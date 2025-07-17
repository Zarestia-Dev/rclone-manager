import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface StatusBadgeConfig {
  isActive: boolean;
  isError?: boolean;
  isLoading?: boolean;
  activeLabel: string;
  inactiveLabel: string;
  errorLabel?: string;
  loadingLabel?: string;
  badgeClass?: string;
}

@Component({
  selector: 'app-status-badge',
  standalone: true,
  imports: [CommonModule],
  styleUrls: ['./status-badge.component.scss'],
  template: `
    <div class="status-badge" [ngClass]="config.badgeClass">
      <div class="status-dot"></div>
      <span>{{ getStatusLabel() }}</span>
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
