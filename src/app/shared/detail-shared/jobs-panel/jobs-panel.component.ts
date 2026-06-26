import { Component, input, output, inject, ChangeDetectionStrategy, computed } from '@angular/core';
import { TitleCasePipe } from '@angular/common';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatRipple } from '@angular/material/core';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  JobInfo,
  JobsPanelConfig,
  PrimaryActionType,
  StopJobEvent,
  JOB_STATUS_BADGE_MAP,
  JOB_ICON_MAP,
} from '../../types';
import { FormatFileSizePipe, FormatTimePipe } from '@app/pipes';
import { ModalService } from 'src/app/services/ui/modal.service';

@Component({
  selector: 'app-jobs-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [
    TitleCasePipe,
    MatCardModule,
    MatIconModule,
    MatRipple,
    MatProgressBarModule,
    MatTooltipModule,
    FormatFileSizePipe,
    FormatTimePipe,
    TranslatePipe,
  ],
  styleUrls: ['./jobs-panel.component.scss'],
  template: `
    @let cfg = config();

    <mat-card class="detail-panel jobs-panel">
      <mat-card-header class="panel-header">
        <mat-card-title>
          <mat-icon svgIcon="jobs" style="color: var(--op-color, var(--primary-color));"></mat-icon>
          <span>{{ 'detailShared.jobs.title' | translate }}</span>
          <span class="app-pill p-accent">{{ cfg.jobs.length }}</span>
        </mat-card-title>
      </mat-card-header>

      <mat-card-content class="card-list-container">
        @for (job of enrichedJobs(); track job.jobid) {
          <div
            class="card-row-item"
            role="button"
            tabindex="0"
            (click)="showJobDetails(job)"
            (keydown.enter)="showJobDetails(job)"
            (keydown.space)="$event.preventDefault(); showJobDetails(job)"
          >
            <div class="card-header">
              <div class="card-info-left">
                <mat-icon
                  [svgIcon]="job.icon"
                  class="card-primary-icon job-type-icon"
                  [class]="job.iconClass"
                ></mat-icon>
                <span class="card-title-text job-type-text">
                  {{ job.job_type | titlecase }}
                </span>
                <span
                  class="job-id-label"
                  [matTooltip]="
                    job.execute_id
                      ? ('modals.jobDetail.fields.executeId' | translate) + ': ' + job.execute_id
                      : ''
                  "
                  >#{{ job.jobid }}</span
                >
                @if (job.profile) {
                  <span class="profile-name">{{ job.profile }}</span>
                }
              </div>

              <div class="card-info-right">
                <span
                  class="app-pill"
                  [class]="job.badgeClass"
                  [class.has-error]="job.statusLower === 'failed' && job.errorText"
                  [matTooltip]="job.statusLower === 'failed' && job.errorText ? job.errorText : ''"
                >
                  {{ 'detailShared.jobs.status.' + job.statusLower | translate }}
                </span>

                <button
                  type="button"
                  class="action-button"
                  [class.stop-button]="job.statusLower === 'running'"
                  [class.delete-button]="job.statusLower !== 'running'"
                  [matTooltip]="
                    (job.statusLower === 'running'
                      ? 'detailShared.jobs.actions.stop'
                      : 'detailShared.jobs.actions.delete'
                    ) | translate
                  "
                  (click)="
                    job.statusLower === 'running' ? onStopJob(job) : deleteJob.emit(job.jobid);
                    $event.stopPropagation()
                  "
                  matRipple
                  [matRippleCentered]="true"
                  [matRippleUnbounded]="false"
                  tabindex="-1"
                >
                  <mat-icon [svgIcon]="job.statusLower === 'running' ? 'stop' : 'trash'"></mat-icon>
                </button>
              </div>
            </div>

            @if (job.hasProgress) {
              <div class="card-progress">
                <mat-progress-bar mode="determinate" [value]="job.progress"></mat-progress-bar>
                <span class="percentage-text">{{ job.progress }}%</span>
              </div>
            }

            @if (job.hasFooter) {
              <div class="card-footer">
                <div class="card-footer-left">
                  <span class="size-text">
                    @if (job.hasProgress) {
                      {{ job.stats.bytes | formatFileSize }} /
                      {{ job.stats.totalBytes | formatFileSize }}
                    }
                  </span>
                </div>
                <div class="card-footer-right">
                  @if (job.dry_run) {
                    <span class="app-pill p-accent dry-run-badge">
                      {{ 'detailShared.jobs.dryRun' | translate }}
                    </span>
                  }
                  @if (job.durationSeconds > 0) {
                    <span class="duration-text">{{ job.durationSeconds | formatTime }}</span>
                  }
                  @if (job.relativeTime) {
                    <span class="time-text">{{ job.relativeTime }}</span>
                  }
                </div>
              </div>
            }
          </div>
        } @empty {
          <div class="empty-state">
            <mat-icon svgIcon="jobs"></mat-icon>
            <span>{{ 'detailShared.jobs.empty' | translate }}</span>
          </div>
        }
      </mat-card-content>
    </mat-card>
  `,
})
export class JobsPanelComponent {
  readonly config = input.required<JobsPanelConfig>();

