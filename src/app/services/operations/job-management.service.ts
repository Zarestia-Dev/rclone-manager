import {
  DestroyRef,
  inject,
  Injectable,
  signal,
  computed,
  linkedSignal,
  resource,
  Signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import {
  BatchApiLabel,
  GlobalStats,
  JobInfo,
  JobActionType,
  JobChangeEvent,
  JobReport,
  JobStatsUpdatedEvent,
  JOB_STATUS,
  Origin,
  isProfileScoped,
  profileOf,
  quickRunIdOf,
  sameStarter,
  isWorkflowNode,
  workflowIdOf,
} from '@app/types';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { groupBy } from '../remote/utils/remote-config.utils';
import { CoalescedTask } from 'src/app/shared/utils/coalesced-task.util';
import {
  compareJobsNewestFirst,
  findLatestJob,
  isNewerJobStats,
  normalizeJobStats,
} from 'src/app/shared/utils/job-query.util';

@Injectable({
  providedIn: 'root',
})
export class JobManagementService extends TauriBaseService {
  private readonly _jobs = signal<JobInfo[]>([]);
  public readonly jobs = this._jobs.asReadonly();

  public readonly activeJobs = computed(() =>
    this._jobs().filter(job => job.status === JOB_STATUS.Running)
  );

  public readonly nautilusJobs = computed(() =>
    this._jobs().filter(job => job.origin === 'filemanager')
  );

  /** Metadata-only groups for remote status. Live telemetry is exposed by jobs. */
  public readonly jobsByRemote = computed(() => groupBy(this._jobs(), j => j.remote_name), {
    equal: areJobGroupsEqual,
  });

  private readonly destroyRef = inject(DestroyRef);
  private readonly eventListeners = inject(EventListenersService);

  private selectedBackend?: string;
  private backendEpoch = 0;
  private statsDuringRefresh?: Map<string, JobStatsUpdatedEvent>;
  private readonly refreshTask = new CoalescedTask(() => this.loadJobs());

  constructor() {
    super();
    this.initializeEventListeners();
    this.refreshJobs().catch(err =>
      console.error('[JobManagementService] initial job load failed:', err)
    );
  }

  private initializeEventListeners(): void {
    const refresh = (): void => {
      this.refreshJobs().catch(err =>
        console.error('[JobManagementService] Failed to refresh jobs:', err)
      );
    };
    this.eventListeners
      .listenToJobCacheChanged()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(event => {
        // While the whole list loads, its answer may be older than this change: load it again.
        // Before the first answer the selected backend is not known yet.
        if (this.statsDuringRefresh || !this.selectedBackend) refresh();
        else this.applyJobChange(event);
      });
    this.eventListeners
      .listenToRcloneEngineReady()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.backendEpoch++;
        refresh();
      });
    this.eventListeners
      .listenToBackendSwitched()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(name => {
        this.selectedBackend = name;
        this.backendEpoch++;
        this._jobs.set([]);
        refresh();
      });

    this.eventListeners
      .listenToJobStatsUpdated()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(event => {
        this.updateJobStats(event);
      });
  }

  /** Puts the job an event carries into the list, or takes it out, without loading the list. */
  private applyJobChange({ backendName, jobId, job }: JobChangeEvent): void {
    if (backendName !== this.selectedBackend) return;
    this._jobs.update(jobs => {
      const idx = jobs.findIndex(j => j.backend_name === backendName && j.jobid === jobId);
      if (!job) return idx === -1 ? jobs : jobs.filter((_, i) => i !== idx);
      const current = idx === -1 ? undefined : jobs[idx];
      // A change of the same run that arrives after a newer one is stale.
      if (
        current?.execute_id === job.execute_id &&
        (job.stats_revision ?? 0) < (current?.stats_revision ?? 0)
      ) {
        return jobs;
      }
      const next = { ...job, stats: normalizeJobStats(job.stats) };
      if (current?.start_time === next.start_time) {
        const updated = [...jobs];
        updated[idx] = next;
        return updated;
      }
      // A new job, or a new run under an id rclone reused, takes its place by start time.
      return [...jobs.filter((_, i) => i !== idx), next].sort(compareJobsNewestFirst);
    });
  }

  private updateJobStats(event: JobStatsUpdatedEvent): void {
    const { backendName, jobId } = event;
    if (this.selectedBackend && backendName !== this.selectedBackend) return;
    if (this.statsDuringRefresh) {
      const key = statsKey(backendName, jobId, event.executeId);
      const pending = this.statsDuringRefresh.get(key);
      if (!pending || event.statsRevision > pending.statsRevision) {
        this.statsDuringRefresh.set(key, event);
      }
    }
    this._jobs.update(jobs => {
      const idx = jobs.findIndex(j => j.backend_name === backendName && j.jobid === jobId);
      if (idx === -1 || !isNewerJobStats(jobs[idx], event)) return jobs;
      const updated = [...jobs];
      updated[idx] = {
        ...updated[idx],
        stats: listedStats(updated[idx], event.stats),
        stats_revision: event.statsRevision,
      };
      return updated;
    });
  }

  /**
   * The stats of the job `job` returns, with its file rows. The list carries a finished job
   * without them (they can be thousands), so they are fetched for it, again whenever the job
   * changes; a running job brings its own with every update.
   */
  detailedStats(job: () => JobInfo | null | undefined): Signal<GlobalStats | null> {
    const runOf = (j: JobInfo): string => JSON.stringify([j.backend_name, j.jobid, j.execute_id]);
    const fetched = resource({
      params: () => {
        const j = job();
        return j && j.status !== JOB_STATUS.Running
          ? { run: runOf(j), jobid: j.jobid, executeId: j.execute_id, revision: j.stats_revision }
          : undefined;
      },
      loader: async ({ params }) => ({
        run: params.run,
        stats: await this.getJobStats(params.jobid, params.executeId),
      }),
    });
    // A later fetch of the same run keeps showing the rows it had until it answers.
    const loaded = linkedSignal<
      { run: string; stats: Partial<GlobalStats> | null } | undefined,
      { run: string; stats: Partial<GlobalStats> | null } | undefined
    >({
      source: () => (fetched.hasValue() ? fetched.value() : undefined),
      computation: (next, previous) => next ?? previous?.value,
    });
    return computed(() => {
      const j = job();
      if (!j) return null;
      const full = loaded();
      if (j.status === JOB_STATUS.Running || full?.run !== runOf(j) || !full.stats) return j.stats;
      // The figures of the list are as new as the job; the rows come from the fetch.
      return {
        ...j.stats,
        completed: full.stats.completed ?? [],
        checkOutput: full.stats.checkOutput,
      };
    });
  }

  /** A job's stats with its file rows; `null` when that run of the job is gone. */
  async getJobStats(jobid: number, executeId?: string): Promise<Partial<GlobalStats> | null> {
    return this.invokeCommand<Partial<GlobalStats> | null>('get_job_stats', {
      jobid,
      executeId: executeId || null,
    });
  }

  getActiveJobsForRemote(remoteName: string, profile?: string): JobInfo[] {
    return this.activeJobs().filter(job => {
      if (job.parent_job_id != null) return false;
      const matchRemote = job.remote_name === remoteName;
      return profile ? matchRemote && profileOf(job) === profile : matchRemote;
    });
  }

  getLatestJobForRemote(
    remoteName: string,
    profile?: string,
    operationType?: JobActionType
  ): JobInfo | null {
    return findLatestJob(
      this._jobs(),
      job =>
        isProfileScoped(job) &&
        job.remote_name === remoteName &&
        job.parent_job_id == null &&
        (!operationType || job.job_type === operationType) &&
        (!profile || profileOf(job) === profile),
      true
    );
  }

  getJob(executeId: string, jobid?: number, backendName?: string): JobInfo | undefined {
    const belongsToBackend = (job: JobInfo): boolean =>
      !backendName || job.backend_name === backendName;
    // An explicit execution ID must never fall through to another session's numeric ID.
    if (executeId)
      return this._jobs().find(job => job.execute_id === executeId && belongsToBackend(job));
    return jobid === undefined
      ? undefined
      : this._jobs().find(job => job.jobid === jobid && belongsToBackend(job));
  }

  getLatestJobForWorkflowNode(
    workflowId: string,
    nodeId: string,
    quickRunId?: string
  ): JobInfo | null {
    const direct = findLatestJob(
      this._jobs(),
      job => job.parent_job_id == null && isWorkflowNode(job, workflowId, nodeId),
      true
    );
    if (direct || !quickRunId) return direct;
    return findLatestJob(
      this._jobs(),
      job => job.parent_job_id == null && !workflowIdOf(job) && quickRunIdOf(job) === quickRunId,
      true
    );
  }

  getLatestJobForQuickRun(quickRunId: string): JobInfo | null {
    return findLatestJob(
      this._jobs(),
      job => job.parent_job_id == null && quickRunIdOf(job) === quickRunId,
      true
    );
  }

  async refreshJobs(): Promise<JobInfo[]> {
    await this.refreshTask.run();
    return this._jobs();
  }

  private async loadJobs(): Promise<void> {
    const epoch = this.backendEpoch;
    const pendingStats = new Map<string, JobStatsUpdatedEvent>();
    this.statsDuringRefresh = pendingStats;
    try {
      const jobs = await this.invokeCommand<JobInfo[]>('get_jobs');
      if (epoch !== this.backendEpoch || this.destroyRef.destroyed) return;
      // get_jobs is authoritative for the active cache, including after a missed switch event.
      this.selectedBackend = jobs[0]?.backend_name ?? this.selectedBackend;
      // Preserve telemetry received while the full snapshot was in flight, including new jobs.
      this._jobs.set(
        jobs
          .map(job => {
            const update = pendingStats.get(statsKey(job.backend_name, job.jobid, job.execute_id));
            return update && isNewerJobStats(job, update)
              ? {
                  ...job,
                  stats: listedStats(job, update.stats),
                  stats_revision: update.statsRevision,
                }
              : { ...job, stats: normalizeJobStats(job.stats) };
          })
          .sort(compareJobsNewestFirst)
      );
    } finally {
      this.statsDuringRefresh = undefined;
    }
  }

  async startProfileBatch(
    transferType: BatchApiLabel,
    params: {
      remoteName: string;
      profileName: string;
      source?: Origin;
      noCache?: boolean;
      backendName?: string;
    }
  ): Promise<number> {
    const lowercaseType = transferType.toLowerCase();
    return this.invokeWithNotification<number>(
      'start_profile_batch',
      { transferType: lowercaseType, params },
      {
        successKey: 'operations.successStart',
        successParams: {
          type: transferType,
          remote: params.remoteName,
          profile: params.profileName,
        },
        errorKey: 'operations.failedStart',
        errorParams: {
          type: transferType,
          remote: params.remoteName,
        },
      }
    );
  }

  async stopJob(jobid: number): Promise<void> {
    await this.invokeWithNotification(
      'stop_job',
      { jobid },
      {
        successKey: 'backendSuccess.job.stopped',
        successParams: { id: jobid.toString() },
        errorKey: 'backendErrors.job.executionFailed',
        errorParams: { id: jobid.toString() },
      }
    );
  }

  /** The file reports a finished sync, copy or move kept; `null` when it kept none. */
  async getJobReport(jobid: number): Promise<JobReport | null> {
    return this.invokeCommand<JobReport | null>('get_job_report', { jobid });
  }

  async deleteJob(jobid: number): Promise<void> {
    await this.invokeWithNotification(
      'delete_job',
      { jobid },
      {
        successKey: 'backendSuccess.job.deleted',
        successParams: { id: jobid.toString() },
        errorKey: 'backendErrors.job.executionFailed',
        errorParams: { id: jobid.toString() },
      }
    );
  }

  /** Runs a failed or stopped job again as a new job (only its failed parts, for a batch). */
  async retryJob(jobid: number): Promise<number> {
    return this.invokeWithNotification<number>(
      'retry_job',
      { jobid },
      { successKey: 'backendSuccess.job.retried', successParams: { id: jobid.toString() } }
    );
  }

  /** Removes finished jobs from the list at once, without a notification for each. */
  async clearJobs(jobids: readonly number[]): Promise<void> {
    await Promise.all(jobids.map(jobid => this.invokeCommand('delete_job', { jobid })));
  }

  async resetGroupStats(group?: string): Promise<void> {
    await this.invokeCommand('reset_group_stats', { group });
  }

  async stopJobsByGroup(group: string): Promise<void> {
    await this.invokeCommand('stop_jobs_by_group', { group });
  }

  async stopAllActiveJobs(): Promise<void> {
    await this.invokeCommand('stop_all_active_jobs');
  }
}

