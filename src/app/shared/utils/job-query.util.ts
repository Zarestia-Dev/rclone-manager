import {
  DEFAULT_JOB_STATS,
  GlobalStats,
  JOB_STATUS,
  JobInfo,
  JobStatsUpdatedEvent,
} from '@app/types';

/** Reject delayed telemetry from another execution or an older snapshot. */
export function isNewerJobStats(job: JobInfo, event: JobStatsUpdatedEvent): boolean {
  if (event.executeId && event.executeId !== job.execute_id) return false;
  if (event.statsRevision === undefined) return job.stats_revision === undefined;
  return event.statsRevision > (job.stats_revision ?? -1);
}

function startTime(job: JobInfo): number {
  const time = Date.parse(job.start_time);
  return Number.isFinite(time) ? time : 0;
}

/** Newest first; job IDs only break ties because rclone may restart its ID counter. */
export function compareJobsNewestFirst(a: JobInfo, b: JobInfo): number {
  return startTime(b) - startTime(a) || b.jobid - a.jobid;
}

/** Active work first, then newest execution within each lifecycle group. */
export function compareJobsRunningFirst(a: JobInfo, b: JobInfo): number {
  if (a.status === JOB_STATUS.Running && b.status !== JOB_STATUS.Running) return -1;
  if (b.status === JOB_STATUS.Running && a.status !== JOB_STATUS.Running) return 1;
  return compareJobsNewestFirst(a, b);
}

/** Select one job without allocating and sorting the entire matching list. */
export function findLatestJob(
  jobs: readonly JobInfo[],
  matches: (job: JobInfo) => boolean,
  preferRunning = false
): JobInfo | null {
  const compare = preferRunning ? compareJobsRunningFirst : compareJobsNewestFirst;
  let latest: JobInfo | null = null;
  for (const job of jobs) {
    if (matches(job) && (!latest || compare(job, latest) < 0)) latest = job;
  }
  return latest;
}

/** Normalize sparse preparing/upload snapshots before exposing them to UI consumers. */
export function normalizeJobStats(stats: Partial<GlobalStats> | null | undefined): GlobalStats {
  return {
    ...DEFAULT_JOB_STATS,
    ...stats,
    eta: stats?.eta ?? 0,
    transferring: stats?.transferring ?? [],
    checking: stats?.checking ?? [],
    completed: stats?.completed ?? [],
  };
}
