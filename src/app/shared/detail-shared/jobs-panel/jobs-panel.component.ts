import { Component, input, output, inject, ChangeDetectionStrategy, computed } from '@angular/core';
import { TitleCasePipe } from '@angular/common';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatRipple } from '@angular/material/core';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { switchMap, timer } from 'rxjs';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import {
  JobInfo,
  JobsPanelConfig,
  JOB_STATUS,
  JOB_STATUS_BADGE_MAP,
  JOB_ICON_MAP,
} from '@app/types';
import { FormatFileSizePipe, FormatTimePipe } from '@app/pipes';
import { ModalService } from 'src/app/services/ui/modal.service';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { relativeTimeLabel } from '../../utils/relative-time.util';

@Component({
  selector: 'app-jobs-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TitleCasePipe,
    MatCardModule,
    MatIconModule,
    MatRipple,
    MatProgressBarModule,
    FormatFileSizePipe,
    FormatTimePipe,
    TranslatePipe,
  ],
  styleUrls: ['./jobs-panel.component.scss'],
  templateUrl: './jobs-panel.component.html',
})
export class JobsPanelComponent {
  readonly config = input.required<JobsPanelConfig>();

  readonly deleteJob = output<number>();

  private readonly modalService = inject(ModalService);
  private readonly jobService = inject(JobManagementService);
  private readonly translate = inject(TranslateService);
  private readonly lang = toSignal(this.translate.onLangChange, { initialValue: null });
  private readonly clockInterval = computed(() =>
    this.config().jobs.some(job => job.status === JOB_STATUS.Running) ? 1000 : 60000
  );
  private readonly nowTick = toSignal(
    toObservable(this.clockInterval).pipe(switchMap(interval => timer(0, interval))),
    { initialValue: 0 }
  );

  protected readonly enrichedJobs = computed(() => {
    this.lang();
    this.nowTick();
    const now = Date.now();
    return this.config().jobs.map(job => {
      const statusLower = job.status.toLowerCase();
      const hasProgress = job.job_type !== 'mount' && !!job.stats && job.stats.totalBytes > 0;
      const relative = relativeTimeLabel(job.start_time, now);
      const relativeTime = relative ? this.translate.instant(relative.key, relative.params) : '';
      const durationSeconds =
        job.start_time && (job.status === JOB_STATUS.Running || job.end_time)
          ? this.getJobDurationSeconds(job.start_time, job.end_time, now)
          : 0;
      const errorText = job.error || job.stats?.lastError || '';

      return {
        ...job,
        statusLower,
        badgeClass: JOB_STATUS_BADGE_MAP[statusLower] || 'p-accent',
        relativeTime,
        durationSeconds,
        progress: hasProgress
          ? Math.max(0, Math.min(100, Math.round((job.stats.bytes / job.stats.totalBytes) * 100)))
          : 0,
        icon: JOB_ICON_MAP[job.job_type] || 'jobs',
        iconClass: `job-icon-${job.job_type}`,
        hasProgress,
        hasFooter: hasProgress || !!job.dry_run || !!relativeTime || durationSeconds > 0,
        errorText,
      };
    });
  });

  private getJobDurationSeconds(
    startTime: string,
    endTime?: string,
    now: number = Date.now()
  ): number {
    const start = Date.parse(startTime);
    if (isNaN(start)) return 0;
    const end = endTime ? Date.parse(endTime) : now;
    return Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / 1000)) : 0;
  }

  async onStopJob(job: JobInfo): Promise<void> {
    try {
      await this.jobService.stopJob(job.jobid, job.remote_name);
    } catch (error) {
      console.error('Failed to stop job:', error);
    }
  }

  showJobDetails(job: JobInfo): void {
    this.modalService.openJobDetail(job);
  }
}
