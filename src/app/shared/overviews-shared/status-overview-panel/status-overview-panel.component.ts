import { Component, input, computed } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { AppTab } from '@app/types';

@Component({
  selector: 'app-status-overview-panel',
  standalone: true,
  imports: [MatCardModule, MatIconModule],
  templateUrl: './status-overview-panel.component.html',
  styleUrl: './status-overview-panel.component.scss',
})
export class StatusOverviewPanelComponent {
  mode = input<AppTab>('general');
  totalCount = input(0);
  activeCount = input(0);
  inactiveCount = input(0);

  title = computed(() => {
    const mode = this.mode();
    return `${mode.charAt(0).toUpperCase() + mode.slice(1)} Status Overview`;
  });

  activeLabel = computed(() => {
    switch (this.mode()) {
      case 'mount':
        return 'Mounted';
      case 'sync':
        return 'Syncing';
      default:
        return 'Active';
    }
  });

  inactiveLabel = computed(() => {
    switch (this.mode()) {
      case 'mount':
        return 'Unmounted';
      case 'sync':
        return 'Off Sync';
      default:
        return 'Inactive';
    }
  });

  activePercentage = computed(() => {
    const total = this.totalCount();
    const active = this.activeCount();
    return total > 0 ? (active / total) * 100 : 0;
  });

  inactivePercentage = computed(() => {
    const total = this.totalCount();
    const inactive = this.inactiveCount();
    return total > 0 ? (inactive / total) * 100 : 0;
  });

  hasData = computed(() => {
    return this.activeCount() > 0 || this.inactiveCount() > 0;
  });
}
