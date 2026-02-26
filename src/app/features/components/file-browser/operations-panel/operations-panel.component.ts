import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatExpansionModule } from '@angular/material/expansion';
import { CdkMenuModule } from '@angular/cdk/menu';
import { MatDividerModule } from '@angular/material/divider';
import { JobManagementService, UiStateService, NotificationService } from '@app/services';
import { JobInfo } from '@app/types';
import { FormatFileSizePipe, FormatEtaPipe, FormatRateValuePipe } from '@app/pipes';
import { Subject, interval } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

@Component({
  selector: 'app-operations-panel',
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatProgressBarModule,
    MatTooltipModule,
    MatExpansionModule,
    CdkMenuModule,
    MatDividerModule,
    DatePipe,
    FormatFileSizePipe,
    FormatEtaPipe,
    FormatRateValuePipe,
    TranslateModule,
  ],
  templateUrl: './operations-panel.component.html',
  styleUrls: ['./operations-panel.component.scss'],
})
export class OperationsPanelComponent implements OnInit, OnDestroy {
  private jobManagementService = inject(JobManagementService);
  private uiStateService = inject(UiStateService);
  private notificationService = inject(NotificationService);
  private translate = inject(TranslateService);
  private destroy$ = new Subject<void>();

  // Subscribe to reactive job stream
  jobs = toSignal(this.jobManagementService.nautilusJobs$, { initialValue: [] });
  isExpanded = signal(true);
  isLoading = signal(false);

  // Computed
  get activeJobs(): JobInfo[] {
    return this.jobs().filter(j => j.status === 'Running');
  }

  get completedJobs(): JobInfo[] {
    return this.jobs().filter(j => j.status !== 'Running');
  }

  get hasJobs(): boolean {
    return this.jobs().length > 0;
  }

  ngOnInit(): void {
    // Initial load from backend
    this.jobManagementService.refreshNautilusJobs();

    // Adaptive polling: only poll when there are active jobs
    interval(1000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        // Only poll if there are active running jobs
        if (this.activeJobs.length > 0) {
          this.jobManagementService.refreshNautilusJobs();
        }
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  toggleExpanded(): void {
    this.isExpanded.update(v => !v);
  }

  getProgress(job: JobInfo): number {
    if (!job.stats || !job.stats.totalBytes) return 0;
    return Math.round((job.stats.bytes / job.stats.totalBytes) * 100);
  }

  getFileName(job: JobInfo): string {
    const path = job.destination || job.source || '';
    return this.uiStateService.extractFilename(path);
  }

  /** Get icon for the job's operation type */
  getJobTypeIcon(job: JobInfo): string {
    switch (job.job_type) {
      case 'delete_file':
      case 'purge':
      case 'cleanup':
        return 'trash';
      case 'rmdirs':
        return 'broom';
      case 'copy':
      case 'copy_file':
      case 'copy_url':
        return 'copy';
      case 'move':
      case 'move_file':
        return 'move';
      case 'sync':
      case 'bisync':
        return 'arrows-rotate';
      default:
        return 'folder';
    }
  }

  /** Whether this job is a delete-type operation (no byte progress) */
  isDeleteOperation(job: JobInfo): boolean {
    return (
      job.job_type === 'delete_file' ||
      job.job_type === 'purge' ||
      job.job_type === 'cleanup' ||
      job.job_type === 'rmdirs'
    );
  }

  getStatusIcon(job: JobInfo): string {
    switch (job.status) {
      case 'Running':
        return 'refresh';
      case 'Completed':
        return 'circle-check';
      case 'Failed':
        return 'circle-xmark';
      case 'Stopped':
        return 'stop';
      default:
        return 'circle';
    }
  }

  async stopJob(job: JobInfo): Promise<void> {
    try {
      await this.jobManagementService.stopJob(job.jobid, job.remote_name);
      // Refresh the stream after stopping
      await this.jobManagementService.refreshNautilusJobs();
    } catch (err) {
      console.error('Failed to stop job:', err);
    }
  }

  async deleteJob(job: JobInfo): Promise<void> {
    try {
      await this.jobManagementService.deleteJob(job.jobid);
      // Refresh the stream after deleting
      await this.jobManagementService.refreshNautilusJobs();
    } catch (err) {
      console.error('Failed to delete job:', err);
    }
  }

  async copyError(error: string): Promise<void> {
    if (!error) return;
    try {
      await navigator.clipboard.writeText(error);
      this.notificationService.showSuccess(this.translate.instant('common.errorCopied'));
    } catch (err) {
      console.error('Failed to copy error:', err);
      this.notificationService.showError(this.translate.instant('common.error'));
    }
  }
}