  readonly stopJob = output<StopJobEvent>();
  readonly deleteJob = output<number>();

  private readonly modalService = inject(ModalService);
  private readonly translate = inject(TranslateService);
  private readonly lang = toSignal(this.translate.onLangChange, { initialValue: null });

  protected readonly enrichedJobs = computed(() => {
    this.lang(); // Track locale context changes inside Zoneless Architecture

    return this.config().jobs.map(job => {
      const statusLower = job.status.toLowerCase();
      const hasProgress = job.job_type !== 'mount' && !!job.stats && job.stats.totalBytes > 0;
      const relativeTime = job.start_time ? this.getRelativeTime(job.start_time) : '';
      const durationSeconds = job.start_time
        ? this.getJobDurationSeconds(job.start_time, job.end_time)
        : 0;
      const errorText = job.error || job.stats?.lastError || '';

      return {
        ...job,
        statusLower,
        badgeClass: JOB_STATUS_BADGE_MAP[statusLower] || 'p-accent',
        relativeTime,
        durationSeconds,
        progress: hasProgress ? Math.round((job.stats.bytes / job.stats.totalBytes) * 100) : 0,
        icon: JOB_ICON_MAP[job.job_type] || 'jobs',
        iconClass: `job-icon-${job.job_type}`,
        hasProgress,
        hasFooter: hasProgress || !!job.dry_run || !!relativeTime || durationSeconds > 0,
        errorText,
      };
    });
  });

  private getJobDurationSeconds(startTime: string, endTime?: string): number {
    const start = Date.parse(startTime);
    if (isNaN(start)) return 0;
    const end = endTime ? Date.parse(endTime) : Date.now();
    return Math.max(0, Math.floor((end - start) / 1000));
  }

  private getRelativeTime(timestamp: string): string {
    const diff = Date.now() - Date.parse(timestamp);
    const minutes = Math.floor(diff / 60000);
    if (minutes <= 0) return this.translate.instant('shared.transferActivity.time.justNow');
    const hours = Math.floor(minutes / 60);
    if (hours <= 0)
      return this.translate.instant('shared.transferActivity.time.minutesAgo', { count: minutes });
    const days = Math.floor(hours / 24);
    if (days <= 0)
      return this.translate.instant('shared.transferActivity.time.hoursAgo', { count: hours });
    return this.translate.instant('shared.transferActivity.time.daysAgo', { count: days });
  }

  onStopJob(job: JobInfo): void {
    this.stopJob.emit({
      type: job.job_type as PrimaryActionType,
      remoteName: job.remote_name,
      profileName: job.profile,
    });
  }

  showJobDetails(job: JobInfo): void {
    this.modalService.openJobDetail(job);
  }
}
