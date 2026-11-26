import * as pathUtils from 'src/app/shared/utils/path.utils';
import {
  ChangeDetectionStrategy,
  Component,
  TemplateRef,
  computed,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { timer } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatBottomSheet, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { CdkMenuModule, CdkMenuTrigger } from '@angular/cdk/menu';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import {
  PendingWebUpload,
  RemoteFileOperationsService,
} from 'src/app/services/remote/remote-file-operations.service';
import { NautilusFileOperationsService } from 'src/app/services/ui/nautilus-file-operations.service';
import { NautilusTabService } from 'src/app/services/ui/nautilus-tab.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import {
  DELETE_OPERATIONS,
  JOB_ICON_MAP,
  JOB_STATUS,
  JobInfo,
  OPERATION_TONE,
  PillTone,
  canRetryJob,
} from '@app/types';
import { FormatEtaPipe, FormatFileSizePipe, FormatRateValuePipe } from '@app/pipes';
import { relativeTimeLabel } from 'src/app/shared/utils/relative-time.util';
import { PillDirective } from 'src/app/shared/directives/pill.directive';

/** Jobs whose destination is a file: the folder to open is the one that holds it. */
const FILE_DESTINATION = new Set(['rename', 'copyurl', 'archivecreate', 'download']);
/** Jobs that work on their sources alone and have no destination to name or open. */
const NO_DESTINATION = new Set([...DELETE_OPERATIONS, 'index']);

/** What a row shows; derived once per change so the template reads plain fields. */
interface OperationRow {
  job: JobInfo;
  icon: string;
  tone: PillTone;
  typeLabel: string;
  /** The file, or how many items, the job works on. */
  what: string;
  /** All of its sources, for the tooltip. */
  sourceText: string;
  /** Where they go: a folder, or the new name of a renamed file. */
  where: string;
  /** The folder "Open destination" shows; empty when there is none. */
  openPath: string;
  running: boolean;
  /** Running without a known size: a delete or a listing. */
  indeterminate: boolean;
  progress: number;
  statusLabel: string;
  /** How many files of a finished job failed, out of how many. */
  failed: { count: number; total: number } | null;
  relativeTime: string;
  canUndo: boolean;
  canRetry: boolean;
}

/** The folder that holds `fs`, a remote path (`drive:a/b`) or a local one. */
function parentOf(fs: string): string {
  const slash = fs.lastIndexOf('/');
  if (slash > 0) return fs.slice(0, slash);
  if (slash === 0) return '/';
  const colon = fs.indexOf(':');
  return colon >= 0 ? fs.slice(0, colon + 1) : '';
}

/** A path's last name: `Archive` for `drive:Archive`, and the root itself for `drive:` or `/`. */
function nameOf(fs: string): string {
  const name = pathUtils.getFilename(fs) || fs;
  if (fs.includes('/')) return name;
  const colon = name.indexOf(':');
  return colon >= 0 && colon < name.length - 1 ? name.slice(colon + 1) : name;
}

/**
 * The files a finished job handled without an error. rclone counts only those in `transfers`
 * (`totalTransfers` too, once nothing is queued), and a delete in `deletes`.
 */
function doneFileCount(job: JobInfo): number {
  return (DELETE_OPERATIONS.has(job.job_type) ? job.stats?.deletes : job.stats?.transfers) ?? 0;
}

/**
 * The file browser's operations: a button in its toolbar that shows how far the running jobs are,
 * and opens their list (a popover, or a bottom sheet on a narrow screen).
 */
@Component({
  selector: 'app-operations-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    MatIconModule,
    MatProgressBarModule,
    CdkMenuModule,
    FormatFileSizePipe,
    FormatEtaPipe,
    FormatRateValuePipe,
    TranslatePipe,
    PillDirective,
  ],
  templateUrl: './operations-panel.component.html',
  styleUrls: ['./operations-panel.component.scss'],
})
export class OperationsPanelComponent {
  readonly isMobile = input(false);
  /** Asks the file browser to show a folder, given as a full path (`drive:a/b` or `/home/a`). */
  readonly openLocation = output<string>();

