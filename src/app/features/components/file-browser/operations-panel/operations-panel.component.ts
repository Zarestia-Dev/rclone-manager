import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatExpansionModule } from '@angular/material/expansion';
import { JobManagementService, UiStateService } from '@app/services';
import { JobInfo } from '@app/types';
import { FormatFileSizePipe } from '@app/pipes';
import { Subject, interval } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

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
    FormatFileSizePipe,
  ],
  templateUrl: './operations-panel.component.html',
  styleUrls: ['./operations-panel.component.scss'],
})
export class OperationsPanelComponent implements OnInit, OnDestroy {
  private jobManagementService = inject(JobManagementService);
  private uiStateService = inject(UiStateService);
  private destroy$ = new Subject<void>();

  // State
  jobs = signal<JobInfo[]>([]);
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
    // Initial load
    this.loadJobs();

    // Poll every 1 seconds for updates
    interval(1000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.loadJobs();
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  async loadJobs(): Promise<void> {
    try {
      // Use dedicated API that filters on the backend
      const nautilusJobs = await this.jobManagementService.getJobsBySource('nautilus');
      this.jobs.set(nautilusJobs);
    } catch (err) {
      console.error('Failed to load jobs:', err);
    }
  }

  toggleExpanded(): void {
    this.isExpanded.update(v => !v);
  }

  getProgress(job: JobInfo): number {
    if (!job.stats || !job.stats.totalBytes) return 0;
    return Math.round((job.stats.bytes / job.stats.totalBytes) * 100);
  }

  getFileName(job: JobInfo): string {
    return this.uiStateService.extractFilename(job.destination || '');
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
      await this.loadJobs();
    } catch (err) {
      console.error('Failed to stop job:', err);
    }
  }

  async deleteJob(job: JobInfo): Promise<void> {
    try {
      await this.jobManagementService.deleteJob(job.jobid);
      await this.loadJobs();
    } catch (err) {
      console.error('Failed to delete job:', err);
    }
  }
}
