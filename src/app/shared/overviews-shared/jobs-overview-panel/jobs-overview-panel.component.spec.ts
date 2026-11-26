import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';
import { JobsOverviewPanelComponent } from './jobs-overview-panel.component';
import { DEFAULT_JOB_STATS, ExecutionScope, JobInfo, JobStatus } from '@app/types';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { RcloneStatusService } from 'src/app/services/infrastructure/maintenance/rclone-status.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { OriginFilterService } from 'src/app/services/ui/state/origin-filter.service';

describe('JobsOverviewPanelComponent', () => {
  let component: JobsOverviewPanelComponent;
  let fixture: ComponentFixture<JobsOverviewPanelComponent>;

  // The chips choose the filter, and only while they are shown.
  const chooseFilter = (filter: string): void => {
    fixture.componentRef.setInput('showFilterChips', true);
    TestBed.inject(OriginFilterService).set('jobs', filter);
  };
  let mockModalService: { openJobDetail: ReturnType<typeof vi.fn> };
  const stopJob = vi.fn<JobManagementService['stopJob']>();
  const deleteJob = vi.fn<JobManagementService['deleteJob']>();
  const jobs = signal<JobInfo[]>([]);

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
      origin: 'workflow',
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
    localStorage.clear();
    stopJob.mockReset().mockResolvedValue(undefined);
    deleteJob.mockReset().mockResolvedValue(undefined);
    jobs.set(mockJobs);
    const mockJobService = {
      jobs,
      stopJob,
      deleteJob,
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

  it("shows a running job's speed, time left and files in its row", () => {
    const pills = (): string[] =>
      Array.from<HTMLElement>(
        fixture.nativeElement.querySelectorAll('.running-jobs-section .card-footer-right .app-pill')
      ).map(pill => pill.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    jobs.set([
      {
        ...mockJobs[0],
        stats: { ...DEFAULT_JOB_STATS, speed: 0, eta: 0, transfers: 0, totalTransfers: 0 },
      },
    ]);
    fixture.detectChanges();
    // Nothing moves yet: the row says the job is starting, beside how long it has run.
    expect(pills()[0]).toBe('generalOverview.jobs.starting');
    expect(pills()).not.toContain('0 / 0');

    jobs.set([
      {
        ...mockJobs[0],
        stats: {
          ...DEFAULT_JOB_STATS,
          speed: 2048,
          eta: 90,
          transfers: 2,
          totalTransfers: 5,
          errors: 1,
        },
      },
    ]);
    fixture.detectChanges();
    const shown = pills();
    expect(shown[0]).not.toBe('generalOverview.jobs.starting');
    expect(shown.slice(2, 4)).toEqual(['2 / 5', '1']);
  });

  it('filters running jobs correctly by flow origin', () => {
    expect(component.runningJobs().length).toBe(3);

    chooseFilter('workflow');
    fixture.detectChanges();
    expect(component.runningJobs().length).toBe(1);
    expect(component.runningJobs()[0].origin).toBe('workflow');
  });

  it('counts every running job in the header when a chip hides all of them', () => {
    chooseFilter('update');
    fixture.detectChanges();
    expect(component.runningJobs()).toEqual([]);
    expect(component.activeJobsCount()).toBe(3);
    expect(component.hiddenCount()).toBe(3);
    expect(fixture.nativeElement.querySelector('mat-panel-description')?.textContent).not.toContain(
      'noActive'
    );
  });

  it('counts the running jobs a chip leaves out', () => {
    expect(component.hiddenCount()).toBe(0);
    chooseFilter('workflow');
    expect(component.hiddenCount()).toBe(2);
  });

  it('filters running jobs correctly by quickrun origin', () => {
    chooseFilter('quickrun');
    fixture.detectChanges();
    expect(component.runningJobs().length).toBe(1);
    expect(component.runningJobs()[0].origin).toBe('quickrun');
  });

  it('filters running jobs correctly by dashboard origin', () => {
    chooseFilter('dashboard');
    fixture.detectChanges();
    expect(component.runningJobs().length).toBe(1);
    expect(component.runningJobs()[0].origin).toBe('dashboard');
  });

  it.each<[ExecutionScope, string[]]>([
    [{ origin: undefined }, ['dashboard']],
    [{ origin: 'dashboard', starter: { kind: 'quick_run', id: 'qr', name: 'qr' } }, ['quickrun']],
    [
      {
        origin: 'automation',
        starter: {
          kind: 'workflow',
          workflowId: 'wf',
          workflowName: 'Workflow',
          nodeId: 'node',
          ancestors: [],
        },
      },
      ['workflow'],
    ],
    [
      {
        origin: 'quickrun',
        starter: {
          kind: 'quick_run',
          id: 'qr',
          name: 'qr',
          workflow: { workflowId: 'wf', workflowName: 'Workflow', nodeId: 'node', ancestors: [] },
        },
      },
      ['workflow'],
    ],
    [{ origin: 'workflow' }, ['workflow']],
    // Work of a remote's own profiles, however it was started, is dashboard work.
    [{ origin: 'startup' }, ['dashboard', 'startup']],
    [{ origin: 'filemanager' }, ['dashboard', 'filemanager']],
  ])('uses execution ownership for filtering: %j', (scope, shownUnder) => {
    const job: JobInfo = { ...mockJobs[0], ...scope };
    jobs.set([job]);
    for (const filter of ['dashboard', 'quickrun', 'workflow', 'filemanager', 'startup']) {
      chooseFilter(filter);
      expect(component.runningJobs()).toEqual(shownUnder.includes(filter) ? [job] : []);
    }
  });

  it('lists the running jobs in the job rows, which stop the clicked one and open its detail', async () => {
    const section: HTMLElement = fixture.nativeElement.querySelector('.running-jobs-section');
    const rows = section.querySelectorAll('app-jobs-panel .card-row-item');
    expect(rows.length).toBe(component.runningJobs().length);
    (rows[0].querySelector('.action-button') as HTMLElement).click();
    await fixture.whenStable();
    expect(stopJob).toHaveBeenCalledExactlyOnceWith(component.runningJobs()[0].jobid);
    expect(mockModalService.openJobDetail).not.toHaveBeenCalled();
    (rows[0] as HTMLElement).click();
    expect(mockModalService.openJobDetail).toHaveBeenCalledWith(
      expect.objectContaining({ jobid: component.runningJobs()[0].jobid })
    );
  });

  describe('recent jobs', () => {
    const finished = (jobid: number, status: JobStatus, extra: Partial<JobInfo> = {}): JobInfo => ({
      ...mockJobs[0],
      jobid,
      execute_id: `exec-${jobid}`,
      status,
      origin: 'dashboard',
      ...extra,
    });
    const listed = (): number[] =>
      [...fixture.nativeElement.querySelectorAll('.recent-jobs app-jobs-panel .card-row-item')].map(
        (row: HTMLElement) =>
          Number(row.querySelector('.job-id-label')?.textContent?.trim().slice(1))
      );

    it('lists finished jobs of every remote and local disk, without their child jobs', () => {
      jobs.set([
        mockJobs[0],
        finished(10, 'Completed', { remote_name: '/', source: '/home/me/a', destination: '/tmp' }),
        finished(11, 'Failed', { remote_name: 'drive:', origin: 'filemanager' }),
        finished(12, 'Stopped'),
        finished(13, 'Completed', { parent_job_id: 12 }),
      ]);
      component.setRecentOpen(true);
      fixture.detectChanges();
      expect(component.recentJobs().map(job => job.jobid)).toEqual([10, 11, 12]);
      expect(listed()).toEqual([10, 11, 12]);
    });

    it('follows the origin chips', () => {
      jobs.set([
        finished(10, 'Completed', { origin: 'filemanager' }),
        finished(11, 'Completed', { starter: { kind: 'quick_run', id: 'qr', name: 'qr' } }),
      ]);
      chooseFilter('quickrun');
      expect(component.recentJobs().map(job => job.jobid)).toEqual([11]);
      chooseFilter('dashboard');
      expect(component.recentJobs().map(job => job.jobid)).toEqual([10]);
    });

    it('keeps the list to the latest fifty', () => {
      jobs.set(Array.from({ length: 60 }, (_, i) => finished(i + 1, 'Completed')));
      expect(component.recentJobs().map(job => job.jobid)).toEqual(
        Array.from({ length: 50 }, (_, i) => i + 1)
      );
    });

    it('shows no section while no job has finished', () => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('details.recent-jobs')).toBeNull();
    });

    it('stays folded until opened, shows the count meanwhile and remembers the choice', () => {
      jobs.set([finished(10, 'Completed'), finished(11, 'Failed')]);
      fixture.detectChanges();
      const details = (): HTMLDetailsElement =>
        fixture.nativeElement.querySelector('details.recent-jobs');
      expect(details().open).toBe(false);
      expect(details().querySelector('summary [appPill]')?.textContent?.trim()).toBe('2');
      expect(listed()).toEqual([]);

      component.setRecentOpen(true);
      fixture.detectChanges();
      expect(details().open).toBe(true);
      expect(listed()).toEqual([10, 11]);

      const reopened = TestBed.createComponent(JobsOverviewPanelComponent);
      expect(reopened.componentInstance.recentOpen()).toBe(true);
    });

    it('follows the user opening and closing the section', () => {
      jobs.set([finished(10, 'Completed')]);
      fixture.detectChanges();
      const details: HTMLDetailsElement =
        fixture.nativeElement.querySelector('details.recent-jobs');
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
      expect(component.recentOpen()).toBe(true);
      details.open = false;
      details.dispatchEvent(new Event('toggle'));
      expect(component.recentOpen()).toBe(false);
    });

    it('deletes the job its row asks for', async () => {
      jobs.set([finished(10, 'Completed')]);
      component.setRecentOpen(true);
      fixture.detectChanges();
      (fixture.nativeElement.querySelector('app-jobs-panel .action-button') as HTMLElement).click();
      await fixture.whenStable();
      expect(deleteJob).toHaveBeenCalledExactlyOnceWith(10);
    });

    it('handles a delete failure', async () => {
      const error = new Error('gone');
      deleteJob.mockRejectedValueOnce(error);
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(component.onDeleteJob(10)).resolves.toBeUndefined();
        expect(log).toHaveBeenCalledWith('Failed to delete job:', error);
      } finally {
        log.mockRestore();
      }
    });
  });
});
