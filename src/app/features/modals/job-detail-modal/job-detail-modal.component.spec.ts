import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';
import { Clipboard } from '@angular/cdk/clipboard';
import { JobDetailModalComponent } from './job-detail-modal.component';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { NautilusService } from 'src/app/services/ui/nautilus.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { JobInfo } from '@app/types';

describe('JobDetailModalComponent', () => {
  let fixture: ComponentFixture<JobDetailModalComponent>;
  let component: JobDetailModalComponent;
  let dialogRefSpy: { close: ReturnType<typeof vi.fn> };
  let jobManagementSpy: {
    jobs: ReturnType<typeof signal<JobInfo[]>>;
    deleteJob: ReturnType<typeof vi.fn>;
    resetGroupStats: ReturnType<typeof vi.fn>;
    getJob: ReturnType<typeof vi.fn>;
    getJobReport: ReturnType<typeof vi.fn>;
  };
  let fileSystemSpy: {
    openInFiles: ReturnType<typeof vi.fn>;
  };
  let nautilusSpy: {
    newNautilusWindow: ReturnType<typeof vi.fn>;
  };

  const mockJob: JobInfo = {
    jobid: 42,
    execute_id: 'exec-123',
    job_type: 'sync',
    source: ['/home/user/docs'],
    destination: 'remote:backup',
    start_time: '2026-09-04T10:00:00.000Z',
    end_time: '2026-09-04T10:05:00.000Z',
    status: 'Completed',
    remote_name: 'remote',
    group: 'job-group-1',
    backend_name: 'Drive',
    dry_run: false,
    stats: {
      bytes: 1048576,
      totalBytes: 1048576,
      speed: 10240,
      eta: 0,
      totalTransfers: 5,
      transfers: 5,
      errors: 0,
      checks: 10,
      totalChecks: 10,
      deletedDirs: 0,
      deletes: 0,
      renames: 0,
      serverSideCopies: 2,
      serverSideMoves: 1,
      elapsedTime: 300,
      lastError: '',
      fatalError: false,
      retryError: false,
      serverSideCopyBytes: 2048,
      serverSideMoveBytes: 1024,
      transferTime: 300,
      transferring: [],
      completed: [],
      listed: 12,
    },
  };

  beforeEach(async () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    dialogRefSpy = { close: vi.fn() };
    jobManagementSpy = {
      jobs: signal([mockJob]),
      deleteJob: vi.fn().mockResolvedValue(undefined),
      resetGroupStats: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockReturnValue(mockJob),
      getJobReport: vi.fn().mockResolvedValue(null),
    };
    fileSystemSpy = {
      openInFiles: vi.fn().mockResolvedValue(undefined),
    };
    nautilusSpy = {
      newNautilusWindow: vi.fn().mockResolvedValue(undefined),
    };

    await TestBed.configureTestingModule({
      imports: [JobDetailModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRefSpy },
        { provide: MAT_DIALOG_DATA, useValue: { jobid: 42 } },
        { provide: JobManagementService, useValue: jobManagementSpy },
        { provide: FileSystemService, useValue: fileSystemSpy },
        { provide: NautilusService, useValue: nautilusSpy },
        { provide: BackendService, useValue: { isWindows: vi.fn().mockReturnValue(false) } },
        PathService,
        { provide: IconService, useValue: {} },
      ],
    }).compileComponents();

    const pathService = TestBed.inject(PathService);
    pathService.setRemoteNames(['remote']);

    fixture = TestBed.createComponent(JobDetailModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should initialize and compute job data correctly', () => {
    expect(component).toBeTruthy();
    expect(component.jobData().jobid).toBe(42);
    expect(component.jobStatus()).toBe('completed');
    expect(component.isMount()).toBe(false);
  });

  it('shows updated directories and treats jobs stored without the counter as zero', () => {
    expect(component.fileCounters()?.updatedDirs).toBe(0);
    jobManagementSpy.getJob.mockReturnValue({
      ...mockJob,
      stats: { ...mockJob.stats, updatedDirs: 7 },
    });
    fixture.destroy();
    fixture = TestBed.createComponent(JobDetailModalComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance.fileCounters()?.updatedDirs).toBe(7);
    expect(fixture.nativeElement.textContent).toContain('modals.jobDetail.fields.updatedDirs');
  });

  it('should close the dialog when close() is invoked', () => {
    component.close();
    expect(dialogRefSpy.close).toHaveBeenCalled();
  });

  it('preserves multiline error text and copying through the alert banner', () => {
    expect(fixture.nativeElement.querySelector('app-alert-banner')).toBeNull();
    const error = 'Permission denied: <remote>\nCannot open /path with spaces/file.txt';
    jobManagementSpy.getJob.mockReturnValue({ ...mockJob, error });
    fixture.destroy();
    fixture = TestBed.createComponent(JobDetailModalComponent);
    fixture.detectChanges();
    const banner = fixture.nativeElement.querySelector('app-alert-banner') as HTMLElement;
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.classList.contains('error')).toBe(true);
    expect(banner.querySelector('p')?.textContent).toBe(error);
    expect(banner.querySelector('remote')).toBeNull();

    const copy = vi.spyOn(TestBed.inject(Clipboard), 'copy').mockReturnValue(true);
    vi.spyOn(TestBed.inject(NotificationService), 'showSuccess').mockImplementation(
      () => undefined
    );
    banner.querySelector('p')?.click();
    expect(copy).toHaveBeenCalledWith(error);
  });

  it('resets only the displayed job group', async () => {
    await component.onResetStats();
    expect(jobManagementSpy.resetGroupStats).toHaveBeenCalledWith(mockJob.group);
  });

  it('should delete job and close dialog on onDeleteJob', async () => {
    await component.onDeleteJob();
    expect(jobManagementSpy.deleteJob).toHaveBeenCalledWith(42);
    expect(dialogRefSpy.close).toHaveBeenCalled();
  });

  it('should open path locally when local path is passed', async () => {
    await component.onOpenPath('/local/test');
    expect(fileSystemSpy.openInFiles).toHaveBeenCalledWith('/local/test');
  });

  it('should open nautilus window when remote path is passed', async () => {
    await component.onOpenPath('remote:backup');
    expect(nautilusSpy.newNautilusWindow).toHaveBeenCalledWith('remote', 'backup');
  });

  it('should query jobService.getJob with execute_id and jobid', () => {
    expect(jobManagementSpy.getJob).toHaveBeenCalledWith('', 42, undefined);
  });

  describe('what started the job', () => {
    const run = { workflowId: 'wf', workflowName: 'Nightly backup', nodeId: 'n1', ancestors: [] };
    const identifiersFor = (job: Partial<JobInfo>): ReturnType<typeof component.identifiers> => {
      jobManagementSpy.getJob.mockReturnValue({ ...mockJob, ...job });
      fixture.destroy();
      fixture = TestBed.createComponent(JobDetailModalComponent);
      fixture.detectChanges();
      return fixture.componentInstance.identifiers();
    };

    it('names the profile of a profile job', () => {
      const identifiers = identifiersFor({ starter: { kind: 'profile', name: 'Daily' } });
      expect(identifiers.starter).toEqual({
        label: 'modals.jobDetail.fields.profile',
        name: 'Daily',
      });
      expect(identifiers.viaWorkflow).toBeNull();
    });

    it('names the Quick Run of a Quick Run job instead of the default profile', () => {
      const identifiers = identifiersFor({
        starter: { kind: 'quick_run', id: 'qr-1', name: 'Nightly' },
      });
      expect(identifiers.starter).toEqual({
        label: 'modals.jobDetail.fields.quickRun',
        name: 'Nightly',
      });
      expect(identifiers.origin).toBe('quickrun');
      expect(identifiers.viaWorkflow).toBeNull();
    });

    it('names the workflow of a workflow node, which has no profile or Quick Run', () => {
      const identifiers = identifiersFor({ starter: { kind: 'workflow', ...run } });
      expect(identifiers.starter).toEqual({
        label: 'modals.jobDetail.fields.workflow',
        name: 'Nightly backup',
      });
      expect(identifiers.origin).toBe('workflow');
      expect(identifiers.viaWorkflow).toBeNull();
    });

    it('names both the Quick Run and the workflow node that ran it', () => {
      const identifiers = identifiersFor({
        starter: { kind: 'quick_run', id: 'qr-1', name: 'Nightly', workflow: run },
      });
      expect(identifiers.starter?.name).toBe('Nightly');
      expect(identifiers.viaWorkflow).toBe('Nightly backup');
      expect(identifiers.origin).toBe('workflow');
    });

    it('names nothing for work nothing started, keeping its stored origin', () => {
      const identifiers = identifiersFor({ origin: 'filemanager' });
      expect(identifiers.starter).toBeNull();
      expect(identifiers.viaWorkflow).toBeNull();
      expect(identifiers.origin).toBe('filemanager');
    });

    it('shows the rows that name what started the job', () => {
      identifiersFor({
        starter: { kind: 'quick_run', id: 'qr-1', name: 'Nightly', workflow: run },
      });
      const text: string = fixture.nativeElement.textContent;
      expect(text).toContain('modals.jobDetail.fields.quickRun');
      expect(text).toContain('Nightly');
      expect(text).toContain('modals.jobDetail.fields.workflow');
      expect(text).toContain('Nightly backup');
      expect(text).toContain('modals.jobDetail.sections.execution');
    });
  });

  it('hands the activity panel the reports of a job that kept some', () => {
    expect(component.transferActivityConfig().report).toBeUndefined();
    jobManagementSpy.getJob.mockReturnValue({ ...mockJob, report_counts: { combined: 3 } });
    fixture.destroy();
    fixture = TestBed.createComponent(JobDetailModalComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance.transferActivityConfig().report).toEqual({
      jobId: 42,
      counts: { combined: 3 },
      path1: mockJob.source[0],
      path2: mockJob.destination,
      dryRun: mockJob.dry_run,
    });
  });
});
