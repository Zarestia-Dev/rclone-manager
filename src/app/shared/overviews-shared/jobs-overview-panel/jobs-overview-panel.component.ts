import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  model,
} from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import {
  JobInfo,
  JobStatItem,
  OPERATION_TONE,
  Origin,
  PillTone,
  JOB_ICON_MAP,
  getExecutionOrigin,
  getStarterOrigin,
  matchesOriginFilter,
  ORIGIN_META,
} from '@app/types';
import {
  FormatEtaPipe,
  FormatFileSizePipe,
  FormatRateValuePipe,
  FormatNumberPipe,
} from '@app/pipes';
import { JobManagementService } from '../../../services/operations/job-management.service';
import { RcloneStatusService } from '../../../services/infrastructure/maintenance/rclone-status.service';
import { ModalService } from '../../../services/ui/modal.service';
import { CopyToClipboardDirective } from '../../directives/copy-to-clipboard.directive';
import { AlertBannerComponent } from '../../components/alert-banner/alert-banner.component';
import { OriginFilterBarComponent } from '../origin-filter-bar/origin-filter-bar.component';
import { StarterPillComponent } from '../../components/starter-pill/starter-pill.component';

import { PillDirective } from '../../directives/pill.directive';
export interface RunningJobViewModel {
  job: JobInfo;
  typeIcon: string;
  typeTone: PillTone;
  animationClass: string;
  label: string;
  /** The origin to name next to the job; none when its Quick Run or workflow already names it. */
  origin: { labelKey: string; tone: PillTone } | null;
  progressPercentage: number;
}

@Component({
  selector: 'app-jobs-overview-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormatNumberPipe,
    MatExpansionModule,
    MatIconModule,
    MatButtonModule,
    MatProgressBarModule,
    TranslatePipe,
    FormatEtaPipe,
    FormatFileSizePipe,
    FormatRateValuePipe,
    CopyToClipboardDirective,
    AlertBannerComponent,
    OriginFilterBarComponent,
    StarterPillComponent,
    PillDirective,
  ],
  templateUrl: './jobs-overview-panel.component.html',
  styleUrls: ['./jobs-overview-panel.component.scss'],
})
export class JobsOverviewPanelComponent {
  readonly expanded = model<boolean>(false);

  readonly defaultOriginFilter = input<Origin | 'all'>('all');
  readonly showFilterChips = input<boolean>(false);

  private readonly jobService = inject(JobManagementService);
  private readonly rcloneStatusService = inject(RcloneStatusService);
  private readonly modalService = inject(ModalService);
  private readonly translate = inject(TranslateService);

  readonly selectedOriginFilter = linkedSignal<string>(() => this.defaultOriginFilter());

  readonly jobStats = this.rcloneStatusService.jobStats;
  readonly isLoadingStats = this.rcloneStatusService.isLoading;

  readonly runningJobs = computed(() => {
    const filter = this.selectedOriginFilter();
    return this.jobService
      .jobs()
      .filter(j => j.status === 'Running' && !j.parent_job_id && matchesOriginFilter(j, filter));
  });

  readonly activeJobsCount = computed(() => this.runningJobs().length);

  readonly jobCompletionPercentage = computed(() => {
    const { totalBytes = 0, bytes = 0 } = this.jobStats();
    return totalBytes > 0 ? Math.min(100, (bytes / totalBytes) * 100) : 0;
  });

  readonly jobStatsItems = computed((): JobStatItem[] => {
    const s = this.jobStats();
    return [
      { labelKey: 'generalOverview.jobs.speed', value: s.speed, formatAsBytes: true },
      { labelKey: 'generalOverview.jobs.transfers', value: `${s.transfers} / ${s.totalTransfers}` },
      { labelKey: 'generalOverview.jobs.checks', value: `${s.checks} / ${s.totalChecks}` },
      { labelKey: 'generalOverview.jobs.errors', value: s.errors, error: s.errors > 0 },
      { labelKey: 'generalOverview.jobs.deletes', value: s.deletes },
      { labelKey: 'generalOverview.jobs.renames', value: s.renames },
      { labelKey: 'generalOverview.jobs.updatedDirs', value: s.updatedDirs ?? 0 },
      { labelKey: 'generalOverview.jobs.serverCopies', value: s.serverSideCopies },
      { labelKey: 'generalOverview.jobs.serverMoves', value: s.serverSideMoves },
    ];
  });

  readonly runningJobViewModels = computed<RunningJobViewModel[]>(() =>
    this.runningJobs().map(job => {
      const stats = job.stats;
      const progressPercentage =
        stats && stats.totalBytes > 0 ? Math.min(100, (stats.bytes / stats.totalBytes) * 100) : 0;
      return {
        job,
        typeIcon: this.getJobTypeIcon(job),
        typeTone: this.getJobTone(job),
        animationClass: this.getJobAnimationClass(job),
        label: this.getJobLabel(job),
        origin: getStarterOrigin(job) ? null : ORIGIN_META[getExecutionOrigin(job)],
        progressPercentage,
      };
    })
  );

  getJobTypeIcon(job: JobInfo): string {
    return JOB_ICON_MAP[job.job_type] ?? 'folder';
  }

  /** The colour of the job's operation, from the operation registry; accent for any other job. */
  getJobTone(job: JobInfo): PillTone {
    return OPERATION_TONE[job.job_type] ?? 'accent';
  }

  getJobAnimationClass(job: JobInfo): string {
    return job.job_type === 'sync' || job.job_type === 'bisync' ? 'animate-spin' : '';
  }

  getJobLabel(job: JobInfo): string {
    const key = `dashboard.appDetail.${job.job_type}`;
    const translated = this.translate.instant(key);
    return translated === key ? job.job_type.replace(/_/g, ' ') : translated;
  }

  onJobRowClick(job: JobInfo): void {
    this.modalService.openJobDetail(job);
  }

  async onStopJobClick(job: JobInfo, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    try {
      await this.jobService.stopJob(job.jobid, job.remote_name);
    } catch (error) {
      console.error('Failed to stop job:', error);
    }
  }
}
