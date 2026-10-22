import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Observable, Subject } from 'rxjs';
import { JobManagementService, areJobGroupsEqual } from './job-management.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { DEFAULT_JOB_STATS, JobInfo, JobChangeEvent, JobStatsUpdatedEvent } from '@app/types';

import { provideTranslateService } from '@ngx-translate/core';

describe('JobManagementService', () => {
  let service: JobManagementService;
  let mockApiClient: { invoke: ReturnType<typeof vi.fn> };
  let jobCacheChanged$: Subject<JobChangeEvent>;
  let jobStatsUpdated$: Subject<JobStatsUpdatedEvent>;
  let rcloneReady$: Subject<void>;
  let backendSwitched$: Subject<string>;

  const createMockJob = (overrides: Partial<JobInfo>): JobInfo => ({
    jobid: 1,
    backend_name: 'Local',
    execute_id: 'exec-1',
    job_type: 'sync',
    source: '/local/path',
    destination: 'remote:dest',
    start_time: '2026-09-10T10:00:00Z',
    status: 'Completed',
    remote_name: 'remote',
    stats: { ...DEFAULT_JOB_STATS },
    group: 'job/1',
    ...overrides,
  });

  beforeEach(() => {
    jobCacheChanged$ = new Subject<JobChangeEvent>();
    jobStatsUpdated$ = new Subject<JobStatsUpdatedEvent>();
    rcloneReady$ = new Subject<void>();
    backendSwitched$ = new Subject<string>();
    mockApiClient = {
      invoke: vi.fn().mockResolvedValue([]),
    };

    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        JobManagementService,
        {
          provide: ApiClientService,
          useValue: mockApiClient,
        },
        {
          provide: EventListenersService,
          useValue: {
            listenToJobCacheChanged: (): Observable<JobChangeEvent> => jobCacheChanged$,
            listenToJobStatsUpdated: (): Observable<JobStatsUpdatedEvent> => jobStatsUpdated$,
            listenToBackendSwitched: (): Observable<string> => backendSwitched$,
            listenToRcloneEngineReady: (): Observable<void> => rcloneReady$,
          },
        },
      ],
    });

    service = TestBed.inject(JobManagementService);
  });

  it('initializes and calls refreshJobs', () => {
    expect(mockApiClient.invoke).toHaveBeenCalledWith('get_jobs', undefined);
  });

  describe('Workflow Node Job Lookups', () => {
    beforeEach(() => {
      const jobs: JobInfo[] = [
        createMockJob({
          jobid: 101,
          workflow_id: 'wf-1',
          node_id: 'node-sync-1',
          start_time: '2026-09-10T10:00:00Z',
          status: 'Completed',
        }),
        createMockJob({
          jobid: 102,
          workflow_id: 'wf-1',
          node_id: 'node-sync-1',
          start_time: '2026-09-10T10:30:00Z',
          status: 'Running',
        }),
        createMockJob({
          jobid: 103,
          workflow_id: 'wf-1',
          node_id: 'node-copy-2',
          start_time: '2026-09-10T09:00:00Z',
          status: 'Completed',
        }),
        createMockJob({
          jobid: 104,
          quick_run_id: 'qr-special',
          start_time: '2026-09-10T11:00:00Z',
          status: 'Completed',
        }),
        createMockJob({
          jobid: 105,
          workflow_id: 'wf-1',
          node_id: 'node-sync-1',
          parent_job_id: 102, // Sub-job should be ignored
          start_time: '2026-09-10T10:31:00Z',
          status: 'Running',
        }),
      ];

      (service as unknown as { _jobs: { set: (j: JobInfo[]) => void } })._jobs.set(jobs);
    });

    it('returns null when no job matches the workflow and node ID', () => {
      const result = service.getLatestJobForWorkflowNode('wf-1', 'non-existent-node');
      expect(result).toBeNull();
    });

    it('prioritizes running job over older completed jobs for the same node', () => {
      const result = service.getLatestJobForWorkflowNode('wf-1', 'node-sync-1');
      expect(result).not.toBeNull();
      expect(result?.jobid).toBe(102);
      expect(result?.status).toBe('Running');
    });

    it('returns the latest completed job when no job is running', () => {
      const result = service.getLatestJobForWorkflowNode('wf-1', 'node-copy-2');
      expect(result).not.toBeNull();
      expect(result?.jobid).toBe(103);
    });

    it('finds job by quickRunId when workflow_id/node_id are not present', () => {
      const result = service.getLatestJobForWorkflowNode('wf-unknown', 'node-qr', 'qr-special');
      expect(result).not.toBeNull();
      expect(result?.jobid).toBe(104);
    });

    it('getActiveJobForWorkflowNode only returns running job and ignores sub-jobs', () => {
      const active = service.getActiveJobForWorkflowNode('wf-1', 'node-sync-1');
      expect(active).not.toBeNull();
      expect(active?.jobid).toBe(102);

      const noActive = service.getActiveJobForWorkflowNode('wf-1', 'node-copy-2');
      expect(noActive).toBeNull();
    });
  });

  describe('getJob', () => {
    beforeEach(() => {
      const jobs: JobInfo[] = [
        createMockJob({
          jobid: 1,
          execute_id: 'exec-old-session',
          job_type: 'sync',
          status: 'Completed',
        }),
        createMockJob({
          jobid: 1,
          execute_id: 'exec-new-session',
          job_type: 'copy',
          status: 'Running',
        }),
        createMockJob({
          jobid: 2,
          execute_id: 'exec-unique',
          job_type: 'move',
          status: 'Completed',
        }),
      ];

      (service as unknown as { _jobs: { set: (j: JobInfo[]) => void } })._jobs.set(jobs);
    });

    it('prioritizes execute_id over jobid when jobid collides across sessions', () => {
      const oldJob = service.getJob('exec-old-session', 1);
      expect(oldJob).toBeDefined();
      expect(oldJob?.execute_id).toBe('exec-old-session');
      expect(oldJob?.job_type).toBe('sync');

      const newJob = service.getJob('exec-new-session', 1);
      expect(newJob).toBeDefined();
      expect(newJob?.execute_id).toBe('exec-new-session');
      expect(newJob?.job_type).toBe('copy');
    });

    it('finds job directly by execute_id without jobid', () => {
      const job = service.getJob('exec-unique');
      expect(job).toBeDefined();
      expect(job?.jobid).toBe(2);
      expect(job?.execute_id).toBe('exec-unique');
    });

    it('uses the numeric ID only when no execution identity was supplied', () => {
      const job = service.getJob('', 2);
      expect(job).toBeDefined();
      expect(job?.jobid).toBe(2);
    });

    it('does not retarget another execution when the requested identity disappeared', () => {
      expect(service.getJob('removed-execution', 2)).toBeUndefined();
      expect(service.getJob('', 2, 'Other')).toBeUndefined();
    });

    it('returns undefined when neither matches', () => {
      const job = service.getJob('unknown-exec', 999);
      expect(job).toBeUndefined();
    });
  });

  describe('Job Stats Updates', () => {
    it('ignores reused job IDs and out-of-order events within an execution', async () => {
      mockApiClient.invoke.mockResolvedValue([
        createMockJob({ jobid: 42, status: 'Running', stats_revision: 3 }),
      ]);
      await service.refreshJobs();
      const emit = (executeId: string, statsRevision: number, bytes: number): void =>
        jobStatsUpdated$.next({
          backendName: 'Local',
          jobId: 42,
          executeId,
          statsRevision,
          stats: { ...DEFAULT_JOB_STATS, bytes },
        });
      emit('previous-session', 100, 1000);
      expect(service.jobs()[0].stats.bytes).toBe(0);
      emit('exec-1', 5, 500);
      emit('exec-1', 4, 400);
      expect(service.jobs()[0].stats.bytes).toBe(500);
      expect(service.jobs()[0].stats_revision).toBe(5);
    });

    it('ignores stats from another backend with the same job ID', async () => {
      const initialJob = createMockJob({ jobid: 42, stats: { ...DEFAULT_JOB_STATS, bytes: 100 } });
      mockApiClient.invoke.mockResolvedValueOnce([initialJob]);
      await service.refreshJobs();
      const jobs = service.jobs();

      jobStatsUpdated$.next({
        backendName: 'Other',
        jobId: 42,
        stats: { ...DEFAULT_JOB_STATS, bytes: 900 },
      });

      expect(service.jobs()).toBe(jobs);
      expect(service.jobs()[0].stats.bytes).toBe(100);
    });

    it('updates job stats directly without invoking get_jobs', async () => {
      const initialJob = createMockJob({ jobid: 42, stats: { ...DEFAULT_JOB_STATS, bytes: 100 } });
      mockApiClient.invoke.mockResolvedValueOnce([initialJob]);
      await service.refreshJobs();

      expect(service.jobs()[0].stats.bytes).toBe(100);
      mockApiClient.invoke.mockClear();

      const newStats = { ...DEFAULT_JOB_STATS, bytes: 500, speed: 50 };
      jobStatsUpdated$.next({ backendName: 'Local', jobId: 42, stats: newStats });

      expect(service.jobs()[0].stats.bytes).toBe(500);
      expect(service.jobs()[0].stats.speed).toBe(50);
      expect(mockApiClient.invoke).not.toHaveBeenCalled();
    });
  });

  describe('areJobGroupsEqual & jobsByRemote reference stability', () => {
    it('returns true for same reference or structurally identical groups', () => {
      const jobA = createMockJob({ jobid: 1, remote_name: 'r1', status: 'Running' });
      const groupA = { r1: [jobA] };
      expect(areJobGroupsEqual(groupA, groupA)).toBe(true);

      const jobB = createMockJob({ jobid: 1, remote_name: 'r1', status: 'Running' });
      const groupB = { r1: [jobB] };
      expect(areJobGroupsEqual(groupA, groupB)).toBe(true);
    });

    it('returns true when only stats differ between job groups', () => {
      const jobA = createMockJob({
        jobid: 1,
        remote_name: 'r1',
        stats: { ...DEFAULT_JOB_STATS, bytes: 100, speed: 10 },
      });
      const jobB = createMockJob({
        jobid: 1,
        remote_name: 'r1',
        stats: { ...DEFAULT_JOB_STATS, bytes: 9000, speed: 500 },
      });
      expect(areJobGroupsEqual({ r1: [jobA] }, { r1: [jobB] })).toBe(true);
    });

    it('returns false when status, jobid, profile, or error differs', () => {
      const jobA = createMockJob({ jobid: 1, remote_name: 'r1', status: 'Running' });
      const jobDifferentStatus = createMockJob({
        jobid: 1,
        remote_name: 'r1',
        status: 'Completed',
      });
      const jobDifferentId = createMockJob({ jobid: 2, remote_name: 'r1', status: 'Running' });
      const jobDifferentProfile = createMockJob({
        jobid: 1,
        remote_name: 'r1',
        status: 'Running',
        profile: 'prof-a',
      });
      const jobDifferentError = createMockJob({
        jobid: 1,
        remote_name: 'r1',
        status: 'Running',
        error: 'disk full',
      });

      expect(areJobGroupsEqual({ r1: [jobA] }, { r1: [jobDifferentStatus] })).toBe(false);
      expect(areJobGroupsEqual({ r1: [jobA] }, { r1: [jobDifferentId] })).toBe(false);
      expect(areJobGroupsEqual({ r1: [jobA] }, { r1: [jobDifferentProfile] })).toBe(false);
      expect(areJobGroupsEqual({ r1: [jobA] }, { r1: [jobDifferentError] })).toBe(false);
    });

    it.each<Partial<JobInfo>>([
      { origin: 'quickrun' },
      { quick_run_id: 'qr' },
      { workflow_id: 'workflow' },
      { node_id: 'node' },
      { execute_id: 'replacement' },
      { backend_name: 'Other' },
      { start_time: '2026-10-17T00:00:00Z' },
    ])('invalidates groups when execution ownership or identity changes: %j', changes => {
      const job = createMockJob({ remote_name: 'drive' });
      expect(areJobGroupsEqual({ drive: [job] }, { drive: [{ ...job, ...changes }] })).toBe(false);
    });

    it('returns false when remotes count, keys, or array lengths differ', () => {
      const job1 = createMockJob({ jobid: 1, remote_name: 'r1' });
      const job2 = createMockJob({ jobid: 2, remote_name: 'r2' });

      expect(areJobGroupsEqual({ r1: [job1] }, { r1: [job1], r2: [job2] })).toBe(false);
      expect(areJobGroupsEqual({ r1: [job1] }, { r2: [job2] })).toBe(false);
      expect(areJobGroupsEqual({ r1: [job1] }, { r1: [job1, job2] })).toBe(false);
    });

    it('preserves jobsByRemote signal reference when jobStatsUpdated arrives', async () => {
      const initialJob = createMockJob({
        jobid: 77,
        remote_name: 'my-remote',
        status: 'Running',
        stats: { ...DEFAULT_JOB_STATS, bytes: 100 },
      });
      mockApiClient.invoke.mockResolvedValueOnce([initialJob]);
      await service.refreshJobs();

      const initialGroupRef = service.jobsByRemote();
      expect(initialGroupRef['my-remote']).toHaveLength(1);

      // Emit high-frequency transfer telemetry
      jobStatsUpdated$.next({
        jobId: 77,
        backendName: 'Local',
        stats: { ...DEFAULT_JOB_STATS, bytes: 200, speed: 50 },
      });

      const updatedGroupRef = service.jobsByRemote();
      // Reference should be preserved to stop downstream remote-card re-evaluation
      expect(updatedGroupRef).toBe(initialGroupRef);
    });
  });

  describe('snapshot refreshes', () => {
    it.each([
      { executeId: 'exec-1', eventRevision: 5, snapshotRevision: 6, expectedBytes: 100 },
      { executeId: 'exec-1', eventRevision: 7, snapshotRevision: 6, expectedBytes: 900 },
      { executeId: 'old-execution', eventRevision: 100, snapshotRevision: 6, expectedBytes: 100 },
    ])('merges in-flight telemetry by execution and revision: %j', async scenario => {
      await service.refreshJobs();
      let finish!: (jobs: JobInfo[]) => void;
      mockApiClient.invoke.mockReturnValueOnce(
        new Promise<JobInfo[]>(resolve => {
          finish = resolve;
        })
      );
      const refresh = service.refreshJobs();
      jobStatsUpdated$.next({
        backendName: 'Local',
        jobId: 42,
        executeId: scenario.executeId,
        statsRevision: scenario.eventRevision,
        stats: { ...DEFAULT_JOB_STATS, bytes: 900 },
      });
      jobStatsUpdated$.next({
        backendName: 'Local',
        jobId: 42,
        executeId: scenario.executeId,
        statsRevision: scenario.eventRevision - 1,
        stats: { ...DEFAULT_JOB_STATS, bytes: 800 },
      });
      finish([
        createMockJob({
          jobid: 42,
          status: 'Running',
          stats_revision: scenario.snapshotRevision,
          stats: { ...DEFAULT_JOB_STATS, bytes: 100 },
        }),
      ]);
      await refresh;
      expect(service.jobs()[0].stats.bytes).toBe(scenario.expectedBytes);
    });

    it('serializes overlapping requests into one trailing refresh', async () => {
      await service.refreshJobs();
      mockApiClient.invoke.mockClear();
      let finish!: (jobs: JobInfo[]) => void;
      mockApiClient.invoke
        .mockReturnValueOnce(
          new Promise<JobInfo[]>(resolve => {
            finish = resolve;
          })
        )
        .mockResolvedValueOnce([createMockJob({ jobid: 2 })]);
      const first = service.refreshJobs();
      const second = service.refreshJobs();
      const third = service.refreshJobs();
      expect(mockApiClient.invoke).toHaveBeenCalledTimes(1);
      finish([createMockJob({ jobid: 1 })]);
      await Promise.all([first, second, third]);
      expect(mockApiClient.invoke).toHaveBeenCalledTimes(2);
      expect(service.jobs()[0].jobid).toBe(2);
    });

    it('preserves running telemetry received while a snapshot is loading', async () => {
      await service.refreshJobs();
      let finish!: (jobs: JobInfo[]) => void;
      mockApiClient.invoke.mockReturnValueOnce(
        new Promise<JobInfo[]>(resolve => {
          finish = resolve;
        })
      );
      const refresh = service.refreshJobs();
      jobStatsUpdated$.next({
        backendName: 'Local',
        jobId: 42,
        stats: { ...DEFAULT_JOB_STATS, bytes: 900 },
      });
      jobStatsUpdated$.next({
        backendName: 'Local',
        jobId: 42,
        stats: { ...DEFAULT_JOB_STATS, bytes: 950 },
      });
      finish([
        createMockJob({
          jobid: 42,
          status: 'Running',
          stats: { ...DEFAULT_JOB_STATS, bytes: 100 },
        }),
      ]);
      await refresh;
      expect(service.jobs()[0].stats.bytes).toBe(950);
    });

    it('discards the previous backend snapshot and refreshes the new selection', async () => {
      await service.refreshJobs();
      let finish!: (jobs: JobInfo[]) => void;
      mockApiClient.invoke
        .mockReturnValueOnce(
          new Promise<JobInfo[]>(resolve => {
            finish = resolve;
          })
        )
        .mockResolvedValueOnce([createMockJob({ backend_name: 'Other' })]);
      const refresh = service.refreshJobs();
      backendSwitched$.next('Other');
      expect(service.jobs()).toEqual([]);
      finish([createMockJob({ backend_name: 'Local' })]);
      await refresh;
      expect(service.jobs()[0].backend_name).toBe('Other');
      jobStatsUpdated$.next({
        backendName: 'Local',
        jobId: 1,
        stats: { ...DEFAULT_JOB_STATS, bytes: 999 },
      });
      expect(service.jobs()[0].stats.bytes).toBe(0);
    });

    it('sorts snapshots once and isolates dashboard profiles from workflow and quick-run jobs', async () => {
      await service.refreshJobs();
      mockApiClient.invoke.mockResolvedValueOnce([
        createMockJob({ jobid: 50, profile: 'daily', start_time: '2026-10-01T10:00:00Z' }),
        createMockJob({
          jobid: 1,
          profile: 'daily',
          status: 'Running',
          start_time: '2026-10-02T10:00:00Z',
        }),
        createMockJob({
          jobid: 60,
          profile: 'daily',
          quick_run_id: 'qr',
          start_time: '2026-10-03T10:00:00Z',
        }),
        createMockJob({
          jobid: 61,
          profile: 'daily',
          workflow_id: 'flow',
          start_time: '2026-10-04T10:00:00Z',
        }),
        createMockJob({
          jobid: 62,
          profile: 'daily',
          quick_run_id: 'qr',
          parent_job_id: 60,
          start_time: '2026-10-05T10:00:00Z',
        }),
      ]);
      await service.refreshJobs();
      expect(service.jobs().map(job => job.jobid)).toEqual([62, 61, 60, 1, 50]);
      expect(service.getLatestJobForRemote('remote', 'daily', 'sync')?.jobid).toBe(1);
      expect(service.getLatestJobForQuickRun('qr')?.jobid).toBe(60);
    });

    it('prefers the selected workflow node over an unrelated execution of the same quick run', async () => {
      await service.refreshJobs();
      mockApiClient.invoke.mockResolvedValueOnce([
        createMockJob({ jobid: 1, workflow_id: 'selected', node_id: 'node', quick_run_id: 'qr' }),
        createMockJob({ jobid: 2, workflow_id: 'other', node_id: 'node', quick_run_id: 'qr' }),
      ]);
      await service.refreshJobs();
      expect(service.getLatestJobForWorkflowNode('selected', 'node', 'qr')?.jobid).toBe(1);
      expect(service.getLatestJobForWorkflowNode('missing', 'node', 'qr')).toBeNull();
    });
  });
});
