import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Observable, Subject } from 'rxjs';
import { JobManagementService, areJobGroupsEqual } from './job-management.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { DEFAULT_JOB_STATS, JobInfo, JobStatsUpdatedEvent } from '@app/types';

import { provideTranslateService } from '@ngx-translate/core';

describe('JobManagementService', () => {
  let service: JobManagementService;
  let mockApiClient: { invoke: ReturnType<typeof vi.fn> };
  let jobCacheChanged$: Subject<JobInfo[]>;
  let jobStatsUpdated$: Subject<JobStatsUpdatedEvent>;
  let rcloneReady$: Subject<void>;

  const createMockJob = (overrides: Partial<JobInfo>): JobInfo => ({
    jobid: 1,
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
    jobCacheChanged$ = new Subject<JobInfo[]>();
    jobStatsUpdated$ = new Subject<JobStatsUpdatedEvent>();
    rcloneReady$ = new Subject<void>();
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
            listenToJobCacheChanged: (): Observable<JobInfo[]> => jobCacheChanged$,
            listenToJobStatsUpdated: (): Observable<JobStatsUpdatedEvent> => jobStatsUpdated$,
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

    it('falls back to jobid when execute_id is not found', () => {
      const job = service.getJob('non-existent-exec-id', 2);
      expect(job).toBeDefined();
      expect(job?.jobid).toBe(2);
    });

    it('returns undefined when neither matches', () => {
      const job = service.getJob('unknown-exec', 999);
      expect(job).toBeUndefined();
    });
  });

  describe('Job Stats Updates', () => {
    it('updates job stats directly without invoking get_jobs', async () => {
      const initialJob = createMockJob({ jobid: 42, stats: { ...DEFAULT_JOB_STATS, bytes: 100 } });
      mockApiClient.invoke.mockResolvedValueOnce([initialJob]);
      await service.refreshJobs();

      expect(service.jobs()[0].stats.bytes).toBe(100);
      mockApiClient.invoke.mockClear();

      const newStats = { ...DEFAULT_JOB_STATS, bytes: 500, speed: 50 };
      jobStatsUpdated$.next({ jobId: 42, stats: newStats });

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
        stats: { ...DEFAULT_JOB_STATS, bytes: 200, speed: 50 },
      });

      const updatedGroupRef = service.jobsByRemote();
      // Reference should be preserved to stop downstream remote-card re-evaluation
      expect(updatedGroupRef).toBe(initialGroupRef);
    });
  });
});