  private readonly jobManagementService = inject(JobManagementService);
  protected readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly fileOps = inject(NautilusFileOperationsService);
  private readonly tabSvc = inject(NautilusTabService);
  private readonly modalService = inject(ModalService);
  private readonly bottomSheet = inject(MatBottomSheet);
  private readonly translate = inject(TranslateService);

  private readonly listTemplate = viewChild.required<TemplateRef<unknown>>('list');
  private readonly menuTrigger = viewChild(CdkMenuTrigger);
  private sheetRef: MatBottomSheetRef | null = null;
  /** The paused upload the file picker that is open selects files for. */
  private resuming: PendingWebUpload | null = null;

  private readonly currentLang = toSignal(this.translate.onLangChange, { initialValue: null });
  /** Moves "2 min ago" along while the list is open. */
  private readonly minuteTick = toSignal(timer(0, 60_000), { initialValue: 0 });

  readonly jobs = this.jobManagementService.nautilusJobs;

  /** Uploads the browser is still sending, before the server has a job for them. */
  readonly preparingUploads = computed(() => {
    const jobGroups = new Set(this.jobs().map(job => job.group));
    return this.remoteOps
      .pendingWebUploads()
      .filter(upload => upload.origin === 'filemanager' && !jobGroups.has(upload.group));
  });

  readonly activeCount = computed(
    () =>
      this.jobs().filter(job => job.status === JOB_STATUS.Running).length +
      this.preparingUploads().length
  );
  readonly hasJobs = computed(() => this.jobs().length > 0 || this.preparingUploads().length > 0);
  readonly hasFinished = computed(() => this.jobs().some(job => job.status !== JOB_STATUS.Running));

  /**
   * How far the running work is, 0–100, for the ring on the button; null while nothing runs,
   * and -1 while it runs without a known size.
   */
  readonly overallProgress = computed<number | null>(() => {
    let bytes = 0;
    let total = 0;
    let running = false;
    for (const job of this.jobs()) {
      if (job.status !== JOB_STATUS.Running) continue;
      running = true;
      bytes += job.stats?.bytes ?? 0;
      total += job.stats?.totalBytes ?? 0;
    }
    for (const upload of this.preparingUploads()) {
      running = true;
      bytes += upload.sent;
      total += upload.total;
    }
    if (!running) return null;
    return total > 0 ? Math.min(100, (bytes / total) * 100) : -1;
  });

  readonly rows = computed<OperationRow[]>(() => {
    this.currentLang();
    this.minuteTick();
    const undoJobId = this.fileOps.lastUndoJobId();
    const now = Date.now();
    return this.jobs().map(job => this.toRow(job, undoJobId, now));
  });

  constructor() {
    // Nothing left to show: the button goes away, and so does its list.
    effect(() => {
      if (!this.hasJobs()) this.closeList();
    });
  }

  private toRow(job: JobInfo, undoJobId: number | undefined, now: number): OperationRow {
    const sources = [job.source].flat().filter(Boolean);
    const running = job.status === JOB_STATUS.Running;
    const bytes = job.stats?.bytes ?? 0;
    const totalBytes = job.stats?.totalBytes ?? 0;
    // A download saved through Android's picker names a content URI: no name, no folder.
    const hasDestination =
      !NO_DESTINATION.has(job.job_type) && !!job.destination && !job.destination.includes('://');
    const fileDestination = FILE_DESTINATION.has(job.job_type);
    const failedFiles = job.failed_files ?? 0;
    const relative = running ? null : relativeTimeLabel(job.end_time ?? job.start_time, now);

    let openPath = '';
    if (hasDestination) {
      // A rename stores only the new name; its folder is the one of the renamed file.
      if (job.job_type === 'rename') openPath = parentOf(sources[0] ?? '');
      else openPath = fileDestination ? parentOf(job.destination) : job.destination;
    }

    return {
      job,
      icon: JOB_ICON_MAP[job.job_type] ?? 'file',
      tone: OPERATION_TONE[job.job_type] ?? 'accent',
      typeLabel: this.typeLabel(job.job_type),
      what:
        sources.length > 1
          ? this.translate.instant('fileBrowser.operations.itemsCount', { count: sources.length })
          : nameOf(sources[0] ?? job.destination ?? ''),
      sourceText: sources.join(', '),
      where: hasDestination ? nameOf(job.destination) : '',
      openPath,
      running,
      indeterminate: running && totalBytes === 0,
      progress: totalBytes > 0 ? Math.min(100, (bytes / totalBytes) * 100) : 0,
      statusLabel: this.statusLabel(job.status),
      failed:
        !running && failedFiles > 0
          ? { count: failedFiles, total: doneFileCount(job) + failedFiles }
          : null,
      relativeTime: relative ? this.translate.instant(relative.key, relative.params) : '',
      canUndo:
        job.status === JOB_STATUS.Completed &&
        (job.job_type === 'copy' || job.job_type === 'move') &&
        job.jobid === undoJobId,
      canRetry: canRetryJob(job),
    };
  }

