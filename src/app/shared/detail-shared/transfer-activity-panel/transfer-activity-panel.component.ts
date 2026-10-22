import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  input,
  output,
  ChangeDetectionStrategy,
  signal,
  computed,
  linkedSignal,
} from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';

import { ActiveTransfersTableComponent } from './active-transfers-table.component';
import { CompletedTransfersTableComponent } from './completed-transfers-table.component';
import { CheckResultsTableComponent } from './check-results-table.component';
import { SearchContainerComponent } from '../../components/search-container/search-container.component';
import {
  CHECK_OPERATIONS,
  DELETE_OPERATIONS,
  TRANSFER_OPERATIONS,
  JOB_ICON_MAP,
  TransferActivityPanelConfig,
  TRANSFER_STATUS,
  TransferStatus,
} from '@app/types';
import { activityStatusBadge, effectiveTransferStatus } from './activity.utils';

@Component({
  selector: 'app-transfer-activity-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    MatCardModule,
    MatIconModule,
    MatTabsModule,
    MatButtonModule,
    TranslatePipe,
    ActiveTransfersTableComponent,
    CompletedTransfersTableComponent,
    CheckResultsTableComponent,
    SearchContainerComponent,
  ],
  templateUrl: './transfer-activity-panel.component.html',
  styleUrl: './transfer-activity-panel.component.scss',
})
export class TransferActivityPanelComponent {
  readonly config = input.required<TransferActivityPanelConfig>();
  readonly isJobRunning = input<boolean>(false);
  readonly resetStats = output<void>();
  readonly deleteJob = output<void>();

  readonly isCheck = computed(() => CHECK_OPERATIONS.has(this.config().jobType || 'sync'));
  readonly activityIcon = computed(() => JOB_ICON_MAP[this.config().jobType || ''] || 'operations');
  readonly titleKey = computed(() => {
    const type = this.config().jobType || 'sync';
    if (this.isCheck()) return 'shared.transferActivity.titleCheck';
    if (DELETE_OPERATIONS.has(type)) return 'shared.transferActivity.titleDelete';
    return TRANSFER_OPERATIONS.has(type)
      ? 'shared.transferActivity.title'
      : 'shared.transferActivity.titleActivity';
  });
  readonly activeCount = computed(
    () => this.config().activeTransfers.length + (this.config().activeChecks?.length || 0)
  );
  readonly statusOptions = computed(() => {
    const counts = new Map<TransferStatus, number>();
    for (const transfer of this.config().completedTransfers) {
      const status = effectiveTransferStatus(transfer);
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return Object.values(TRANSFER_STATUS).flatMap(status => {
      const count = counts.get(status);
      return count
        ? [{ status, count, badge: activityStatusBadge(status, this.config().jobType || 'sync') }]
        : [];
    });
  });
  readonly statusFilter = linkedSignal({
    source: () => ({
      jobId: this.config().completedTransfers[0]?.jobid,
      remote: this.config().remoteName,
      options: this.statusOptions(),
    }),
    computation: (source, previous): TransferStatus | null =>
      previous &&
      previous.source.jobId === source.jobId &&
      previous.source.remote === source.remote &&
      source.options.length > 1 &&
      source.options.some(option => option.status === previous.value)
        ? previous.value
        : null,
  });

  readonly searchVisible = signal(false);
  readonly searchTerm = signal('');

  toggleSearch(): void {
    const nextVal = !this.searchVisible();
    this.searchVisible.set(nextVal);
    if (!nextVal) this.searchTerm.set('');
  }
}
