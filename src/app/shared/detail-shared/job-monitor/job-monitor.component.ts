import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  untracked,
} from '@angular/core';
import { DatePipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TranslatePipe } from '@ngx-translate/core';
import { FormatFileSizePipe, FormatTimePipe } from '@app/pipes';
import { BackendTranslationService } from 'src/app/services/i18n/backend-translation.service';
import { AlertBannerComponent } from '../../components/alert-banner/alert-banner.component';
import { CopyToClipboardDirective } from '../../directives/copy-to-clipboard.directive';
import { JOB_STATUS, JobMonitorConfig, JobStatus, PillTone } from '@app/types';
import { TransferActivityPanelComponent } from '../transfer-activity-panel/transfer-activity-panel.component';
import {
  appendSpeedSample,
  monitorKpis,
  MonitorKpi,
  sparkline,
} from '../../utils/job-monitor.util';

import { PillDirective } from '../../directives/pill.directive';
const SPARK_WIDTH = 240;
const SPARK_HEIGHT = 34;

const STATUS_PILLS: Readonly<Record<JobStatus, { tone: PillTone; textKey: string }>> = {
  [JOB_STATUS.Running]: { tone: 'accent', textKey: 'shared.monitor.status.running' },
  [JOB_STATUS.Completed]: { tone: 'primary', textKey: 'shared.monitor.status.completed' },
  [JOB_STATUS.Failed]: { tone: 'warn', textKey: 'shared.monitor.status.failed' },
  [JOB_STATUS.Stopped]: { tone: 'orange', textKey: 'shared.monitor.status.stopped' },
};

/**
 * One surface for a job: who and where it runs, the figures that matter for its kind of work,
 * and the files it touched. It replaces the separate info, statistics and activity cards.
 */
@Component({
  selector: 'app-job-monitor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    NgTemplateOutlet,
    MatCardModule,
    MatIconModule,
    MatProgressBarModule,
    TranslatePipe,
    FormatFileSizePipe,
    FormatTimePipe,
    TransferActivityPanelComponent,
    AlertBannerComponent,
    CopyToClipboardDirective,
    PillDirective,
  ],
  templateUrl: './job-monitor.component.html',
  styleUrl: './job-monitor.component.scss',
})
export class JobMonitorComponent {
  readonly config = input.required<JobMonitorConfig>();
  /** Offers a button that opens the job's detail view; leave it off where that view is already open. */
  readonly canOpenDetail = input(false);
  readonly resetStats = output<void>();
  readonly deleteJob = output<void>();
  readonly openDetail = output<void>();

  private readonly backendTranslation = inject(BackendTranslationService);

  private readonly stats = computed(() => this.config().stats);

  /** The failure text in the user's language, or nothing while the job has not failed. */
  protected readonly error = computed(() => {
    const error = this.config().error;
    return error ? this.backendTranslation.translateBackendMessage(error) || null : null;
  });

  private readonly jobId = computed(() => this.config().jobId);

  /** Real speed samples of the running job, collected from each stats update; cleared per job. */
  protected readonly speedHistory = linkedSignal<number | undefined, number[]>({
    source: this.jobId,
    computation: () => [],
  });

  /** Figures only mean something once a job has run or is running. */
  protected readonly hasJob = computed(() => !!this.config().jobId || this.config().running);

  protected readonly statusPill = computed(() => {
    const status = this.config().status;
    return status ? STATUS_PILLS[status] : null;
  });

  protected readonly kpis = computed<MonitorKpi[]>(() => {
    const { jobType, running, activity } = this.config();
    return monitorKpis({
      jobType,
      stats: this.stats(),
      completed: activity.completedTransfers,
      running,
      speedHistory: this.speedHistory(),
    });
  });

  protected readonly spark = computed(() =>
    sparkline(this.speedHistory(), SPARK_WIDTH, SPARK_HEIGHT)
  );
  protected readonly sparkWidth = SPARK_WIDTH;
  protected readonly sparkHeight = SPARK_HEIGHT;

  constructor() {
    effect(() => {
      const stats = this.stats();
      if (!untracked(() => this.config().running)) return;
      untracked(() => this.speedHistory.update(history => appendSpeedSample(history, stats.speed)));
    });
  }
}
