import {
  Component,
  inject,
  ChangeDetectionStrategy,
  HostListener,
  computed,
  effect,
} from '@angular/core';
import { DecimalPipe, DatePipe, TitleCasePipe } from '@angular/common';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { CompletedTransfer, JobInfo } from '@app/types';
import { FormatFileSizePipe, FormatTimePipe, FormatEtaPipe } from '@app/pipes';
import { TransferActivityPanelComponent } from '../../../shared/detail-shared';
import { TransferActivityPanelConfig } from '@app/types';
import { IconService, JobManagementService, mapRawTransfer, ModalService } from '@app/services';
import { CopyToClipboardDirective } from '@app/directives';

@Component({
  selector: 'app-job-detail-modal',
  standalone: true,
  imports: [
    MatIconModule,
    MatButtonModule,
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
    CopyToClipboardDirective,
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

  private readonly watchGroup = computed(() => {
    const job = this.jobData();
    return job.status === 'Running' ? job.group : null;
  });

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
      completedTransfers = fromJobStats.map(mapRawTransfer);
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

  public readonly progress = computed(() => {
    const job = this.jobData();
    if (!job.stats?.totalBytes) return 0;
    return (job.stats.bytes / job.stats.totalBytes) * 100;
  });

  public readonly jobStatus = computed(() => {
    return this.jobData().status.toLowerCase();
  });

  public readonly durationSeconds = computed(() => {
    const job = this.jobData();
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
  });

  public readonly showStatistics = computed(() => {
    const type = this.jobData().job_type;
    return type !== 'mount' && type !== 'serve';
  });

  public readonly statisticsTitle = computed(() => {
    return this.jobData().job_type === 'mount'
      ? 'modals.jobDetail.sections.statistics'
      : 'dashboard.appDetail.transferStatistics';
  });

  public readonly isMount = computed(() => {
    return this.jobData().job_type === 'mount';
  });

  public readonly lastError = computed(() => {
    const job = this.jobData();
    return (job.stats as any)?.lastError || job.error || null;
  });

  public readonly speedAvg = computed(() => {
    return (this.jobData().stats as any)?.speedAvg ?? 0;
  });

  public readonly healthStatus = computed(() => {
    const job = this.jobData();
    return {
      errors: job.stats?.errors ?? 0,
      retryError: job.stats?.retryError ?? false,
      fatalError: job.stats?.fatalError ?? false,
    };
  });

  public readonly fileCounters = computed(() => {
    const s = this.jobData().stats;
    if (!s) return null;
    return {
      transfers: `${s.transfers} / ${s.totalTransfers}`,
      checks: `${s.checks} / ${s.totalChecks}`,
      deletes: s.deletes + s.deletedDirs,
      renames: s.renames,
      listed: s.listed,
    };
  });

  public readonly identifiers = computed(() => {
    const job = this.jobData();
    return {
      executeId: (job as any).execute_id ?? null,
      group: job.group ?? null,
      backend: job.backend_name ?? 'Local',
      origin: job.origin ?? null,
      profile: (job as any).profile ?? 'default',
    };
  });

  constructor() {
    // Watch the group while the job is running so completed transfers stay live.
    effect(onCleanup => {
      const group = this.watchGroup();
      if (!group) return;

      this.jobService.watchGroup(group);
      onCleanup(() => this.jobService.unwatchGroup(group));
    });
  }

  @HostListener('keydown.escape')
  close(): void {
    this.modalService.animatedClose(this.dialogRef);
  }
}
