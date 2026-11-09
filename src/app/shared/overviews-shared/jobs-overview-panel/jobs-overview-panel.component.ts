import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  model,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
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
} from '@app/types';
import { FormatEtaPipe, FormatFileSizePipe, FormatRateValuePipe } from '@app/pipes';
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
  originLabel: string;
  originTone: PillTone;
  progressPercentage: number;
}

@Component({
  selector: 'app-jobs-overview-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
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
  readonly hideToggle = input<boolean>(false);

  readonly jobs = input<JobInfo[] | undefined>(undefined);
  readonly defaultOriginFilter = input<Origin | Origin[] | 'all'>('all');
  readonly showFilterChips = input<boolean>(false);

  private readonly jobService = inject(JobManagementService);
  private readonly rcloneStatusService = inject(RcloneStatusService);
  private readonly modalService = inject(ModalService);
  private readonly translate = inject(TranslateService);

  readonly selectedOriginFilter = linkedSignal<string>(() => {
    const def = this.defaultOriginFilter();
    if (typeof def === 'string') return def;
    if (Array.isArray(def) && def.length > 0) return def[0];
    return 'all';
  });

  readonly rawJobs = computed(() => this.jobs() ?? this.jobService.jobs());
  readonly jobStats = this.rcloneStatusService.jobStats;
  readonly isLoadingStats = this.rcloneStatusService.isLoading;

  readonly runningJobs = computed(() => {
    const all = this.rawJobs().filter(j => j.status === 'Running' && !j.parent_job_id);
    const filter = this.selectedOriginFilter();
    if (filter === 'all') return all;
    return all.filter(j => getExecutionOrigin(j) === filter);
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
        originLabel: this.getOriginLabel(getExecutionOrigin(job)),
        originTone: this.getOriginTone(getExecutionOrigin(job)),
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

  getOriginLabel(origin?: Origin): string {
    switch (origin) {
      case 'workflow': {
        const t = this.translate.instant('flow.tabs.workflow');
        return t === 'flow.tabs.workflow' ? 'Workflow' : t;
      }
      case 'quickrun': {
        const t = this.translate.instant('flow.tabs.quickRun');
        return t === 'flow.tabs.quickRun' ? 'Quick Run' : t;
      }
      case 'dashboard': {
        const t = this.translate.instant('navigation.dashboard');
        return t === 'navigation.dashboard' ? 'Dashboard' : t;
      }
      case 'automation': {
        const t = this.translate.instant('generalOverview.panels.automations');
        return t === 'generalOverview.panels.automations' ? 'Automation' : t;
      }
      case 'filemanager': {
        const t = this.translate.instant('navigation.files');
        return t === 'navigation.files' ? 'Files' : t;
      }
      default:
        return 'Manual';
    }
  }

  getOriginTone(origin?: Origin): PillTone {
    switch (origin) {
      case 'workflow':
        return 'accent';
      case 'quickrun':
        return 'primary';
      case 'automation':
        return 'orange';
      case 'filemanager':
        return 'accent';
      default:
        return 'dim';
    }
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
