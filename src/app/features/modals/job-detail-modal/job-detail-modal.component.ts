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
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { JobInfo, PathDisplayConfig, TransferActivityPanelConfig } from '@app/types';
import { FormatFileSizePipe, FormatTimePipe, FormatEtaPipe } from '@app/pipes';
import {
  TransferActivityPanelComponent,
  PathDisplayComponent,
} from '../../../shared/detail-shared';
import {
  IconService,
  JobManagementService,
  mapRawTransfer,
  ModalService,
  FileSystemService,
  NautilusService,
  PathService,
} from '@app/services';
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
    PathDisplayComponent,
    CopyToClipboardDirective,
  ],
  templateUrl: './job-detail-modal.component.html',
  styleUrls: ['./job-detail-modal.component.scss', '../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JobDetailModalComponent {
  private readonly dialogRef = inject(MatDialogRef<JobDetailModalComponent>);
  readonly initialData: Partial<JobInfo> & { jobid: number } = inject(MAT_DIALOG_DATA);
  readonly iconService = inject(IconService);
  private readonly modalService = inject(ModalService);
  private readonly jobService = inject(JobManagementService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly nautilusService = inject(NautilusService);
  private readonly pathService = inject(PathService);
  private readonly translate = inject(TranslateService);

  readonly jobData = computed<JobInfo>(() => {
    return (
      this.jobService.jobs().find(j => j.jobid === this.initialData.jobid) ??
      ({
        jobid: this.initialData.jobid,
        execute_id: (this.initialData as any).execute_id,
        job_type: this.initialData.job_type ?? 'sync',
        source: this.initialData.source ?? [],
        destination: this.initialData.destination ?? '',
        start_time: this.initialData.start_time ?? new Date().toISOString(),
        status: this.initialData.status ?? 'Running',
        remote_name: this.initialData.remote_name ?? '',
        group: this.initialData.group ?? '',
        backend_name: this.initialData.backend_name ?? 'Local',
        stats: this.initialData.stats ?? {
          bytes: 0,
          totalBytes: 0,
          speed: 0,
          eta: 0,
          totalTransfers: 0,
          transfers: 0,
          errors: 0,
          checks: 0,
          totalChecks: 0,
          deletedDirs: 0,
          deletes: 0,
          renames: 0,
          serverSideCopies: 0,
          serverSideMoves: 0,
          elapsedTime: 0,
          lastError: '',
          fatalError: false,
          retryError: false,
          serverSideCopyBytes: 0,
          serverSideMoveBytes: 0,
          transferTime: 0,
          transferring: [],
          listed: 0,
        },
      } as JobInfo)
    );
  });

  readonly pathDisplayConfig = computed<PathDisplayConfig>(() => {
    const job = this.jobData();
    const isMountOp = job.job_type === 'mount';
    return {
      source: job.source,
      destination: job.destination,
      sourceLabel: isMountOp
        ? this.translate.instant('modals.jobDetail.fields.remoteSource')
        : undefined,
      destinationLabel: isMountOp
        ? this.translate.instant('modals.jobDetail.fields.mountPoint')
        : undefined,
      showOpenButtons: true,
      hasSource: true,
      hasDestination: true,
      isDestinationActive: true,
    };
  });

  readonly transferActivityConfig = computed<TransferActivityPanelConfig>(() => {
    const job = this.jobData();
    const stats = job.stats;

    const completedTransfers =
      job.status === 'Running' && job.group
        ? (this.jobService.groupTransfersMap().get(job.group) ?? [])
        : (((stats as any)?.completed ?? []) as any[]).map(mapRawTransfer);

    const combined = [...completedTransfers].sort((a, b) => {
      const timeA = a.completedAt ? Date.parse(a.completedAt) : 0;
      const timeB = b.completedAt ? Date.parse(b.completedAt) : 0;
      return timeB - timeA;
    });

    return {
      activeTransfers: stats?.transferring ?? [],
      completedTransfers: combined,
      remoteName: this.pathService.formatPathDisplay(job.source) || job.backend_name || 'Rclone',
      showHistory: true,
    };
  });

  readonly progress = computed(() => {
    const stats = this.jobData().stats;
    return stats?.totalBytes ? (stats.bytes / stats.totalBytes) * 100 : 0;
  });

  readonly jobStatus = computed(() => this.jobData().status.toLowerCase());
  readonly isMount = computed(() => this.jobData().job_type === 'mount');
  readonly showStatistics = computed(() => !['mount', 'serve'].includes(this.jobData().job_type));
  readonly speedAvg = computed(() => (this.jobData().stats as any)?.speedAvg ?? 0);
  readonly lastError = computed(
    () => (this.jobData().stats as any)?.lastError || this.jobData().error || null
  );

  readonly statisticsTitle = computed(() =>
    this.jobData().job_type === 'mount'
      ? 'modals.jobDetail.sections.statistics'
      : 'dashboard.appDetail.transferStatistics'
  );

  readonly durationSeconds = computed(() => {
    const job = this.jobData();
    if (job.start_time && job.end_time) {
      const start = Date.parse(job.start_time);
      const end = Date.parse(job.end_time);
      if (!isNaN(start) && !isNaN(end) && end >= start) return (end - start) / 1000;
    }
    return (job.stats as any)?.transferTime ?? job.stats?.elapsedTime ?? 0;
  });

  readonly healthStatus = computed(() => {
    const stats = this.jobData().stats;
    return {
      errors: stats?.errors ?? 0,
      retryError: stats?.retryError ?? false,
      fatalError: stats?.fatalError ?? false,
    };
  });

  readonly fileCounters = computed(() => {
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

  readonly identifiers = computed(() => {
    const job = this.jobData();
    return {
      executeId: (job as any).execute_id ?? null,
      group: job.group ?? null,
      backend: job.backend_name ?? 'Local',
      origin: job.origin ?? null,
      profile: (job as any).profile ?? 'default',
    };
  });

  readonly activeGroup = computed(() => {
    const job = this.jobData();
    return job.status === 'Running' ? job.group : null;
  });

  constructor() {
    effect(onCleanup => {
      const group = this.activeGroup();
      if (!group) return;

      this.jobService.watchGroup(group);
      onCleanup(() => this.jobService.unwatchGroup(group));
    });
  }

  @HostListener('keydown.escape')
  close(): void {
    this.modalService.animatedClose(this.dialogRef);
  }

  async onOpenPath(path: string): Promise<void> {
    if (this.pathService.isLocalPath(path)) {
      await this.fileSystemService.openInFiles(path);
    } else {
      const { remote: targetRemoteName, path: relativePath } = this.pathService.splitFsPath(path);
      await this.nautilusService.newNautilusWindow(
        targetRemoteName || this.jobData().remote_name,
        relativePath
      );
    }
  }
}
