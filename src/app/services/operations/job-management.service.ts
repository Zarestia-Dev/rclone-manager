import { DestroyRef, inject, Injectable, signal, computed } from '@angular/core';
import { interval, merge } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { JobInfo, Origin, ORIGINS, GlobalStats, CompletedTransfer } from '@app/types';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { groupBy } from '../remote/utils/remote-config.utils';

export interface RawTransfer {
  name?: string;
  size?: number;
  bytes?: number;
  checked?: boolean;
  error?: string;
  group?: string;
  started_at?: string;
  completed_at?: string;
  src_fs?: string;
  dst_fs?: string;
}

export function mapRawTransfer(t: RawTransfer): CompletedTransfer {
  let status: CompletedTransfer['status'] = 'completed';
  if (t.error) status = 'failed';
  else if (t.checked) status = 'checked';
  else if (t.bytes != null && t.size != null && t.bytes > 0 && t.bytes < t.size) status = 'partial';

  return {
    name: t.name ?? '',
    size: t.size ?? 0,
    bytes: t.bytes ?? 0,
    checked: t.checked ?? false,
    error: t.error ?? '',
    jobid: 0,
    startedAt: t.started_at,
    completedAt: t.completed_at,
    srcFs: t.src_fs,
    dstFs: t.dst_fs,
    group: t.group,
    status,
  };
}

@Injectable({
  providedIn: 'root',
})
export class JobManagementService extends TauriBaseService {
  private readonly _jobs = signal<JobInfo[]>([]);
  public readonly jobs = this._jobs.asReadonly();

  public readonly activeJobs = computed(() => this._jobs().filter(job => job.status === 'Running'));

  public readonly nautilusJobs = computed(() =>
    this._jobs().filter(job => job.origin === ORIGINS.FILEMANAGER)
  );

  public readonly jobsByRemote = computed(() => groupBy(this._jobs(), j => j.remote_name));

  private readonly destroyRef = inject(DestroyRef);
  private readonly eventListeners = inject(EventListenersService);

  private readonly _watchedGroups = signal<Set<string>>(new Set());
  public readonly watchedGroups = this._watchedGroups.asReadonly();

  private readonly _groupStatsMap = signal<Map<string, GlobalStats>>(new Map());
  public readonly groupStatsMap = this._groupStatsMap.asReadonly();

  private readonly _groupTransfersMap = signal<Map<string, CompletedTransfer[]>>(new Map());
  public readonly groupTransfersMap = this._groupTransfersMap.asReadonly();

  constructor() {
    super();
    this.initializeEventListeners();
    this.initializePolling();
  }

