import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatExpansionModule } from '@angular/material/expansion';
import { CdkMenuModule } from '@angular/cdk/menu';
import { MatDividerModule } from '@angular/material/divider';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { CopyToClipboardDirective } from '../../shared/directives/copy-to-clipboard.directive';
import { JobInfo, CompletedTransfer } from '@app/types';
import { FormatFileSizePipe, FormatEtaPipe, FormatRateValuePipe } from '@app/pipes';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { NautilusSettingsService } from 'src/app/services/ui/nautilus-settings.service';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';

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
    TranslatePipe,
    CopyToClipboardDirective,
  ],
  templateUrl: './operations-panel.component.html',
  styleUrls: ['./operations-panel.component.scss'],
})
export class OperationsPanelComponent implements OnInit {
  private jobManagementService = inject(JobManagementService);
  private uiStateService = inject(UiStateService);
  private translate = inject(TranslateService);
  protected settings = inject(NautilusSettingsService);
  private remoteOps = inject(RemoteFileOperationsService);
  private notifications = inject(NotificationService);
  private pathService = inject(PathService);

  // Subscribe to reactive job stream
  jobs = this.jobManagementService.nautilusJobs;
  isExpanded = signal(true);
  isLoading = signal(false);

  // Selected job for bottom dock split view
  selectedJobId = signal<number | null>(null);

  selectedJob = computed(() => {
    const jobs = this.jobs();
    const id = this.selectedJobId();
    if (id !== null) {
      const found = jobs.find(j => j.jobid === id);
      if (found) return found;
    }
    return jobs.length > 0 ? jobs[0] : null;
  });

  selectJob(job: JobInfo): void {
    this.selectedJobId.set(job.jobid);
  }

  isDockedAtBottom = computed(() => this.settings.operationsPanelPosition() === 'bottom');

  setDockPosition(pos: 'sidebar' | 'bottom'): void {
    this.settings.saveOperationsPanelPosition(pos);
  }

