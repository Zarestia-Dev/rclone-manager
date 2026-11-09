import * as pathUtils from 'src/app/shared/utils/path.utils';
import { Component, inject, ChangeDetectionStrategy, computed } from '@angular/core';
import { DatePipe, TitleCasePipe, UpperCasePipe } from '@angular/common';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  JobInfo,
  JobMonitorConfig,
  OPERATION_METADATA,
  PathDisplayConfig,
  TransferActivityPanelConfig,
  NON_JOB_OPS,
  getStarterOrigin,
  Starter,
} from '@app/types';
import { jobReportOf } from 'src/app/shared/utils/job-report.util';
import { FormatFileSizePipe, FormatTimePipe } from '@app/pipes';
import { BackendTranslationService } from 'src/app/services/i18n/backend-translation.service';
import { AlertBannerComponent } from '../../../shared/components/alert-banner/alert-banner.component';
import { CopyToClipboardDirective } from '../../../shared/directives/copy-to-clipboard.directive';
import { JobMonitorComponent } from '../../../shared/detail-shared/job-monitor/job-monitor.component';
import { PathDisplayComponent } from '../../../shared/detail-shared/path-display/path-display.component';
import { IconService } from 'src/app/services/ui/icon.service';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { NautilusService } from 'src/app/services/ui/nautilus.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { EscapeCloseDirective } from '../../../shared/directives/escape-close.directive';

import { PillDirective } from '../../../shared/directives/pill.directive';
/** The row that names what started a job; none for work nothing started. */
function describeStarter(starter: Starter | undefined): { label: string; name: string } | null {
  switch (starter?.kind) {
    case 'profile':
      return { label: 'modals.jobDetail.fields.profile', name: starter.name };
    case 'quick_run':
      return { label: 'modals.jobDetail.fields.quickRun', name: starter.name };
    case 'workflow':
      return { label: 'modals.jobDetail.fields.workflow', name: starter.workflowName };
    case undefined:
      return null;
  }
}

@Component({
  selector: 'app-job-detail-modal',
  imports: [
    MatIconModule,
    MatButtonModule,
    TranslatePipe,
    FormatFileSizePipe,
    FormatTimePipe,
    DatePipe,
    TitleCasePipe,
    UpperCasePipe,
    JobMonitorComponent,
    PathDisplayComponent,
    AlertBannerComponent,
    CopyToClipboardDirective,
    PillDirective,
  ],
  providers: [FormatTimePipe],
  hostDirectives: [EscapeCloseDirective],
  templateUrl: './job-detail-modal.component.html',
  styleUrls: ['./job-detail-modal.component.scss', '../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JobDetailModalComponent {
  private readonly dialogRef = inject(MatDialogRef<JobDetailModalComponent>);
  readonly initialData: Partial<JobInfo> & { jobid: number } = inject(MAT_DIALOG_DATA);
  readonly iconService = inject(IconService);
  private readonly jobService = inject(JobManagementService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly nautilusService = inject(NautilusService);
  private readonly pathService = inject(PathService);
  private readonly translate = inject(TranslateService);
  private readonly formatTime = inject(FormatTimePipe);
  private readonly backendTranslation = inject(BackendTranslationService);

  readonly jobData = computed<JobInfo>(() => {
    return (
      this.jobService.getJob(
        this.initialData.execute_id ?? '',
        this.initialData.jobid,
        this.initialData.backend_name
      ) ??
      ({
        jobid: this.initialData.jobid,
        execute_id: this.initialData.execute_id ?? '',
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

    return {
      activeTransfers: stats?.transferring ?? [],
      activeChecks: stats?.checking ?? [],
      completedTransfers: stats?.completed ?? [],
      remoteName: pathUtils.formatPathDisplay(job.source) || job.backend_name || 'Rclone',
      showHistory: true,
      jobType: job.job_type,
      report: jobReportOf(job),
    };
  });

  readonly jobStatus = computed(() => this.jobData().status.toLowerCase());
  readonly isMount = computed(() => this.jobData().job_type === 'mount');
  readonly showStatistics = computed(
    () => !(NON_JOB_OPS as readonly string[]).includes(this.jobData().job_type)
  );

  /** What went wrong, for the operations that have no monitor to show it. */
  readonly lastError = computed(() => {
    if (this.showStatistics()) return null;
    const error = this.jobData().stats?.lastError || this.jobData().error;
    return error ? this.backendTranslation.translateBackendMessage(error) || null : null;
  });
  readonly durationSeconds = computed(() => {
    const job = this.jobData();
    if (job.start_time && job.end_time) {
      const start = Date.parse(job.start_time);
      const end = Date.parse(job.end_time);
      if (!isNaN(start) && !isNaN(end) && end >= start) return (end - start) / 1000;
    }
    return job.stats?.transferTime ?? job.stats?.elapsedTime ?? 0;
  });

  readonly jobMonitorConfig = computed<JobMonitorConfig>(() => {
    const job = this.jobData();
    const operation = OPERATION_METADATA[job.job_type];
    const seconds = this.durationSeconds();
    return {
      jobType: job.job_type,
      title: operation?.typeLabel
        ? this.translate.instant(operation.typeLabel)
        : job.job_type.charAt(0).toUpperCase() + job.job_type.slice(1),
      icon: operation?.icon ?? 'jobs',
      jobId: job.jobid,
      status: job.status,
      running: this.jobStatus() === 'running',
      dryRun: job.dry_run,
      error: job.stats?.lastError || job.error || undefined,
      startTime: job.start_time,
      endTime: job.end_time ?? undefined,
      duration: seconds > 0 ? this.formatTime.transform(seconds) : undefined,
      stats: job.stats,
      activity: this.transferActivityConfig(),
    };
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
      deletes: s.deletes + s.deletedDirs,
      renames: s.renames,
      updatedDirs: s.updatedDirs ?? 0,
      listed: s.listed,
    };
  });

  readonly identifiers = computed(() => {
    const job = this.jobData();
    return {
      executeId: job.execute_id || null,
      group: job.group ?? null,
      backend: job.backend_name ?? 'Local',
      origin: getStarterOrigin(job) ?? job.origin ?? null,
      starter: describeStarter(job.starter),
      // A Quick Run a workflow node ran is started by both: the workflow gets its own row.
      viaWorkflow:
        job.starter?.kind === 'quick_run' ? (job.starter.workflow?.workflowName ?? null) : null,
    };
  });

  readonly activeGroup = computed(() => {
    const job = this.jobData();
    return job.status === 'Running' ? job.group : null;
  });

  close(): void {
    this.dialogRef.close();
  }

  async onResetStats(): Promise<void> {
    const group = this.jobData().group;
    if (!group) return;
    try {
      await this.jobService.resetGroupStats(group);
    } catch (error) {
      console.error('Failed to reset job stats:', error);
    }
  }

  async onDeleteJob(): Promise<void> {
    try {
      await this.jobService.deleteJob(this.jobData().jobid);
      this.close();
    } catch (error) {
      console.error('Failed to delete job:', error);
    }
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
