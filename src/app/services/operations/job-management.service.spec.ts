import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Observable, Subject } from 'rxjs';
import { JobManagementService } from './job-management.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { DEFAULT_JOB_STATS, JobInfo } from '@app/types';

import { provideTranslateService } from '@ngx-translate/core';

describe('JobManagementService', () => {
  let service: JobManagementService;
  let mockApiClient: { invoke: ReturnType<typeof vi.fn> };
  let jobCacheChanged$: Subject<JobInfo[]>;
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
});
