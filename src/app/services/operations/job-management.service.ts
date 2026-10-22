import { DestroyRef, inject, Injectable, signal, computed } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import {
  BatchApiLabel,
  JobInfo,
  JobActionType,
  JobStatsUpdatedEvent,
  JOB_STATUS,
  Origin,
  isProfileScoped,
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
      .subscribe(() => refresh());
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

  private updateJobStats(event: JobStatsUpdatedEvent): void {
    const { backendName, jobId } = event;
    if (this.selectedBackend && backendName !== this.selectedBackend) return;
    if (this.statsDuringRefresh) {
      const key = statsKey(backendName, jobId, event.executeId);
      const pending = this.statsDuringRefresh.get(key);
      if (
        !pending ||
        event.statsRevision === undefined ||
        event.statsRevision > (pending.statsRevision ?? -1)
      ) {
        this.statsDuringRefresh.set(key, event);
      }
    }
    this._jobs.update(jobs => {
      const idx = jobs.findIndex(j => j.backend_name === backendName && j.jobid === jobId);
      if (idx === -1 || !isNewerJobStats(jobs[idx], event)) return jobs;
      const updated = [...jobs];
      updated[idx] = {
        ...updated[idx],
        stats: normalizeJobStats(event.stats),
        stats_revision: event.statsRevision,
      };
      return updated;
    });
  }

  getActiveJobsForRemote(remoteName: string, profile?: string): JobInfo[] {
    return this.activeJobs().filter(job => {
      if (job.parent_job_id != null) return false;
      const matchRemote = job.remote_name === remoteName;
      return profile ? matchRemote && job.profile === profile : matchRemote;
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
        (!profile || job.profile === profile),
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

  getActiveJobForWorkflowNode(workflowId: string, nodeId: string): JobInfo | null {
    return findLatestJob(
      this.activeJobs(),
      job => job.parent_job_id == null && job.workflow_id === workflowId && job.node_id === nodeId
    );
  }

  getLatestJobForWorkflowNode(
    workflowId: string,
    nodeId: string,
    quickRunId?: string
  ): JobInfo | null {
    const direct = findLatestJob(
      this._jobs(),
      job => job.parent_job_id == null && job.workflow_id === workflowId && job.node_id === nodeId,
      true
    );
    if (direct || !quickRunId) return direct;
    return findLatestJob(
      this._jobs(),
      job => job.parent_job_id == null && !job.workflow_id && job.quick_run_id === quickRunId,
      true
    );
  }

  getLatestJobForQuickRun(quickRunId: string): JobInfo | null {
    return findLatestJob(
      this._jobs(),
      job => job.parent_job_id == null && job.quick_run_id === quickRunId,
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
            const update =
              pendingStats.get(statsKey(job.backend_name, job.jobid, job.execute_id)) ??
              pendingStats.get(statsKey(job.backend_name, job.jobid));
            const applyUpdate =
              update &&
              isNewerJobStats(job, update) &&
              (update.statsRevision !== undefined || job.status === JOB_STATUS.Running);
            return {
              ...job,
              stats: normalizeJobStats(applyUpdate ? update.stats : job.stats),
              stats_revision: applyUpdate ? update.statsRevision : job.stats_revision,
            };
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

  async stopJob(jobid: number, remoteName: string): Promise<void> {
    await this.invokeWithNotification(
      'stop_job',
      { jobid, remoteName },
      {
        successKey: 'backendSuccess.job.stopped',
        successParams: { id: jobid.toString() },
        errorKey: 'backendErrors.job.executionFailed',
        errorParams: { id: jobid.toString() },
      }
    );
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
      p.profile !== n.profile ||
      p.parent_job_id !== n.parent_job_id ||
      p.origin !== n.origin ||
      p.quick_run_id !== n.quick_run_id ||
      p.workflow_id !== n.workflow_id ||
      p.node_id !== n.node_id ||
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

function statsKey(
  backendName: string | undefined,
  jobId: number,
  executeId?: string | null
): string {
  return JSON.stringify([backendName, jobId, executeId ?? null]);
}
