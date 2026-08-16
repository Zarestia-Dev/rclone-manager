import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { JobInfo, JobStatItem, Origin, StopJobEvent, JOB_ICON_MAP } from '@app/types';
import { FormatEtaPipe, FormatFileSizePipe, FormatRateValuePipe } from '@app/pipes';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { RcloneStatusService } from 'src/app/services/infrastructure/maintenance/rclone-status.service';
import { CopyToClipboardDirective } from '../../directives/copy-to-clipboard.directive';

export interface RunningJobViewModel {
  job: JobInfo;
  typeIcon: string;
  label: string;
  originLabel: string;
  originBadgeClass: string;
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

  readonly jobClick = output<JobInfo>();
  readonly stopJob = output<StopJobEvent>();

  private readonly jobService = inject(JobManagementService);
  private readonly rcloneStatusService = inject(RcloneStatusService);
  private readonly translate = inject(TranslateService);

  readonly selectedOriginFilter = signal<string>('all');

  readonly rawJobs = computed(() => this.jobs() ?? this.jobService.jobs());
  readonly jobStats = this.rcloneStatusService.jobStats;
  readonly isLoadingStats = this.rcloneStatusService.isLoading;

  readonly runningJobs = computed(() => {
    const all = this.rawJobs().filter(j => j.status === 'Running' && !j.parent_job_id);
    const filter = this.selectedOriginFilter();
    if (filter === 'all') return all;
    if (filter === 'quickrun') {
      return all.filter(j => j.origin === 'quickrun' || j.origin === 'flow');
    }
    if (filter === 'dashboard') {
      return all.filter(j => j.origin === 'dashboard' || !j.origin);
    }
    return all.filter(j => j.origin === filter);
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
      { labelKey: 'generalOverview.jobs.serverCopies', value: s.serverSideCopies },
      { labelKey: 'generalOverview.jobs.serverMoves', value: s.serverSideMoves },
    ];
  });

  readonly runningJobViewModels = computed<RunningJobViewModel[]>(() =>
    this.runningJobs().map(job => ({
      job,
      typeIcon: this.getJobTypeIcon(job),
      label: this.getJobLabel(job),
      originLabel: this.getOriginLabel(job.origin),
      originBadgeClass: this.getOriginBadgeClass(job.origin),
    }))
  );

  getJobTypeIcon(job: JobInfo): string {
    return JOB_ICON_MAP[job.job_type] ?? 'folder';
  }

  getJobLabel(job: JobInfo): string {
    const key = `fileBrowser.operations.types.${job.job_type}`;
    const translated = this.translate.instant(key);
    return translated === key ? job.job_type.replace(/_/g, ' ') : translated;
  }

  getOriginLabel(origin?: Origin): string {
    switch (origin) {
      case 'quickrun':
      case 'flow':
        return 'Quick Run';
      case 'dashboard':
        return 'Dashboard';
      case 'automation':
        return 'Automation';
      case 'filemanager':
        return 'Files';
      default:
        return 'Manual';
    }
  }

  getOriginBadgeClass(origin?: Origin): string {
    switch (origin) {
      case 'quickrun':
      case 'flow':
        return 'p-primary';
      case 'automation':
        return 'p-orange';
      case 'filemanager':
        return 'p-accent';
      default:
        return 'p-dim';
    }
  }

  onJobRowClick(job: JobInfo): void {
    this.jobClick.emit(job);
  }

  onStopJobClick(job: JobInfo, event: MouseEvent): void {
    event.stopPropagation();
    this.stopJob.emit({
      type: job.job_type,
      remoteName: job.remote_name,
      profileName: job.profile,
    });
  }
}
