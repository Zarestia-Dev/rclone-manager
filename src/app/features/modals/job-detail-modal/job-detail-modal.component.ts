import { Component, inject, ChangeDetectionStrategy, HostListener } from '@angular/core';
import { CommonModule, DecimalPipe, DatePipe, TitleCasePipe } from '@angular/common';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { JobInfo } from '@app/types';
import { FormatFileSizePipe } from 'src/app/shared/pipes/format-file-size.pipe';
import { FormatTimePipe } from 'src/app/shared/pipes/format-time.pipe';
import { FormatEtaPipe } from 'src/app/shared/pipes/format-eta.pipe';
import { ModalService, IconService } from '@app/services';

@Component({
  selector: 'app-job-detail-modal',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatIconModule,
    MatButtonModule,
    MatDividerModule,
    MatProgressBarModule,
    MatTooltipModule,
    TranslateModule,
    FormatFileSizePipe,
    FormatTimePipe,
    FormatEtaPipe,
    DecimalPipe,
    DatePipe,
    TitleCasePipe,
  ],
  templateUrl: './job-detail-modal.component.html',
  styleUrls: ['./job-detail-modal.component.scss', '../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JobDetailModalComponent {
  private dialogRef = inject(MatDialogRef<JobDetailModalComponent>);
  public data: JobInfo = inject(MAT_DIALOG_DATA);
  public iconService = inject(IconService);
  private modalService = inject(ModalService);

  getProgress(job: JobInfo): number {
    if (!job.stats) return 0;
    if (!job.stats.totalBytes) return 0;
    return (job.stats.bytes / job.stats.totalBytes) * 100;
  }

  getJobStatus(job: JobInfo): string {
    return job.status.toLowerCase();
  }

  /**
   * Compute job duration in seconds.
   * Priority:
   *  1. Use explicit `end_time - start_time` when both present.
   *  2. Use `stats.transferTime` if available (rclone reports seconds).
   *  3. Fallback to `stats.elapsedTime` (may be group-level value).
   */
  getJobDurationSeconds(job: JobInfo): number {
    try {
      if (job.start_time && job.end_time) {
        const start = Date.parse(job.start_time as unknown as string);
        const end = Date.parse(job.end_time as unknown as string);
        if (!isNaN(start) && !isNaN(end) && end >= start) {
          return (end - start) / 1000;
        }
      }

      if (job.stats && (job.stats as any).transferTime) {
        return (job.stats as any).transferTime;
      }

      return job.stats?.elapsedTime ?? 0;
    } catch {
      return job.stats?.elapsedTime ?? 0;
    }
  }

  get completedTransfers(): any[] {
    return (this.data.stats as any).completed || [];
  }

  get hasActivity(): boolean {
    return (this.data.stats?.transferring?.length || 0) > 0 || this.completedTransfers.length > 0;
  }

  get showStatistics(): boolean {
    return this.data.job_type !== 'mount';
  }

  get statisticsTitle(): string {
    if (this.data.job_type === 'mount') {
      return 'modals.jobDetail.sections.statistics'; // Fallback or "Mount Status"
    }

    // Use current job type to form a dynamic title like "Sync Statistics"
    // Using dashboard.appDetail.transferStatistics key which is "{{op}} Statistics"
    return 'dashboard.appDetail.transferStatistics';
  }

  get isMount(): boolean {
    return this.data.job_type === 'mount';
  }

  get lastError(): string | null {
    return (this.data.stats as any)?.lastError || this.data.error || null;
  }

  @HostListener('keydown.escape')
  close(): void {
    this.modalService.animatedClose(this.dialogRef);
  }
}
