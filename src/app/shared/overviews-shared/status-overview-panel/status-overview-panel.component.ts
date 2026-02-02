import { Component, input, computed, inject } from '@angular/core';
import { TranslateService, TranslateModule } from '@ngx-translate/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { AppTab } from '@app/types';

@Component({
  selector: 'app-status-overview-panel',
  standalone: true,
  imports: [MatCardModule, MatIconModule, TranslateModule],
  templateUrl: './status-overview-panel.component.html',
  styleUrl: './status-overview-panel.component.scss',
})
export class StatusOverviewPanelComponent {
  private translate = inject(TranslateService);
  mode = input<AppTab>('general');
  totalCount = input(0);
  activeCount = input(0);
  inactiveCount = input(0);

  title = computed(() => {
    const mode = this.mode();
    // Use the specific translation key for the title
    return this.translate.instant('overviews.status.titles.' + mode);
  });

  private readonly ACTIVE_LABELS: Record<string, string> = {
    mount: 'overviews.status.labels.mounted',
    sync: 'overviews.status.labels.syncing',
  };

  private readonly INACTIVE_LABELS: Record<string, string> = {
    mount: 'overviews.status.labels.unmounted',
    sync: 'overviews.status.labels.offSync',
  };

  activeLabel = computed(() =>
    this.translate.instant(this.ACTIVE_LABELS[this.mode()] || 'overviews.status.labels.active')
  );

  inactiveLabel = computed(() =>
    this.translate.instant(this.INACTIVE_LABELS[this.mode()] || 'overviews.status.labels.inactive')
  );

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