/**
 * Compares two remote-to-job dictionary groups for downstream signal equality.
 * Ignores high-frequency telemetry stat changes (speed, bytes transferred, eta)
 * so that consumers such as RemoteCard are not invalidated every second while
 * job status, identity, and profile stay identical.
 */
export function areJobGroupsEqual(
  prev: Record<string, JobInfo[]>,
  next: Record<string, JobInfo[]>
): boolean {
  if (prev === next) return true;
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  if (prevKeys.length !== nextKeys.length) return false;

  for (const key of prevKeys) {
    const nextList = next[key];
    if (!nextList || !areJobListsEqual(prev[key], nextList)) return false;
  }
  return true;
}

/** Equality for job ownership and lifecycle; intentionally excludes telemetry. */
export function areJobListsEqual(prev: JobInfo[], next: JobInfo[]): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const p = prev[i];
    const n = next[i];
    if (
      p.jobid !== n.jobid ||
      p.status !== n.status ||
      p.job_type !== n.job_type ||
      !sameStarter(p.starter, n.starter) ||
      p.parent_job_id !== n.parent_job_id ||
      p.origin !== n.origin ||
      p.execute_id !== n.execute_id ||
      p.backend_name !== n.backend_name ||
      p.start_time !== n.start_time ||
      p.error !== n.error
    ) {
      return false;
    }
  }
  return true;
}

/** Stats as the list keeps them: a finished job without its file rows, as the backend sends it. */
function listedStats(job: JobInfo, stats: Partial<GlobalStats>): GlobalStats {
  if (job.status === JOB_STATUS.Running) return normalizeJobStats(stats);
  const { completed: _rows, checkOutput: _report, ...rest } = stats;
  return normalizeJobStats(rest);
}

function statsKey(
  backendName: string | undefined,
  jobId: number,
  executeId?: string | null
): string {
  return JSON.stringify([backendName, jobId, executeId ?? null]);
}
