import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';
import { JobDetailModalComponent } from './job-detail-modal.component';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { NautilusService } from 'src/app/services/ui/nautilus.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { JobInfo } from '@app/types';

describe('JobDetailModalComponent', () => {
  let fixture: ComponentFixture<JobDetailModalComponent>;
  let component: JobDetailModalComponent;
  let dialogRefSpy: { close: ReturnType<typeof vi.fn> };
  let jobManagementSpy: {
    jobs: ReturnType<typeof signal<JobInfo[]>>;
    deleteJob: ReturnType<typeof vi.fn>;
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
    expect(component.progress()).toBe(100);
  });

  it('should close the dialog when close() is invoked', () => {
    component.close();
    expect(dialogRefSpy.close).toHaveBeenCalled();
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
});
