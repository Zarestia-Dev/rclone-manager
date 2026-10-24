import { describe, expect, it } from 'vitest';
import { DEFAULT_JOB_STATS, JOB_STATUS, JobInfo } from '@app/types';
import {
  compareJobsNewestFirst,
  findLatestJob,
  isNewerJobStats,
  normalizeJobStats,
} from './job-query.util';

const job = (id: number, overrides: Partial<JobInfo> = {}): JobInfo => ({
  jobid: id,
  execute_id: `exec-${id}`,
  job_type: 'sync',
  status: JOB_STATUS.Completed,
  source: 'drive:',
  destination: 'backup:',
  remote_name: 'drive',
  start_time: '2026-10-01T10:00:00Z',
  stats: { ...DEFAULT_JOB_STATS },
  ...overrides,
});

describe('job queries', () => {
  it('accepts only newer telemetry for the same execution, preserving legacy servers', () => {
    const current = job(1, { stats_revision: 4 });
    const event = {
      jobId: 1,
      backendName: 'Local',
      executeId: 'exec-1',
      statsRevision: 5,
      stats: { ...DEFAULT_JOB_STATS },
    };
    expect(isNewerJobStats(current, event)).toBe(true);
    expect(isNewerJobStats(current, { ...event, statsRevision: 4 })).toBe(false);
    expect(isNewerJobStats(current, { ...event, statsRevision: 3 })).toBe(false);
    expect(isNewerJobStats(current, { ...event, executeId: 'previous-execution' })).toBe(false);
    const legacy = { jobId: 1, backendName: 'Local', stats: { ...DEFAULT_JOB_STATS } };
    expect(isNewerJobStats(job(1), legacy)).toBe(true);
    expect(isNewerJobStats(current, legacy)).toBe(false);
  });

  it('orders by start time before IDs and handles invalid timestamps', () => {
    const older = job(900);
    const newer = job(1, { start_time: '2026-10-02T10:00:00Z' });
    expect(compareJobsNewestFirst(newer, older)).toBeLessThan(0);
    expect(compareJobsNewestFirst(job(1), job(2))).toBeGreaterThan(0);
    expect(compareJobsNewestFirst(job(1, { start_time: 'invalid' }), newer)).toBeGreaterThan(0);
    expect(
      compareJobsNewestFirst(job(1, { start_time: '' }), job(2, { start_time: 'invalid' }))
    ).toBeGreaterThan(0);
  });

  it('selects the newest matching job without changing input order', () => {
    const jobs = [job(1), job(2), job(3, { remote_name: 'other' })];
    const original = [...jobs];
    expect(findLatestJob(jobs, item => item.remote_name === 'drive')?.jobid).toBe(2);
    expect(jobs).toEqual(original);
    expect(findLatestJob([], () => true)).toBeNull();
    expect(findLatestJob(jobs, () => false)).toBeNull();
  });

  it('selects the newest running match deterministically when active work takes priority', () => {
    const jobs = [
      job(1, { status: JOB_STATUS.Running }),
      job(4),
      job(2, { status: JOB_STATUS.Running }),
    ];
    expect(findLatestJob(jobs, () => true, true)?.jobid).toBe(2);
    expect(findLatestJob([...jobs].reverse(), () => true, true)?.jobid).toBe(2);
    expect(findLatestJob(jobs, () => true)?.jobid).toBe(4);
  });

  it('normalizes missing and sparse statistics while preserving actual activity', () => {
    expect(normalizeJobStats(null)).toEqual({ ...DEFAULT_JOB_STATS, checking: [] });
    const transfers = [{ name: 'file.txt' }] as JobInfo['stats']['transferring'];
    const stats = normalizeJobStats({ bytes: 500, transferring: transfers });
    expect(stats.bytes).toBe(500);
    expect(stats.totalBytes).toBe(0);
    expect(stats.transferring).toBe(transfers);
    expect(stats.completed).toEqual([]);
    expect(stats.checking).toEqual([]);
  });
});