  private typeLabel(type: string): string {
    const key = `fileBrowser.operations.types.${type}`;
    const translated = this.translate.instant(key);
    return translated === key ? type.replace(/_/g, ' ') : translated;
  }

  private statusLabel(status: string): string {
    switch (status) {
      case JOB_STATUS.Running:
        return this.translate.instant('fileBrowser.operations.running');
      case JOB_STATUS.Completed:
        return this.translate.instant('fileBrowser.operations.completed');
      case JOB_STATUS.Failed:
        return this.translate.instant('fileBrowser.operations.failed');
      case JOB_STATUS.Stopped:
        return this.translate.instant('fileBrowser.operations.cancelled');
      default:
        return status;
    }
  }

  /** A narrow screen gets a bottom sheet; a wide one the popover of the button's menu trigger. */
  protected onIndicatorClick(): void {
    if (!this.isMobile()) return;
    this.sheetRef = this.bottomSheet.open(this.listTemplate(), {
      panelClass: 'operations-sheet',
    });
    this.sheetRef.afterDismissed().subscribe(() => (this.sheetRef = null));
  }

  private closeList(): void {
    this.menuTrigger()?.close();
    this.sheetRef?.dismiss();
  }

  protected showDetails(job: JobInfo): void {
    this.closeList();
    this.modalService.openJobDetail(job);
  }

  protected openDestination(row: OperationRow): void {
    this.closeList();
    this.openLocation.emit(row.openPath);
  }

  protected async undo(): Promise<void> {
    await this.fileOps.undoLastOperation();
  }

  protected async retryJob(job: JobInfo): Promise<void> {
    try {
      await this.jobManagementService.retryJob(job.jobid);
    } catch (err) {
      console.error('Failed to retry job:', err);
    }
  }

  protected async stopJob(job: JobInfo): Promise<void> {
    try {
      await this.jobManagementService.stopJob(job.jobid);
    } catch (err) {
      console.error('Failed to stop job:', err);
    }
  }

  protected async removeJob(job: JobInfo): Promise<void> {
    try {
      await this.jobManagementService.deleteJob(job.jobid);
    } catch (err) {
      console.error('Failed to delete job:', err);
    }
  }

  protected async clearFinished(): Promise<void> {
    const finished = this.jobs().filter(job => job.status !== JOB_STATUS.Running);
    try {
      await this.jobManagementService.clearJobs(finished.map(job => job.jobid));
    } catch (err) {
      console.error('Failed to clear finished jobs:', err);
    }
  }

  /** Continues a paused upload, with the files selected again when the page no longer has them. */
  protected async resumeUpload(
    upload: PendingWebUpload,
    picked?: { file: File; relativePath: string }[]
  ): Promise<void> {
    if (await this.fileOps.resumeWebUpload(upload.group, picked)) {
      this.tabSvc.refreshPath(upload.remote, upload.path);
    }
  }

  protected pickResumeFiles(upload: PendingWebUpload, picker: HTMLInputElement): void {
    this.resuming = upload;
    picker.click();
  }

  protected async onResumeFiles(picker: HTMLInputElement): Promise<void> {
    const upload = this.resuming;
    const files = Array.from(picker.files ?? []);
    picker.value = '';
    this.resuming = null;
    if (!upload || !files.length) return;
    await this.resumeUpload(
      upload,
      files.map(file => ({ file, relativePath: file.webkitRelativePath || file.name }))
    );
  }

  /** The folder name of a pending upload's destination. */
  protected uploadWhere(upload: PendingWebUpload): string {
    return nameOf(upload.path) || upload.remote;
  }
}
