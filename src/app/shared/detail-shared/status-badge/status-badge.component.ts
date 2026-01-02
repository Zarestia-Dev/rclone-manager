import { Component, Input } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { StatusBadgeConfig } from '../../types';

@Component({
  selector: 'app-status-badge',
  standalone: true,
  imports: [TranslateModule],
  styleUrls: ['./status-badge.component.scss'],
  template: `
    <div class="status-badge" [class]="config.badgeClass">
      <div class="status-dot"></div>
      <span>{{ getStatusLabel() | translate }}</span>
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
