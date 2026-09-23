import { Component, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatExpansionModule } from '@angular/material/expansion';
import { CdkMenuModule } from '@angular/cdk/menu';
import { MatDividerModule } from '@angular/material/divider';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { CopyToClipboardDirective } from '../../shared/directives/copy-to-clipboard.directive';
import { JobInfo, CompletedTransfer, JOB_ICON_MAP } from '@app/types';
import { FormatFileSizePipe, FormatEtaPipe, FormatRateValuePipe } from '@app/pipes';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

const DELETE_OPERATIONS = new Set(['delete', 'cleanup', 'rmdirs']);

const TRANSFERRED_LABEL_KEYS: Readonly<Record<string, string>> = Object.freeze({
  delete: 'fileBrowser.operations.details.deletedFiles',
  cleanup: 'fileBrowser.operations.details.deletedFiles',
  rmdirs: 'fileBrowser.operations.details.deletedFiles',
  move: 'fileBrowser.operations.details.movedFiles',
  rename: 'fileBrowser.operations.details.movedFiles',
  copy: 'fileBrowser.operations.details.copiedFiles',
  copyurl: 'fileBrowser.operations.details.copiedFiles',
  sync: 'fileBrowser.operations.details.syncedFiles',
  bisync: 'fileBrowser.operations.details.syncedFiles',
  upload: 'fileBrowser.operations.details.uploadedFiles',
});

/**
 * Pre-computes every per-job derived value the template needs so the change-detection
 * cycle can read flat fields instead of invoking helper methods (which would re-run
 * string lookups + `translate.instant()` calls on every CD pass).
 */
interface JobViewModel {
  job: JobInfo;
  typeIcon: string;
  typeLabel: string;
  statusLabel: string;
  actualFileName: string;
  formattedSource: string;
  progress: number;
  isDelete: boolean;
  transferredFiles: CompletedTransfer[];
  transferredLabel: string;
  formattedError: string | null;
}

@Component({
  selector: 'app-operations-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [
    MatIconModule,
    MatButtonModule,
    MatProgressBarModule,
    MatExpansionModule,
    CdkMenuModule,
    MatDividerModule,
    DatePipe,
    FormatFileSizePipe,
    FormatEtaPipe,
    FormatRateValuePipe,
    TranslatePipe,
    CopyToClipboardDirective,
  ],
  templateUrl: './operations-panel.component.html',
  styleUrls: ['./operations-panel.component.scss'],
})
export class OperationsPanelComponent {
  private readonly jobManagementService = inject(JobManagementService);
  private readonly pathService = inject(PathService);
  private readonly translate = inject(TranslateService);

  /** Tracks language changes so all derived labels reactively update on switch. */
  private readonly currentLang = toSignal(this.translate.onLangChange, { initialValue: null });

  // Reactive state
  jobs = this.jobManagementService.nautilusJobs;
  isExpanded = signal(true);
  contextMenuJobId = signal<number | null>(null);

  // Computed State
  activeJobs = computed(() => this.jobs().filter(j => j.status === 'Running'));
  hasJobs = computed(() => this.jobs().length > 0);

  /** Pre-computed view models for the main job list (one entry per `jobs()` item). */
  readonly jobViewModels = computed<JobViewModel[]>(() => {
    this.currentLang();
    return this.jobs().map(j => this.toJobViewModel(j));
  });

  /**
   * Pre-computed view model for the currently-open context menu (or `null`).
   * By tracking the job ID and looking up live state from `jobs()`, the open details
   * popover updates speed, bytes, ETA, and status in real-time as rclone runs.
   */
  readonly contextMenuJobVM = computed<JobViewModel | null>(() => {
    this.currentLang();
    const id = this.contextMenuJobId();
    if (id === null) return null;
    const liveJob = this.jobs().find(j => j.jobid === id);
    return liveJob ? this.toJobViewModel(liveJob) : null;
  });

  constructor() {
    void this.jobManagementService.refreshJobs();
  }

  private toJobViewModel(job: JobInfo): JobViewModel {
    return {
      job,
      typeIcon: this.getJobTypeIcon(job),
      typeLabel: this.getJobTypeLabel(job),
      statusLabel: this.getStatusLabel(job.status),
      actualFileName: this.getActualFileName(job),
      formattedSource: this.getFormattedSource(job.source),
      progress: this.getProgress(job),
      isDelete: this.isDeleteOperation(job),
      transferredFiles: this.getTransferredFiles(job),
      transferredLabel: this.getTransferredLabel(job),
      formattedError: this.getFormattedJobError(job.error),
    };
  }

  getJobTypeLabel(job: JobInfo): string {
    const key = `fileBrowser.operations.types.${job.job_type}`;
    const translated = this.translate.instant(key);
    return translated === key ? job.job_type.replace(/_/g, ' ') : translated;
  }

  getStatusLabel(status: string): string {
    switch (status) {
      case 'Running':
        return this.translate.instant('fileBrowser.operations.running');
      case 'Completed':
        return this.translate.instant('fileBrowser.operations.completed');
      case 'Failed':
        return this.translate.instant('fileBrowser.operations.failed');
      case 'Stopped':
        return this.translate.instant('fileBrowser.operations.cancelled');
      default:
        return status;
    }
  }

  getProgress(job: JobInfo): number {
    if (!job.stats || !job.stats.totalBytes) return 0;
    return Math.round((job.stats.bytes / job.stats.totalBytes) * 100);
  }

  getFormattedSource(source: string | string[]): string {
    if (Array.isArray(source)) {
      return source.join(', ');
    }
    return source || '';
  }

  getActualFileName(job: JobInfo): string {
    const isMultiSource = Array.isArray(job.source) && job.source.length > 1;
    if (isMultiSource) {
      const count = job.stats?.totalTransfers || job.source.length;
      return this.translate.instant('fileBrowser.operations.filesCount', { count });
    }

    const resolvedSource = Array.isArray(job.source) ? (job.source[0] ?? '') : job.source || '';
    const path = job.destination || resolvedSource || '';
    return this.pathService.getFilename(path) || resolvedSource || job.destination || '';
  }

  getJobTypeIcon(job: JobInfo): string {
    return JOB_ICON_MAP[job.job_type] || 'folder';
  }

  isDeleteOperation(job: JobInfo): boolean {
    return DELETE_OPERATIONS.has(job.job_type);
  }

  async stopJob(job: JobInfo): Promise<void> {
    try {
      await this.jobManagementService.stopJob(job.jobid, job.remote_name);
    } catch (err) {
      console.error('Failed to stop job:', err);
    }
  }

  async deleteJob(job: JobInfo): Promise<void> {
    try {
      await this.jobManagementService.deleteJob(job.jobid);
    } catch (err) {
      console.error('Failed to delete job:', err);
    }
  }

  getFormattedJobError(errors: string | string[] | undefined): string | null {
    if (!errors) return null;
    return Array.isArray(errors) ? errors.join('\n') : errors;
  }

  getTransferredFiles(job: JobInfo): CompletedTransfer[] {
    return job.stats?.completed?.length ? job.stats.completed : [];
  }

  getTransferredLabel(job: JobInfo): string {
    return TRANSFERRED_LABEL_KEYS[job.job_type] ?? 'fileBrowser.operations.details.processedFiles';
  }
}