  private initializePolling(): void {
    interval(1000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        const watched = this._watchedGroups();
        if (this.activeJobs().length === 0 && watched.size === 0) return;

        this.refreshJobs().catch(() => {
          /* empty */
        });

        for (const groupName of watched) {
          this.refreshGroupData(groupName).catch(() => {
            /* empty */
          });
        }
      });
  }

  private async refreshGroupData(groupName: string): Promise<void> {
    const [stats, rawResponse] = await Promise.all([
      this.invokeCommand<GlobalStats>('get_stats', { group: groupName }),
      this.invokeCommand<{ transferred?: RawTransfer[] } | RawTransfer[]>(
        'get_completed_transfers',
        { group: groupName }
      ),
    ]);

    if (stats) {
      this._groupStatsMap.update(map => new Map(map).set(groupName, stats));
    }

    // Rclone returns either `{ transferred: [...] }` or a bare array
    const rawArray =
      (rawResponse as { transferred?: RawTransfer[] })?.transferred ??
      (Array.isArray(rawResponse) ? rawResponse : []);

    this._groupTransfersMap.update(map => {
      const currentTransfers = map.get(groupName) ?? [];
      const newTransfers = rawArray.map(mapRawTransfer);

      // Deduplicate by file name to avoid adding the same transfer multiple times
      const existingNames = new Set(currentTransfers.map(t => t.name));
      const deduplicatedNew = newTransfers.filter(t => !existingNames.has(t.name));

      if (deduplicatedNew.length === 0) return map;

      // Keep only last 1000 transfers
      const updated = [...currentTransfers, ...deduplicatedNew].slice(-1000);
      return new Map(map).set(groupName, updated);
    });
  }

  public watchGroup(name: string): void {
    this._watchedGroups.update(set => new Set(set).add(name));
    void this.refreshGroupData(name);
  }

  public unwatchGroup(name: string): void {
    this._watchedGroups.update(set => {
      if (!set.has(name)) return set;
      const next = new Set(set);
      next.delete(name);
      return next;
    });
    this.clearGroupData(name);
  }

  public clearGroupData(name: string): void {
    this._groupStatsMap.update(map => {
      if (!map.has(name)) return map;
      const next = new Map(map);
      next.delete(name);
      return next;
    });
    this._groupTransfersMap.update(map => {
      if (!map.has(name)) return map;
      const next = new Map(map);
      next.delete(name);
      return next;
    });
  }

  private initializeEventListeners(): void {
    merge(
      this.eventListeners.listenToJobCacheChanged(),
      this.eventListeners.listenToRcloneEngineReady()
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.refreshJobs().catch(err =>
          console.error('[JobManagementService] Failed to refresh jobs:', err)
        );
      });
  }

  getJobsSnapshot(): JobInfo[] {
    return this._jobs();
  }

  getActiveJobsSnapshot(): JobInfo[] {
    return this.activeJobs();
  }

  getActiveJobsForRemote(remoteName: string, profile?: string): JobInfo[] {
    return this.activeJobs().filter(job => {
      const matchRemote = job.remote_name === remoteName;
      return profile ? matchRemote && job.profile === profile : matchRemote;
    });
  }

  getJobsForRemote(remoteName: string): JobInfo[] {
    return this._jobs().filter(job => job.remote_name === remoteName);
  }

  getLatestJobForRemote(
    remoteName: string,
    profile?: string,
    operationType?: string
  ): JobInfo | null {
    let jobs = this._jobs().filter(job => job.remote_name === remoteName);

    if (operationType) jobs = jobs.filter(j => j.job_type === operationType);
    if (profile) jobs = jobs.filter(j => j.profile === profile);
    if (jobs.length === 0) return null;

    return jobs.sort((a, b) => {
      const ta = a.start_time ? new Date(a.start_time).getTime() : 0;
      const tb = b.start_time ? new Date(b.start_time).getTime() : 0;
      return tb !== ta ? tb - ta : b.jobid - a.jobid;
    })[0];
  }

  async refreshJobs(): Promise<JobInfo[]> {
    const jobs = await this.invokeCommand<JobInfo[]>('get_jobs');
    this._jobs.set(jobs);
    console.log(jobs);

    return jobs;
  }

  async getActiveJobs(): Promise<JobInfo[]> {
    await this.refreshJobs();
    return this.getActiveJobsSnapshot();
  }

  async startProfileBatch(
    transferType: 'Sync' | 'Copy' | 'Move' | 'Bisync',
    params: {
      remoteName: string;
      profileName: string;
      source?: Origin;
      noCache?: boolean;
    }
  ): Promise<number> {
    return this.invokeWithNotification<number>(
      'start_profile_batch',
      { transferType, params },
      {
        successKey: 'notification.title.operationStarted',
        successParams: {
          operation: transferType,
          remote: params.remoteName,
          profile: params.profileName,
        },
        errorKey: 'notification.title.operationFailed',
        errorParams: {
          operation: transferType,
          remote: params.remoteName,
          profile: params.profileName,
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

  async getJobStatus(jobid: number): Promise<JobInfo | null> {
    return this.invokeCommand('get_job_status', { jobid });
  }

  async getStatsGroups(): Promise<string[]> {
    return this.invokeCommand<string[]>('get_stats_groups');
  }

  async resetGroupStats(group?: string): Promise<void> {
    await this.invokeCommand('reset_group_stats', { group });
  }

  async deleteStatsGroup(group: string): Promise<void> {
    await this.invokeCommand('delete_stats_group', { group });
  }

  async stopJobsByGroup(group: string): Promise<void> {
    await this.invokeCommand('stop_jobs_by_group', { group });
  }
}
