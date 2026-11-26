import { TestBed, ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { MatBottomSheet } from '@angular/material/bottom-sheet';
import { OperationsPanelComponent } from './operations-panel.component';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import {
  PendingWebUpload,
  RemoteFileOperationsService,
} from 'src/app/services/remote/remote-file-operations.service';
import { NautilusFileOperationsService } from 'src/app/services/ui/nautilus-file-operations.service';
import { NautilusTabService } from 'src/app/services/ui/nautilus-tab.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { DEFAULT_JOB_STATS, GlobalStats, JobInfo } from '@app/types';

describe('OperationsPanelComponent', () => {
  let fixture: ComponentFixture<OperationsPanelComponent>;
  let component: OperationsPanelComponent;
  const jobs = signal<JobInfo[]>([]);
  const pendingUploads = signal<PendingWebUpload[]>([]);
  const lastUndoJobId = signal<number | undefined>(undefined);
  const cancelWebUpload = vi.fn();
  const resumeWebUpload = vi.fn();
  const undoLastOperation = vi.fn();
  const refreshPath = vi.fn();
  const openJobDetail = vi.fn();
  const stopJob = vi.fn();
  const deleteJob = vi.fn();
  const clearJobs = vi.fn();
  const retryJob = vi.fn();
  const openSheet = vi.fn();

  const job = (jobid: number, extra: Partial<JobInfo> = {}): JobInfo => ({
    jobid,
    execute_id: `exec-${jobid}`,
    job_type: 'copy',
    status: 'Completed',
    origin: 'filemanager',
    remote_name: 'drive:',
    source: ['/home/me/report.pdf'],
    destination: 'drive:Archive',
    start_time: '2026-09-05T10:00:00Z',
    end_time: '2026-09-05T10:00:03Z',
    stats: { ...DEFAULT_JOB_STATS },
    ...extra,
  });
  const running = (
    jobid: number,
    stats: Partial<GlobalStats>,
    extra: Partial<JobInfo> = {}
  ): JobInfo =>
    job(jobid, {
      status: 'Running',
      end_time: undefined,
      stats: { ...DEFAULT_JOB_STATS, ...stats },
      ...extra,
    });
  const upload = (extra: Partial<PendingWebUpload> = {}): PendingWebUpload => ({
    group: 'upload-1',
    remote: 'drive:',
    path: 'dest',
    origin: 'filemanager',
    sent: 0,
    total: 0,
    files: 2,
    ...extra,
  });

  /** Opens the list in its popover and returns it. */
  function openList(): HTMLElement {
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.ops-indicator') as HTMLButtonElement).click();
    fixture.detectChanges();
    return document.querySelector('.ops-list') as HTMLElement;
  }

  beforeEach(() => {
    jobs.set([]);
    pendingUploads.set([]);
    lastUndoJobId.set(undefined);
    for (const mock of [
      cancelWebUpload,
      resumeWebUpload,
      undoLastOperation,
      refreshPath,
      openJobDetail,
      stopJob,
      deleteJob,
      clearJobs,
      retryJob,
      openSheet,
    ]) {
      mock.mockReset();
    }
    stopJob.mockResolvedValue(undefined);
    deleteJob.mockResolvedValue(undefined);
    clearJobs.mockResolvedValue(undefined);
    openSheet.mockReturnValue({ afterDismissed: () => ({ subscribe: vi.fn() }), dismiss: vi.fn() });

    TestBed.configureTestingModule({
      imports: [OperationsPanelComponent],
      providers: [
        provideTranslateService(),
        {
          provide: JobManagementService,
          useValue: { nautilusJobs: jobs, stopJob, deleteJob, clearJobs, retryJob },
        },
        {
          provide: RemoteFileOperationsService,
          useValue: { pendingWebUploads: pendingUploads, cancelWebUpload },
        },
        {
          provide: NautilusFileOperationsService,
          useValue: { resumeWebUpload, undoLastOperation, lastUndoJobId },
        },
        { provide: NautilusTabService, useValue: { refreshPath } },
        { provide: ModalService, useValue: { openJobDetail } },
        { provide: MatBottomSheet, useValue: { open: openSheet } },
      ],
    });

    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', {
      shared: { transferActivity: { status: { preparing: 'Preparing' } } },
      detailShared: { jobs: { actions: { retry: 'Retry Job' } } },
      fileBrowser: {
        operations: {
          title: 'Operations',
          running: 'Running',
          completed: 'Completed',
          failed: 'Failed',
          cancelled: 'Cancelled',
          cancelJob: 'Cancel',
          removeJob: 'Remove',
          undo: 'Undo',
          openDestination: 'Open destination',
          clearFinished: 'Clear finished',
          timeLeft: '{{time}} left',
          failedOf: '{{count}} of {{total}} failed',
          itemsCount: '{{count}} items',
          filesCount: '{{count}} files',
          resumeUpload: 'Continue upload',
          resumeWithFiles: 'Select the same files',
          resumeWithFolder: 'Select the same folder',
          uploadPausedConnection: 'Paused: connection lost',
          uploadPausedReselect: 'Paused: select {{count}} files again',
          types: {
            copy: 'Copy',
            delete: 'Delete',
            move: 'Move',
            rename: 'Rename',
            upload: 'Upload',
          },
        },
      },
    });
    translate.use('en');

    fixture = TestBed.createComponent(OperationsPanelComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    document.querySelectorAll('.cdk-overlay-container').forEach(container => container.remove());
  });

  it('shows no button while there is nothing to show', () => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.ops-indicator')).toBeNull();

    jobs.set([job(1)]);
    fixture.detectChanges();
    const indicator = fixture.nativeElement.querySelector('.ops-indicator') as HTMLElement;
    expect(indicator).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.ops-count')).toBeNull();
    // The icon keeps its full size while no ring surrounds it.
    expect(indicator.classList.contains('busy')).toBe(false);
    expect(indicator.querySelector('.ops-ring')).toBeNull();
  });

  it('counts the running work and rings how far it is', () => {
    jobs.set([running(1, { bytes: 100, totalBytes: 400 }), job(2)]);
    pendingUploads.set([upload({ group: 'upload-2', sent: 100, total: 100 })]);
    fixture.detectChanges();

    expect(component.activeCount()).toBe(2);
    expect(fixture.nativeElement.querySelector('.ops-count')?.textContent?.trim()).toBe('2');
    expect(fixture.nativeElement.querySelector('.ops-indicator.busy .ops-ring')).not.toBeNull();
    expect(component.overallProgress()).toBe(40);

    jobs.set([running(1, {}, { job_type: 'delete' })]);
    pendingUploads.set([]);
    expect(component.overallProgress()).toBe(-1);

    jobs.set([job(2)]);
    expect(component.overallProgress()).toBeNull();
  });

  it('says what a job works on and where it goes', () => {
    jobs.set([
      job(1, { source: ['/home/me/a.txt', '/home/me/b.txt', '/home/me/c'] }),
      job(2, { job_type: 'delete', source: ['drive:Old/x'], destination: 'trash' }),
      job(3, { job_type: 'rename', source: ['drive:Docs/old.txt'], destination: 'Docs/new.txt' }),
      job(4, {
        job_type: 'archivecreate',
        source: ['drive:Docs'],
        destination: 'drive:Out/docs.zip',
      }),
      job(5, { destination: 'drive:' }),
      job(6, {
        job_type: 'download',
        source: ['drive:Docs/a.pdf'],
        destination: '/home/me/Downloads/a.pdf',
      }),
      // Saved through Android's picker: a content URI, which names no file or folder.
      job(7, {
        job_type: 'download',
        source: ['drive:Docs/a.pdf'],
        destination: 'content://com.android.providers.downloads.documents/document/42',
      }),
      // Opened in another app: nothing is kept.
      job(8, { job_type: 'download', source: ['drive:Docs/a.pdf'], destination: '' }),
    ]);
    const rows = component.rows();
    expect(rows.map(row => [row.what, row.where, row.openPath])).toEqual([
      ['3 items', 'Archive', 'drive:Archive'],
      ['x', '', ''],
      ['old.txt', 'new.txt', 'drive:Docs'],
      ['Docs', 'docs.zip', 'drive:Out'],
      ['report.pdf', 'drive:', 'drive:'],
      ['a.pdf', 'a.pdf', '/home/me/Downloads'],
      ['a.pdf', '', ''],
      ['a.pdf', '', ''],
    ]);
    expect(rows[5].icon).toBe('download');
  });

  it('describes a running job by its size, speed and time left, and a finished one by its result', () => {
    jobs.set([
      running(1, { bytes: 512, totalBytes: 1024, speed: 256, eta: 2 }),
      // As the list carries a finished job: its failed files counted, `transfers` only the files
      // that arrived (rclone does not count a failed file in `totalTransfers`).
      job(2, {
        status: 'Failed',
        failed_files: 1,
        stats: { ...DEFAULT_JOB_STATS, transfers: 2, totalTransfers: 2 },
      }),
      job(3, {
        job_type: 'delete',
        status: 'Failed',
        failed_files: 1,
        stats: { ...DEFAULT_JOB_STATS, deletes: 4 },
      }),
      job(4, { status: 'Completed', stats: { ...DEFAULT_JOB_STATS, transfers: 3 } }),
    ]);
    const statuses = [...openList().querySelectorAll('.ops-status')].map(status =>
      status.textContent?.replace(/\s+/g, ' ').trim()
    );
    expect(statuses[0]).toBe('Copy · 512 B / 1.00 KB · 256 B/s · 2s left');
    expect(statuses[1]).toMatch(/^Copy · Failed · 1 of 3 failed · /);
    expect(component.rows().map(row => row.failed)).toEqual([
      null,
      { count: 1, total: 3 },
      { count: 1, total: 5 },
      null,
    ]);
  });

  it('offers undo only on the finished copy or move the undo stack would reverse', () => {
    jobs.set([job(1), job(2, { job_type: 'move' }), running(3, {})]);
    lastUndoJobId.set(2);
    expect(component.rows().map(row => row.canUndo)).toEqual([false, true, false]);

    const list = openList();
    (list.querySelector('[title="Undo"]') as HTMLButtonElement).click();
    expect(undoLastOperation).toHaveBeenCalledOnce();
    expect(openJobDetail).not.toHaveBeenCalled();
  });

  it('offers a retry on a failed or stopped job the backend can still run again', () => {
    jobs.set([
      job(1, { status: 'Failed', retryable: true }),
      job(2, { status: 'Stopped', retryable: true }),
      job(3, { status: 'Failed' }),
      job(4, { retryable: true }),
    ]);
    expect(component.rows().map(row => row.canRetry)).toEqual([true, true, false, false]);

    retryJob.mockResolvedValue(9);
    (openList().querySelector('[title="Retry Job"]') as HTMLButtonElement).click();
    expect(retryJob).toHaveBeenCalledExactlyOnceWith(1);
    expect(openJobDetail).not.toHaveBeenCalled();
  });

  it('opens the details of a job, and its destination, from its row', () => {
    jobs.set([job(1)]);
    const opened: string[] = [];
    component.openLocation.subscribe(path => opened.push(path));
    const list = openList();

    (list.querySelector('[title="Open destination"]') as HTMLButtonElement).click();
    expect(opened).toEqual(['drive:Archive']);
    expect(openJobDetail).not.toHaveBeenCalled();

    const row = openList().querySelector('.ops-row[role="button"]') as HTMLElement;
    row.click();
    expect(openJobDetail).toHaveBeenCalledExactlyOnceWith(jobs()[0]);
  });

  it('stops a running job and removes or clears finished ones', async () => {
    jobs.set([running(1, {}), job(2), job(3, { status: 'Failed' })]);
    const list = openList();

    (list.querySelector('[title="Cancel"]') as HTMLButtonElement).click();
    expect(stopJob).toHaveBeenCalledExactlyOnceWith(1);

    (list.querySelector('[title="Remove"]') as HTMLButtonElement).click();
    expect(deleteJob).toHaveBeenCalledExactlyOnceWith(2);

    (list.querySelector('.ops-clear') as HTMLButtonElement).click();
    expect(clearJobs).toHaveBeenCalledExactlyOnceWith([2, 3]);
    expect(openJobDetail).not.toHaveBeenCalled();
  });

  it('opens the list in a bottom sheet on a narrow screen', () => {
    jobs.set([job(1)]);
    fixture.componentRef.setInput('isMobile', true);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.ops-indicator') as HTMLButtonElement).click();
    expect(openSheet).toHaveBeenCalledOnce();
    expect(openSheet.mock.calls[0][1]).toEqual({ panelClass: 'operations-sheet' });
    expect(document.querySelector('.ops-list')).toBeNull();
  });

  describe('uploads the browser is still sending', () => {
    it('shows them before the server has a job, with their progress', () => {
      pendingUploads.set([upload({ path: 'özel folder' })]);
      let status = openList().querySelector('[role="status"]') as HTMLElement;
      expect(component.activeCount()).toBe(1);
      expect(status.textContent).toContain('Preparing');
      expect(status.textContent).toContain('özel folder');
      expect(status.querySelector('mat-progress-bar')?.getAttribute('mode')).toBe('indeterminate');

      pendingUploads.update(([pending]) => [{ ...pending, sent: 25, total: 100 }]);
      fixture.detectChanges();
      status = document.querySelector('.ops-list [role="status"]') as HTMLElement;
      expect(status.textContent).toContain('25 B / 100 B');
      expect(status.querySelector('mat-progress-bar')?.getAttribute('mode')).toBe('determinate');
      (status.querySelector('[title="Cancel"]') as HTMLButtonElement).click();
      expect(cancelWebUpload).toHaveBeenCalledExactlyOnceWith('upload-1');
    });

    it('continues a paused upload whose files the page holds and refreshes its folder', async () => {
      resumeWebUpload.mockResolvedValue(true);
      pendingUploads.set([upload({ sent: 40, total: 100, paused: { missing: 0 } })]);
      const status = openList().querySelector('[role="status"]') as HTMLElement;
      expect(status.getAttribute('aria-busy')).toBe('false');
      expect(status.textContent).toContain('Paused: connection lost');
      (status.querySelector('[title="Continue upload"]') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(refreshPath).toHaveBeenCalledWith('drive:', 'dest'));
      expect(resumeWebUpload).toHaveBeenCalledExactlyOnceWith('upload-1', undefined);
    });

    it('asks a reloaded page for the files of a paused upload again', async () => {
      resumeWebUpload.mockResolvedValue(false);
      pendingUploads.set([upload({ sent: 40, total: 100, files: 3, paused: { missing: 3 } })]);
      const status = openList().querySelector('[role="status"]') as HTMLElement;
      expect(status.textContent).toContain('Paused: select 3 files again');
      expect(status.querySelector('[title="Continue upload"]')).toBeNull();

      const input = fixture.nativeElement.querySelector(
        'input[webkitdirectory]'
      ) as HTMLInputElement;
      const click = vi.spyOn(input, 'click').mockImplementation(() => undefined);
      (status.querySelector('[title="Select the same folder"]') as HTMLButtonElement).click();
      expect(click).toHaveBeenCalledOnce();
      const file = new File(['x'], 'a.txt');
      Object.defineProperty(file, 'webkitRelativePath', { value: 'folder/a.txt' });
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change'));
      await vi.waitFor(() =>
        expect(resumeWebUpload).toHaveBeenCalledExactlyOnceWith('upload-1', [
          { file, relativePath: 'folder/a.txt' },
        ])
      );
      expect(refreshPath).not.toHaveBeenCalled();
    });

    it('gives way to the backend job of the same upload, and to no other origin', () => {
      pendingUploads.set([
        upload(),
        upload({ group: 'upload-2' }),
        upload({ group: 'other-origin', origin: undefined }),
      ]);
      jobs.set([running(1, {}, { job_type: 'upload', group: 'upload-1' })]);
      expect(component.preparingUploads().map(pending => pending.group)).toEqual(['upload-2']);
      expect(component.activeCount()).toBe(2);

      jobs.set([job(1, { job_type: 'upload', group: 'upload-2' })]);
      expect(component.preparingUploads().map(pending => pending.group)).toEqual(['upload-1']);
    });
  });
});
