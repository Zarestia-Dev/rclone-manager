import { Component, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
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

@Component({
  selector: 'app-operations-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
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
export class OperationsPanelComponent {
  private readonly jobManagementService = inject(JobManagementService);
  private readonly uiStateService = inject(UiStateService);
  private readonly translate = inject(TranslateService);
  protected readonly settings = inject(NautilusSettingsService);

  // Reactive state
  jobs = this.jobManagementService.nautilusJobs;
  isExpanded = signal(true);
  contextMenuJob = signal<JobInfo | null>(null);

  // Computed State
  activeJobs = computed(() => this.jobs().filter(j => j.status === 'Running'));
  completedJobs = computed(() => this.jobs().filter(j => j.status !== 'Running'));
  hasJobs = computed(() => this.jobs().length > 0);

  constructor() {
    this.jobManagementService.refreshJobs();
  }

  toggleExpanded(): void {
    this.isExpanded.update(v => !v);
  }

  getJobTypeLabel(job: JobInfo): string {
    const key = `fileBrowser.operations.types.${job.job_type}`;
    const translated = this.translate.instant(key);
    return translated === key ? job.job_type.replace(/_/g, ' ') : translated;
  }

  getProgress(job: JobInfo): number {
    if (!job.stats || !job.stats.totalBytes) return 0;
    return Math.round((job.stats.bytes / job.stats.totalBytes) * 100);
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
    return this.uiStateService.extractFilename(path) || resolvedSource || job.destination || '';
  }

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

  isDeleteOperation(job: JobInfo): boolean {
    return ['delete', 'cleanup', 'rmdirs'].includes(job.job_type);
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
      // Removed manual refreshJobs() - the service should update the signal stream reactively
    } catch (err) {
      console.error('Failed to stop job:', err);
    }
  }

  async deleteJob(job: JobInfo): Promise<void> {
    try {
      await this.jobManagementService.deleteJob(job.jobid);
      // Removed manual refreshJobs() - the service should update the signal stream reactively
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
