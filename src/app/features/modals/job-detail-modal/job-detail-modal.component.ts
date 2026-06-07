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
import { CompletedTransfer, JobInfo, PathDisplayConfig } from '@app/types';
import { FormatFileSizePipe, FormatTimePipe, FormatEtaPipe } from '@app/pipes';
import {
  TransferActivityPanelComponent,
  PathDisplayComponent,
} from '../../../shared/detail-shared';
import { TransferActivityPanelConfig } from '@app/types';
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
  public readonly initialData: Partial<JobInfo> & { jobid: number } = inject(MAT_DIALOG_DATA);
  public readonly iconService = inject(IconService);
  private readonly modalService = inject(ModalService);
  private readonly jobService = inject(JobManagementService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly nautilusService = inject(NautilusService);
  private readonly pathService = inject(PathService);
  private readonly translate = inject(TranslateService);

  public readonly pathDisplayConfig = computed<PathDisplayConfig>(() => {
    const job = this.jobData();
    return {
      source: job.source,
      destination: job.destination,
      sourceLabel: this.isMount()
        ? this.translate.instant('modals.jobDetail.fields.remoteSource')
        : undefined,
      destinationLabel: this.isMount()
        ? this.translate.instant('modals.jobDetail.fields.mountPoint')
        : undefined,
      showOpenButtons: true,
      hasSource: true,
      hasDestination: true,
      isDestinationActive: true,
    };
  });

  public readonly jobData = computed<JobInfo>(() => {
    const job = this.jobService.jobs().find(j => j.jobid === this.initialData.jobid);
    if (job) return job;

    return {
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
    } as JobInfo;
  });

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
      remoteName: this.pathService.formatPathDisplay(job.source) || job.backend_name || 'Rclone',
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

  async onOpenPath(path: string): Promise<void> {
    if (this.pathService.isLocalPath(path)) {
      await this.fileSystemService.openInFiles(path);
    } else {
      const { remote: targetRemoteName, path: relativePath } = this.pathService.splitFsPath(path);
      const defaultRemote = this.jobData().remote_name;
      await this.nautilusService.newNautilusWindow(targetRemoteName || defaultRemote, relativePath);
    }
  }
}
