import { Component, input, computed } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { AppTab } from '@app/types';

const ACTIVE_LABELS: Partial<Record<AppTab, string>> = {
  mount: 'overviews.status.labels.mounted',
  sync: 'overviews.status.labels.syncing',
};

const INACTIVE_LABELS: Partial<Record<AppTab, string>> = {
  mount: 'overviews.status.labels.unmounted',
  sync: 'overviews.status.labels.offSync',
};

@Component({
  selector: 'app-status-overview-panel',
  imports: [MatCardModule, MatIconModule, TranslateModule],
  templateUrl: './status-overview-panel.component.html',
  styleUrl: './status-overview-panel.component.scss',
})
export class StatusOverviewPanelComponent {
  readonly mode = input<AppTab>('general');
  readonly totalCount = input(0);
  readonly activeCount = input(0);
  readonly inactiveCount = input(0);
  readonly summaryIcon = 'chart';

  readonly title = computed(() => `overviews.status.titles.${this.mode()}`);

  readonly activeLabel = computed(
    () => ACTIVE_LABELS[this.mode()] ?? 'overviews.status.labels.active'
  );

  readonly inactiveLabel = computed(
    () => INACTIVE_LABELS[this.mode()] ?? 'overviews.status.labels.inactive'
  );

  readonly activePercentage = computed(() => {
    const total = this.totalCount();
    return total > 0 ? (this.activeCount() / total) * 100 : 0;
  });

  readonly inactivePercentage = computed(() => {
    const total = this.totalCount();
    return total > 0 ? (this.inactiveCount() / total) * 100 : 0;
  });

  readonly hasData = computed(() => this.totalCount() > 0);
}
