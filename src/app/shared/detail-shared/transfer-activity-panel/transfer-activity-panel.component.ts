import {
  Component,
  input,
  output,
  ChangeDetectionStrategy,
  signal,
  computed,
  inject,
  linkedSignal,
} from '@angular/core';
import { Clipboard } from '@angular/cdk/clipboard';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

import { ActiveTransfersTableComponent } from './active-transfers-table.component';
import { CompletedTransfersTableComponent } from './completed-transfers-table.component';
import { CheckResultsTableComponent } from './check-results-table.component';
import { JobReportComponent } from '../job-report/job-report.component';
import { BisyncConflictsComponent } from '../bisync-conflicts/bisync-conflicts.component';
import { SearchContainerComponent } from '../../components/search-container/search-container.component';
import {
  CHECK_OPERATIONS,
  DELETE_OPERATIONS,
  TRANSFER_OPERATIONS,
  TransferActivityPanelConfig,
  TRANSFER_STATUS,
  TransferStatus,
} from '@app/types';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { hasFileReport } from '../../utils/job-report.util';
import {
  activityCsv,
  activityStatusBadge,
  effectiveTransferStatus,
  filterActivity,
} from './activity.utils';

import { PillDirective } from '../../directives/pill.directive';
export type ActivityTabId = 'conflicts' | 'report' | 'active' | 'recent';

export interface ActivityTab {
  id: ActivityTabId;
  labelKey: string;
  count?: number;
}

@Component({
  selector: 'app-transfer-activity-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatIconModule,
    TranslatePipe,
    ActiveTransfersTableComponent,
    CompletedTransfersTableComponent,
    CheckResultsTableComponent,
    JobReportComponent,
    BisyncConflictsComponent,
    SearchContainerComponent,
    PillDirective,
  ],
  templateUrl: './transfer-activity-panel.component.html',
  styleUrl: './transfer-activity-panel.component.scss',
})
export class TransferActivityPanelComponent {
  readonly config = input.required<TransferActivityPanelConfig>();
  readonly isJobRunning = input<boolean>(false);
  /** Offers a button that opens the job's detail view; leave it off where that view is already open. */
  readonly canOpenDetail = input(false);
  readonly resetStats = output<void>();
  readonly deleteJob = output<void>();
  readonly openDetail = output<void>();

  readonly isCheck = computed(() => CHECK_OPERATIONS.has(this.config().jobType || 'sync'));
  /** The title says what the section lists; the monitor header above names the job. */
  readonly titleKey = computed(() => {
    const type = this.config().jobType || 'sync';
    if (this.isCheck()) return 'shared.transferActivity.titleCheck';
    if (DELETE_OPERATIONS.has(type)) return 'shared.transferActivity.titleDelete';
    return TRANSFER_OPERATIONS.has(type)
      ? 'shared.transferActivity.title'
      : 'shared.transferActivity.titleActivity';
  });
  /** A finished job that kept file reports offers them first. */
  readonly showReport = computed(
    () => hasFileReport(this.config().report?.counts) && !this.isJobRunning()
  );
  /** Where the conflicts of a finished bisync run are resolved; none after a dry run. */
  readonly conflictsTarget = computed(() => {
    const report = this.config().report;
    return report?.path1 && report.path2 && !report.dryRun && (report.counts.conflicts ?? 0) > 0
      ? { jobId: report.jobId, path1: report.path1, path2: report.path2 }
      : null;
  });
  readonly showConflicts = computed(() => !!this.conflictsTarget() && !this.isJobRunning());
  /** The views on offer, in order; with one view there are no tabs. */
  readonly tabs = computed<ActivityTab[]>(() => {
    const completed = this.config().completedTransfers.length;
    const recent: ActivityTab = {
      id: 'recent',
      labelKey: 'shared.transferActivity.tabs.recent',
      count: completed,
    };
    const active: ActivityTab = {
      id: 'active',
      labelKey: 'shared.transferActivity.tabs.active',
      count: this.activeCount(),
    };
    let tabs: ActivityTab[];
    if (this.showReport()) {
      const report: ActivityTab = { id: 'report', labelKey: 'shared.transferActivity.tabs.report' };
      tabs = completed > 0 ? [report, recent] : [report];
    } else if (this.config().showHistory && this.activeCount() > 0 && completed > 0) {
      tabs = [active, recent];
    } else if (this.activeCount() > 0 || !this.config().showHistory || this.isJobRunning()) {
      tabs = [active];
    } else {
      tabs = [recent];
    }
    if (!this.showConflicts()) return tabs;
    return [
      {
        id: 'conflicts',
        labelKey: 'shared.transferActivity.tabs.conflicts',
        count: this.config().report?.counts.conflicts,
      },
      ...tabs,
    ];
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

  /** The tab the user picked, by id, so it stays picked while other tabs come and go. */
  private readonly selectedId = signal<string | null>(null);
  /** There is always at least one tab to show. */
  readonly currentTab = computed(() => {
    const tabs = this.tabs();
    return tabs.find(tab => tab.id === this.selectedId()) ?? tabs[0];
  });

  readonly searchVisible = signal(false);
  readonly searchTerm = signal('');

  private readonly clipboard = inject(Clipboard);
  private readonly notifications = inject(NotificationService);
  private readonly translate = inject(TranslateService);

  /** The finished file rows that match the search and the status filter, as the lists show them. */
  readonly exportRows = computed(() =>
    filterActivity(this.config().completedTransfers, this.searchTerm(), this.statusFilter())
  );

  /** Search has something to look through. */
  readonly canSearch = computed(
    () => this.config().completedTransfers.length > 0 || this.activeCount() > 0 || this.showReport()
  );
  /** The bar is left out while it would hold a lone tab and nothing to press. */
  readonly showToolbar = computed(
    () =>
      this.tabs().length > 1 ||
      this.canOpenDetail() ||
      this.canSearch() ||
      this.searchVisible() ||
      this.exportRows().length > 0 ||
      this.config().showHistory
  );

  selectTab(id: string): void {
    this.selectedId.set(id);
  }

  /** Arrow keys, Home and End move between the tabs, as in any tab list. */
  protected onTabKey(event: KeyboardEvent): void {
    const tabs = this.tabs();
    const index = tabs.findIndex(tab => tab.id === this.currentTab().id);
    const next = {
      ArrowRight: (index + 1) % tabs.length,
      ArrowLeft: (index - 1 + tabs.length) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    this.selectTab(tabs[next].id);
    const buttons = (event.currentTarget as HTMLElement).parentElement?.children;
    (buttons?.[next] as HTMLElement | undefined)?.focus();
  }

  copyCsv(): void {
    const rows = this.exportRows();
    if (!rows.length) return;
    if (this.clipboard.copy(activityCsv(rows))) {
      this.notifications.showSuccess(
        this.translate.instant('shared.transferActivity.export.copied', { count: rows.length })
      );
    } else {
      this.notifications.showError(this.translate.instant('common.copyFailed'));
    }
  }

  toggleSearch(): void {
    const nextVal = !this.searchVisible();
    this.searchVisible.set(nextVal);
    if (!nextVal) this.searchTerm.set('');
  }
}
