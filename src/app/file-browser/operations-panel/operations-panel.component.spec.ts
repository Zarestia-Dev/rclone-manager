import { TestBed, ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { OperationsPanelComponent } from './operations-panel.component';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { JobInfo, GlobalStats } from '@app/types';

describe('OperationsPanelComponent', () => {
  let fixture: ComponentFixture<OperationsPanelComponent>;
  let component: OperationsPanelComponent;
  let mockJobsSignal: ReturnType<typeof signal<JobInfo[]>>;
  let jobManagementMock: {
    nautilusJobs: ReturnType<typeof signal<JobInfo[]>>;
    refreshJobs: ReturnType<typeof vi.fn>;
    stopJob: ReturnType<typeof vi.fn>;
    deleteJob: ReturnType<typeof vi.fn>;
  };
  let pathServiceMock: {
    getFilename: ReturnType<typeof vi.fn>;
  };

  const sampleRunningJob: JobInfo = {
    jobid: 101,
    execute_id: 'exec-101',
    job_type: 'copy',
    status: 'Running',
    origin: 'filemanager',
    remote_name: 'drive',
    source: '/local/test.txt',
    destination: 'drive:/remote/test.txt',
    start_time: '2026-09-05T10:00:00Z',
    stats: {
      bytes: 500,
      totalBytes: 1000,
      transfers: 1,
      totalTransfers: 1,
      speed: 100,
      eta: 5,
    } as unknown as GlobalStats,
  };

  const sampleCompletedJob: JobInfo = {
    jobid: 102,
    execute_id: 'exec-102',
    job_type: 'delete',
    status: 'Completed',
    origin: 'filemanager',
    remote_name: 'drive',
    source: ['drive:/remote/file1.txt', 'drive:/remote/file2.txt'],
    destination: '',
    start_time: '2026-09-05T09:00:00Z',
    stats: {
      bytes: 1000,
      totalBytes: 1000,
      transfers: 2,
      totalTransfers: 2,
      completed: [
        {
          name: 'file1.txt',
          size: 500,
          status: 'completed',
          bytes: 500,
          checked: false,
          jobid: 102,
        },
        {
          name: 'file2.txt',
          size: 500,
          status: 'failed',
          bytes: 0,
          checked: false,
          jobid: 102,
          error: 'Permission denied',
        },
      ],
    } as unknown as GlobalStats,
  };

  beforeEach(() => {
    mockJobsSignal = signal<JobInfo[]>([sampleRunningJob, sampleCompletedJob]);
    jobManagementMock = {
      nautilusJobs: mockJobsSignal,
      refreshJobs: vi.fn().mockResolvedValue(undefined),
      stopJob: vi.fn().mockResolvedValue(undefined),
      deleteJob: vi.fn().mockResolvedValue(undefined),
    };
    pathServiceMock = {
      getFilename: vi.fn((p: string) => p.split('/').pop() || ''),
    };

    TestBed.configureTestingModule({
      imports: [OperationsPanelComponent],
      providers: [
        provideTranslateService(),
        { provide: JobManagementService, useValue: jobManagementMock },
        { provide: PathService, useValue: pathServiceMock },
      ],
    });

    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', {
      fileBrowser: {
        operations: {
          running: 'Running',
          completed: 'Completed',
          failed: 'Failed',
          cancelled: 'Cancelled',
          filesCount: '{{count}} files',
          types: {
            copy: 'Copy',
            delete: 'Delete',
            move: 'Move',
            sync: 'Sync',
          },
          details: {
            deletedFiles: 'Deleted files',
            copiedFiles: 'Copied files',
          },
        },
      },
    });
    translate.use('en');

    fixture = TestBed.createComponent(OperationsPanelComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create the component', () => {
    expect(component).toBeTruthy();
    expect(jobManagementMock.refreshJobs).toHaveBeenCalled();
  });

  it('should compute activeJobs and hasJobs signals correctly', () => {
    expect(component.hasJobs()).toBe(true);
    expect(component.activeJobs().length).toBe(1);
    expect(component.activeJobs()[0].jobid).toBe(101);

    mockJobsSignal.set([]);
    expect(component.hasJobs()).toBe(false);
    expect(component.activeJobs().length).toBe(0);
  });

  it('should derive JobViewModels accurately', () => {
    const vms = component.jobViewModels();
    expect(vms.length).toBe(2);

    const runningVM = vms[0];
    expect(runningVM.typeIcon).toBe('copy');
    expect(runningVM.typeLabel).toBe('Copy');
    expect(runningVM.statusLabel).toBe('Running');
    expect(runningVM.progress).toBe(50);
    expect(runningVM.isDelete).toBe(false);
    expect(runningVM.actualFileName).toBe('test.txt');

    const completedVM = vms[1];
    expect(completedVM.typeIcon).toBe('trash');
    expect(completedVM.typeLabel).toBe('Delete');
    expect(completedVM.statusLabel).toBe('Completed');
    expect(completedVM.isDelete).toBe(true);
    expect(completedVM.transferredFiles.length).toBe(2);
    expect(completedVM.transferredLabel).toBe('fileBrowser.operations.details.deletedFiles');
    expect(completedVM.actualFileName).toBe('2 files');
  });

  it('should handle multi-source formatted string correctly', () => {
    expect(component.getFormattedSource(['src1', 'src2'])).toBe('src1, src2');
    expect(component.getFormattedSource('single-src')).toBe('single-src');
    expect(component.getFormattedSource('')).toBe('');
  });

  it('should calculate progress percentages and handle missing stats', () => {
    expect(component.getProgress(sampleRunningJob)).toBe(50);
    expect(
      component.getProgress({ ...sampleRunningJob, stats: undefined as unknown as GlobalStats })
    ).toBe(0);
    expect(
      component.getProgress({
        ...sampleRunningJob,
        stats: {
          bytes: 0,
          totalBytes: 0,
          transfers: 0,
          totalTransfers: 0,
        } as unknown as GlobalStats,
      })
    ).toBe(0);
  });

  it('should format errors from string or array', () => {
    expect(component.getFormattedJobError(undefined)).toBeNull();
    expect(component.getFormattedJobError('Single error')).toBe('Single error');
    expect(component.getFormattedJobError(['Err 1', 'Err 2'])).toBe('Err 1\nErr 2');
  });

  it('should call stopJob and deleteJob through service', async () => {
    await component.stopJob(sampleRunningJob);
    expect(jobManagementMock.stopJob).toHaveBeenCalledWith(101, 'drive');

    await component.deleteJob(sampleCompletedJob);
    expect(jobManagementMock.deleteJob).toHaveBeenCalledWith(102);
  });
});