  onResizeMouseDown(event: MouseEvent): void {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = this.settings.operationsPanelHeight();

    const onMouseMove = (moveEvent: MouseEvent): void => {
      const deltaY = startY - moveEvent.clientY;
      const newHeight = Math.max(100, Math.min(600, startHeight + deltaY));
      this.settings.saveOperationsPanelHeight(newHeight);
    };

    const onMouseUp = (): void => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  async retryTransfer(file: CompletedTransfer, job: JobInfo): Promise<void> {
    let srcFs: string;
    let srcPath: string;
    if (file.srcFs) {
      srcFs = file.srcFs;
      srcPath = file.name;
    } else {
      let sourceStr: string;
      if (Array.isArray(job.source)) {
        sourceStr = job.source.find(s => s.endsWith(file.name)) || job.source[0] || '';
      } else {
        sourceStr = job.source || '';
      }
      const split = this.pathService.splitFsPath(sourceStr);
      srcFs = this.pathService.normalizeRemoteForRclone(split.remote);
      srcPath = split.path;
    }

    let dstFsRemote = '';
    let dstFsPath = '';
    if (job.destination) {
      const split = this.pathService.splitFsPath(job.destination);
      dstFsRemote = this.pathService.normalizeRemoteForRclone(split.remote);
      dstFsPath = split.path;
    } else if (file.dstFs) {
      dstFsRemote = file.dstFs;
    }

    const parentPathInFile = this.pathService.getParentPath(file.name);
    const dstPath = this.pathService.joinPath(dstFsPath, parentPathInFile);

    try {
      await this.remoteOps.transferItems(
        [
          {
            remote: srcFs,
            path: srcPath,
            name: this.pathService.extractName(srcPath),
            isDir: false,
          },
        ],
        dstFsRemote,
        dstPath,
        'copy',
        'filemanager',
        undefined,
        job.jobid
      );

      this.notifications.showSuccess(
        this.translate.instant('shared.transferActivity.messages.resolveStarted', {
          name: this.pathService.extractName(srcPath),
        })
      );
    } catch (e) {
      console.error('Failed to retry failed transfer:', e);
      this.notifications.showError(
        this.translate.instant('shared.transferActivity.messages.resolveFailed', { error: e })
      );
    }
  }

  // Computed
  activeJobs = computed(() => this.jobs().filter(j => j.status === 'Running'));
  completedJobs = computed(() => this.jobs().filter(j => j.status !== 'Running'));
  hasJobs = computed(() => this.jobs().length > 0);

  ngOnInit(): void {
    // Initial load from backend
    this.jobManagementService.refreshJobs();
  }

  toggleExpanded(): void {
    this.isExpanded.update(v => !v);
  }

  /**
   * Return a human-readable label for the job type, using translations when available.
   */
  getJobTypeLabel(job: JobInfo): string {
    const key = `fileBrowser.operations.types.${job.job_type}`;
    const translated = this.translate.instant(key);
    // If translation returns the key itself, fall back to a prettified name
    if (translated === key) {
      return job.job_type.replace(/_/g, ' ');
    }
    return translated;
  }

  getProgress(job: JobInfo): number {
    if (!job.stats || !job.stats.totalBytes) return 0;
    return Math.round((job.stats.bytes / job.stats.totalBytes) * 100);
  }

  getFileName(job: JobInfo): string {
    return this.getJobTypeLabel(job);
  }

  resolveSourceString(source: string | string[]): string {
    if (Array.isArray(source)) {
      if (source.length === 0) return '';
      if (source.length === 1) return source[0];
      return 'multiple items';
    }
    return source || '';
  }

  getFormattedSource(source: string | string[]): string {
    if (Array.isArray(source)) {
      return source.join(', ');
    }
    return source || '';
  }

  getActualFileName(job: JobInfo): string {
    const resolvedSource = this.resolveSourceString(job.source);
    if (resolvedSource === 'multiple items' && job.stats && job.stats.totalTransfers > 0) {
      return `${job.stats.totalTransfers} files`;
    }
    const path = job.destination || resolvedSource || '';
    return this.uiStateService.extractFilename(path) || resolvedSource || job.destination;
  }

  /** Get icon for the job's operation type */
  getJobTypeIcon(job: JobInfo): string {
    switch (job.job_type) {
      case 'delete':
      case 'cleanup':
        return 'trash';
      case 'rmdirs':
        return 'broom';
      case 'copy':
        return 'copy';
      case 'copyurl':
        return 'link';
      case 'upload':
        return 'file-arrow-up';
      case 'move':
        return 'move';
      case 'rename':
        return 'pen';
      case 'sync':
      case 'bisync':
        return 'refresh';
      case 'check':
        return 'search';
      case 'archivecreate':
        return 'box-archive';
      case 'archiveextract':
        return 'unarchive';
      default:
        return 'folder';
    }
  }

  /** Whether this job is a delete-type operation (no byte progress) */
  isDeleteOperation(job: JobInfo): boolean {
    return job.job_type === 'delete' || job.job_type === 'cleanup' || job.job_type === 'rmdirs';
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
      await this.jobManagementService.refreshJobs();
    } catch (err) {
      console.error('Failed to stop job:', err);
    }
  }

  async deleteJob(job: JobInfo): Promise<void> {
    try {
      await this.jobManagementService.deleteJob(job.jobid);
      // Refresh the stream after deleting
      await this.jobManagementService.refreshJobs();
    } catch (err) {
      console.error('Failed to delete job:', err);
    }
  }

  getFormattedJobError(errors: string | string[] | undefined): string | null {
    if (!errors) return null;
    return Array.isArray(errors) ? errors.join('\n') : errors;
  }

  getTransferredFiles(job: JobInfo): CompletedTransfer[] {
    if (job.stats?.completed && job.stats.completed.length > 0) {
      return job.stats.completed;
    }
    return [];
  }

  /** Get appropriate label for the list of transferred items */
  getTransferredLabel(job: JobInfo): string {
    switch (job.job_type) {
      case 'delete':
      case 'cleanup':
      case 'rmdirs':
        return 'fileBrowser.operations.details.deletedFiles';
      case 'move':
      case 'rename':
        return 'fileBrowser.operations.details.movedFiles';
      case 'copy':
      case 'copyurl':
        return 'fileBrowser.operations.details.copiedFiles';
      case 'sync':
      case 'bisync':
        return 'fileBrowser.operations.details.syncedFiles';
      case 'upload':
        return 'fileBrowser.operations.details.uploadedFiles';
      case 'archivecreate':
      case 'archiveextract':
        return 'fileBrowser.operations.details.processedFiles';
      default:
        return 'fileBrowser.operations.details.processedFiles';
    }
  }
}
