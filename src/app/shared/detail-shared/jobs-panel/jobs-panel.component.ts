import { Component, input, output, inject, ChangeDetectionStrategy, computed } from '@angular/core';
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
  OPERATION_TONE,
  shownOrigin,
} from '@app/types';
import { FormatEtaPipe, FormatFileSizePipe, FormatRateValuePipe, FormatTimePipe } from '@app/pipes';
import { ModalService } from 'src/app/services/ui/modal.service';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { BackendTranslationService } from 'src/app/services/i18n/backend-translation.service';
import { relativeTimeLabel } from '../../utils/relative-time.util';
import { StarterPillComponent } from '../../components/starter-pill/starter-pill.component';

import { PillDirective } from '../../directives/pill.directive';
@Component({
  selector: 'app-jobs-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatCardModule,
    MatIconModule,
    MatRipple,
    MatProgressBarModule,
    FormatEtaPipe,
    FormatFileSizePipe,
    FormatRateValuePipe,
    FormatTimePipe,
    TranslatePipe,
    StarterPillComponent,
    PillDirective,
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
  private readonly backendTranslation = inject(BackendTranslationService);
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
    const typeLabel = (type: string): string => {
      const key = `dashboard.appDetail.${type}`;
      const translated = this.translate.instant(key);
      return translated === key ? type.replace(/_/g, ' ') : translated;
    };
    return this.config().jobs.map(job => {
      const statusLower = job.status.toLowerCase();
      const running = job.status === JOB_STATUS.Running;
      const hasProgress = job.job_type !== 'mount' && !!job.stats && job.stats.totalBytes > 0;
      const relative = relativeTimeLabel(job.start_time, now);
      const relativeTime = relative ? this.translate.instant(relative.key, relative.params) : '';
      const durationSeconds =
        job.start_time && (job.status === JOB_STATUS.Running || job.end_time)
          ? this.getJobDurationSeconds(job.start_time, job.end_time, now)
          : 0;
      const errorText = this.backendTranslation.translateBackendMessage(
        job.error || job.stats?.lastError
      );

      return {
        ...job,
        statusLower,
        typeLabel: typeLabel(job.job_type),
        tone: JOB_STATUS_BADGE_MAP[statusLower] || 'accent',
        relativeTime,
        durationSeconds,
        progress: hasProgress
          ? Math.max(0, Math.min(100, Math.round((job.stats.bytes / job.stats.totalBytes) * 100)))
          : 0,
        icon: JOB_ICON_MAP[job.job_type] || 'jobs',
        typeTone: OPERATION_TONE[job.job_type],
        hasProgress,
        running,
        hasFooter: running || hasProgress || !!job.dry_run || !!relativeTime || durationSeconds > 0,
        errorText,
        originBadge: shownOrigin(job),
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
      await this.jobService.stopJob(job.jobid);
    } catch (error) {
      console.error('Failed to stop job:', error);
    }
  }

  /** Enter or Space on the row itself opens the job; the stop button inside keeps its own keys. */
  onRowKey(event: Event, job: JobInfo): void {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    this.showJobDetails(job);
  }

  showJobDetails(job: JobInfo): void {
    this.modalService.openJobDetail(job);
  }
}
