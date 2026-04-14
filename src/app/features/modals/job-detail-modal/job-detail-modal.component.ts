import {
  Component,
  inject,
  ChangeDetectionStrategy,
  HostListener,
  computed,
  effect,
} from '@angular/core';
import { CommonModule, DecimalPipe, DatePipe, TitleCasePipe } from '@angular/common';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { CompletedTransfer, JobInfo } from '@app/types';
import { FormatFileSizePipe } from 'src/app/shared/pipes/format-file-size.pipe';
import { FormatTimePipe } from 'src/app/shared/pipes/format-time.pipe';
import { FormatEtaPipe } from 'src/app/shared/pipes/format-eta.pipe';
import { TransferActivityPanelComponent } from '../../../shared/detail-shared';
import { TransferActivityPanelConfig } from '@app/types';
import { IconService, JobManagementService, mapRawTransfer, ModalService } from '@app/services';

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
    TransferActivityPanelComponent,
  ],
  templateUrl: './job-detail-modal.component.html',
  styleUrls: ['./job-detail-modal.component.scss', '../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JobDetailModalComponent {
  private readonly dialogRef = inject(MatDialogRef<JobDetailModalComponent>);
  public readonly initialData: JobInfo = inject(MAT_DIALOG_DATA);
  public readonly iconService = inject(IconService);
  private readonly modalService = inject(ModalService);
  private readonly jobService = inject(JobManagementService);

  public readonly jobData = computed(
    () => this.jobService.jobs().find(j => j.jobid === this.initialData.jobid) ?? this.initialData
  );

  public readonly transferActivityConfig = computed<TransferActivityPanelConfig>(() => {
    const job = this.jobData();
    const stats = job.stats;

    let completedTransfers: CompletedTransfer[];

    if (job.status === 'Running' && job.group) {
      // While running, prioritize the stable group watcher in JobManagementService
      completedTransfers = this.jobService.groupTransfersMap().get(job.group) ?? [];
    } else {
      // Once finished or if no group, use the job stats completion list
      const fromJobStats = ((stats as any)?.completed ?? []) as any[];
      completedTransfers = fromJobStats.map(item =>
        mapRawTransfer({ ...item, src_fs: item.srcFs, dst_fs: item.dstFs })
      );
    }

    // Sort by completion time (latest first)
    const combined = [...completedTransfers].sort((a, b) => {
      const dateA = a.completedAt ? new Date(a.completedAt).getTime() : 0;
      const dateB = b.completedAt ? new Date(b.completedAt).getTime() : 0;
      return dateB - dateA;
    });

    return {
      activeTransfers: stats?.transferring ?? [],
      completedTransfers: combined,
      remoteName: job.source || job.backend_name || 'Rclone',
      showHistory: true,
    };
  });

  constructor() {
    // Watch the group while the job is running so completed transfers stay live.
    effect(onCleanup => {
      const job = this.jobData();
      if (!job.group || job.status !== 'Running') return;

      this.jobService.watchGroup(job.group);
      onCleanup(() => this.jobService.unwatchGroup(job.group!));
    });
  }

  getProgress(job: JobInfo): number {
    if (!job.stats?.totalBytes) return 0;
    return (job.stats.bytes / job.stats.totalBytes) * 100;
  }

  getJobStatus(job: JobInfo): string {
    return job.status.toLowerCase();
  }

  getJobDurationSeconds(job: JobInfo): number {
    try {
      if (job.start_time && job.end_time) {
        const start = Date.parse(job.start_time as unknown as string);
        const end = Date.parse(job.end_time as unknown as string);
        if (!isNaN(start) && !isNaN(end) && end >= start) return (end - start) / 1000;
      }
    } catch {
      return 0;
    }
    return (job.stats as any)?.transferTime ?? job.stats?.elapsedTime ?? 0;
  }

  get showStatistics(): boolean {
    const type = this.jobData().job_type;
    return type !== 'mount' && type !== 'serve';
  }

  get statisticsTitle(): string {
    return this.jobData().job_type === 'mount'
      ? 'modals.jobDetail.sections.statistics'
      : 'dashboard.appDetail.transferStatistics';
  }

  get isMount(): boolean {
    return this.jobData().job_type === 'mount';
  }

  get lastError(): string | null {
    const job = this.jobData();
    return (job.stats as any)?.lastError || job.error || null;
  }

  get speedAvg(): number {
    return (this.jobData().stats as any)?.speedAvg ?? 0;
  }

  get healthStatus() {
    const job = this.jobData();
    return {
      errors: job.stats?.errors ?? 0,
      retryError: job.stats?.retryError ?? false,
      fatalError: job.stats?.fatalError ?? false,
    };
  }

  get fileCounters() {
    const s = this.jobData().stats;
    if (!s) return null;
    return {
      transfers: `${s.transfers} / ${s.totalTransfers}`,
      checks: `${s.checks} / ${s.totalChecks}`,
      deletes: s.deletes + s.deletedDirs,
      renames: s.renames,
      listed: s.listed,
    };
  }

  get identifiers() {
    const job = this.jobData();
    return {
      executeId: (job as any).execute_id ?? null,
      group: job.group ?? null,
      backend: job.backend_name ?? 'Local',
      origin: job.origin ?? null,
      profile: (job as any).profile ?? 'default',
    };
  }

  @HostListener('keydown.escape')
  close(): void {
    this.modalService.animatedClose(this.dialogRef);
  }
}
