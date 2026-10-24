import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';
import { JobsOverviewPanelComponent } from './jobs-overview-panel.component';
import { DEFAULT_JOB_STATS, ExecutionScope, JobInfo, Origin } from '@app/types';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { RcloneStatusService } from 'src/app/services/infrastructure/maintenance/rclone-status.service';
import { ModalService } from 'src/app/services/ui/modal.service';

describe('JobsOverviewPanelComponent', () => {
  let component: JobsOverviewPanelComponent;
  let fixture: ComponentFixture<JobsOverviewPanelComponent>;
  let mockModalService: { openJobDetail: ReturnType<typeof vi.fn> };
  const stopJob = vi.fn<JobManagementService['stopJob']>();

  const baseJob = {
    execute_id: 'execution',
    source: 'drive:',
    destination: 'backup:',
    status: 'Running',
    remote_name: 'drive',
    start_time: '2026-09-02T10:00:00Z',
    stats: { ...DEFAULT_JOB_STATS },
  } satisfies Omit<JobInfo, 'jobid' | 'job_type'>;
  const mockJobs: JobInfo[] = [
    {
      ...baseJob,
      jobid: 1,
      job_type: 'sync',
      stats: { ...DEFAULT_JOB_STATS, bytes: 100, totalBytes: 200 },
      start_time: '2026-09-02T10:00:00Z',
      origin: 'flow',
    },
    {
      ...baseJob,
      jobid: 2,
      job_type: 'copy',
      stats: { ...DEFAULT_JOB_STATS, bytes: 20, totalBytes: 100 },
      start_time: '2026-09-02T10:05:00Z',
      origin: 'quickrun',
    },
    {
      ...baseJob,
      jobid: 3,
      job_type: 'move',
      stats: { ...DEFAULT_JOB_STATS, bytes: 80, totalBytes: 100 },
      start_time: '2026-09-02T10:10:00Z',
      origin: 'dashboard',
    },
  ];

  beforeEach(async () => {
    stopJob.mockReset().mockResolvedValue(undefined);
    const mockJobService = {
      jobs: signal(mockJobs),
      stopJob,
    };
    const mockStatusService = {
      jobStats: signal({ bytes: 200, totalBytes: 400, speed: 23 }),
      isLoading: signal(false),
    };
    mockModalService = {
      openJobDetail: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [JobsOverviewPanelComponent],
      providers: [
        provideTranslateService(),
        { provide: JobManagementService, useValue: mockJobService },
        { provide: RcloneStatusService, useValue: mockStatusService },
        { provide: ModalService, useValue: mockModalService },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(JobsOverviewPanelComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('filters running jobs correctly by flow origin', () => {
    expect(component.runningJobs().length).toBe(3);

    component.selectedOriginFilter.set('flow');
    fixture.detectChanges();
    expect(component.runningJobs().length).toBe(1);
    expect(component.runningJobs()[0].origin).toBe('flow');
  });

  it('filters running jobs correctly by quickrun origin', () => {
    component.selectedOriginFilter.set('quickrun');
    fixture.detectChanges();
    expect(component.runningJobs().length).toBe(1);
    expect(component.runningJobs()[0].origin).toBe('quickrun');
  });

  it('filters running jobs correctly by dashboard origin', () => {
    component.selectedOriginFilter.set('dashboard');
    fixture.detectChanges();
    expect(component.runningJobs().length).toBe(1);
    expect(component.runningJobs()[0].origin).toBe('dashboard');
  });

  it.each<[ExecutionScope, Origin]>([
    [{ origin: undefined }, 'dashboard'],
    [{ origin: 'dashboard', quick_run_id: 'qr' }, 'quickrun'],
    [{ origin: 'automation', workflow_id: 'wf' }, 'flow'],
    [{ origin: 'quickrun', quick_run_id: 'qr', workflow_id: 'wf' }, 'flow'],
    [{ origin: 'flow', quick_run_id: 'qr' }, 'flow'],
    [{ origin: 'filemanager' }, 'filemanager'],
  ])('uses execution ownership for filtering and badges: %j', (scope, expected) => {
    const job: JobInfo = { ...mockJobs[0], ...scope };
    fixture.componentRef.setInput('jobs', [job]);
    for (const filter of ['dashboard', 'quickrun', 'flow', 'filemanager']) {
      component.selectedOriginFilter.set(filter);
      expect(component.runningJobs()).toEqual(filter === expected ? [job] : []);
    }
    component.selectedOriginFilter.set(expected);
    expect(component.runningJobViewModels()[0].originBadgeClass).toBe(
      component.getOriginBadgeClass(expected)
    );
  });

  it('returns correct origin labels and badge classes', () => {
    expect(component.getOriginLabel('flow')).toBe('Flow');
    expect(component.getOriginBadgeClass('flow')).toBe('p-accent');

    expect(component.getOriginLabel('quickrun')).toBe('Quick Run');
    expect(component.getOriginBadgeClass('quickrun')).toBe('p-primary');

    expect(component.getOriginLabel('dashboard')).toBe('Dashboard');
    expect(component.getOriginBadgeClass('dashboard')).toBe('p-dim');
  });

  it('opens job detail modal on job row click', () => {
    const job = mockJobs[0];
    component.onJobRowClick(job);
    expect(mockModalService.openJobDetail).toHaveBeenCalledWith(job);
  });

  it('stops the selected execution when another job has the same remote, type and profile', async () => {
    const first: JobInfo = { ...mockJobs[0], profile: 'daily', origin: 'dashboard' };
    const selected: JobInfo = {
      ...first,
      jobid: 202,
      execute_id: 'selected-execution',
      origin: 'quickrun',
      quick_run_id: 'qr-1',
    };
    fixture.componentRef.setInput('jobs', [first, selected]);
    const event = new MouseEvent('click');
    const propagation = vi.spyOn(event, 'stopPropagation');

    await component.onStopJobClick(selected, event);

    expect(stopJob).toHaveBeenCalledExactlyOnceWith(202, 'drive');
    expect(propagation).toHaveBeenCalledOnce();
    expect(mockModalService.openJobDetail).not.toHaveBeenCalled();
  });

  it('does not substitute another job if the selected execution is no longer listed', async () => {
    const selected: JobInfo = { ...mockJobs[0], jobid: 404 };
    fixture.componentRef.setInput('jobs', [mockJobs[0]]);
    await component.onStopJobClick(selected, new MouseEvent('click'));
    expect(stopJob).toHaveBeenCalledExactlyOnceWith(404, 'drive');
  });

  it('handles a stop failure without trying another execution', async () => {
    const error = new Error('job already finished');
    stopJob.mockRejectedValueOnce(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        component.onStopJobClick(mockJobs[0], new MouseEvent('click'))
      ).resolves.toBeUndefined();
      expect(stopJob).toHaveBeenCalledExactlyOnceWith(1, 'drive');
      expect(log).toHaveBeenCalledWith('Failed to stop job:', error);
    } finally {
      log.mockRestore();
    }
  });

  it('assigns correct job type and animation classes', () => {
    expect(component.getJobTypeClass({ job_type: 'sync' } as unknown as JobInfo)).toBe(
      'type-primary'
    );
    expect(component.getJobTypeClass({ job_type: 'copy' } as unknown as JobInfo)).toBe(
      'type-yellow'
    );
    expect(component.getJobTypeClass({ job_type: 'move' } as unknown as JobInfo)).toBe(
      'type-orange'
    );
    expect(component.getJobTypeClass({ job_type: 'mount' } as unknown as JobInfo)).toBe(
      'type-accent'
    );

    expect(component.getJobAnimationClass({ job_type: 'sync' } as unknown as JobInfo)).toBe(
      'animate-spin'
    );
    expect(component.getJobAnimationClass({ job_type: 'bisync' } as unknown as JobInfo)).toBe(
      'animate-spin'
    );
    expect(component.getJobAnimationClass({ job_type: 'copy' } as unknown as JobInfo)).toBe('');
  });

  it('computes runningJobViewModels with correct progress percentage', () => {
    const vms = component.runningJobViewModels();
    expect(vms.length).toBe(3);
    expect(vms[0].progressPercentage).toBe(50); // 100 / 200 = 50%
    expect(vms[1].progressPercentage).toBe(20); // 20 / 100 = 20%
    expect(vms[2].progressPercentage).toBe(80); // 80 / 100 = 80%
  });

  it('returns formatted job label using translation or fallback', () => {
    expect(component.getJobLabel({ job_type: 'sync' } as unknown as JobInfo)).toBeDefined();
    expect(component.getJobLabel({ job_type: 'custom_op' } as unknown as JobInfo)).toBe(
      'custom op'
    );
  });
});
