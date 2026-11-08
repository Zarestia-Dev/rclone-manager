import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TranslatePipe } from '@ngx-translate/core';
import { JobReport, JobReportCounts, JobReportKey } from '@app/types';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { CopyToClipboardDirective } from '../../directives/copy-to-clipboard.directive';
import { JOB_REPORT_KEYS, reportEntries } from '../../utils/job-report.util';

/** Rows of a report shown at once; a report can list every file of a large job. */
export const REPORT_PAGE_SIZE = 200;

/** The file reports a finished sync, copy or move kept: a tab per report, a file list below. */
@Component({
  selector: 'app-job-report',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    MatIconModule,
    MatProgressBarModule,
    TranslatePipe,
    CopyToClipboardDirective,
  ],
  templateUrl: './job-report.component.html',
  styleUrl: './job-report.component.scss',
})
export class JobReportComponent {
  private readonly jobService = inject(JobManagementService);

  readonly jobId = input.required<number>();
  readonly counts = input.required<JobReportCounts>();
  /** Narrows the file list to the paths containing this text. */
  readonly searchTerm = input('');

  readonly tabs = computed(() =>
    JOB_REPORT_KEYS.filter(key => this.counts()[key] !== undefined).map(key => ({
      key,
      count: this.counts()[key] ?? 0,
    }))
  );

  private readonly report = signal<JobReport | null>(null);
  readonly loading = signal(false);
  readonly failed = signal(false);
  private readonly picked = signal<JobReportKey | null>(null);
  private readonly limit = signal(REPORT_PAGE_SIZE);

  /** The report on show: the picked one, else the first that lists any file. */
  readonly activeReport = computed<JobReportKey | null>(() => {
    const tabs = this.tabs();
    const picked = this.picked();
    if (picked && tabs.some(tab => tab.key === picked)) return picked;
    return (tabs.find(tab => tab.count > 0) ?? tabs[0])?.key ?? null;
  });

  private readonly lines = computed(() => {
    const key = this.activeReport();
    const lines = (key && this.report()?.[key]) || [];
    const term = this.searchTerm().trim().toLowerCase();
    return term ? lines.filter(line => line.toLowerCase().includes(term)) : lines;
  });

  readonly rows = computed(() => {
    const key = this.activeReport();
    return key ? reportEntries(key, this.lines().slice(0, this.limit())) : [];
  });

  readonly hiddenCount = computed(() => Math.max(0, this.lines().length - this.limit()));

  /** What the copy button copies: every line on show, not only the visible page. */
  readonly text = computed(() => this.lines().join('\n'));

  /** Changes when another job, or another result of it, is shown. */
  private readonly source = computed(() => `${this.jobId()}:${JSON.stringify(this.counts())}`);

  constructor() {
    effect(() => {
      this.source();
      untracked(() => void this.load(this.jobId()));
    });
  }

  select(key: JobReportKey): void {
    this.picked.set(key);
    this.limit.set(REPORT_PAGE_SIZE);
  }

  showMore(): void {
    this.limit.update(limit => limit + REPORT_PAGE_SIZE);
  }

  private async load(jobId: number): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    try {
      const report = await this.jobService.getJobReport(jobId);
      if (jobId === this.jobId()) this.report.set(report);
    } catch (error) {
      console.error('Failed to load job report:', error);
      if (jobId === this.jobId()) {
        this.report.set(null);
        this.failed.set(true);
      }
    } finally {
      if (jobId === this.jobId()) this.loading.set(false);
    }
  }
}
