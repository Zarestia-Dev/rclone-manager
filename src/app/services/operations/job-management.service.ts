import { DestroyRef, inject, Injectable, signal, computed } from '@angular/core';
import { interval, merge } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { JobInfo, Origin } from '@app/types';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { groupBy } from '../remote/utils/remote-config.utils';

@Injectable({
  providedIn: 'root',
})
export class JobManagementService extends TauriBaseService {
  private readonly _jobs = signal<JobInfo[]>([]);
  public readonly jobs = this._jobs.asReadonly();

  public readonly activeJobs = computed(() => this._jobs().filter(job => job.status === 'Running'));

  public readonly nautilusJobs = computed(() =>
    this._jobs().filter(job => job.origin === 'filemanager')
  );

  public readonly jobsByRemote = computed(() => groupBy(this._jobs(), j => j.remote_name));

  private readonly destroyRef = inject(DestroyRef);
  private readonly eventListeners = inject(EventListenersService);

  constructor() {
    super();
    this.initializeEventListeners();
    this.initializePolling();
    this.refreshJobs().catch(() => {
      /* empty */
    });
  }

  private initializePolling(): void {
    interval(1000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.activeJobs().length === 0) return;

        this.refreshJobs().catch(() => {
          /* empty */
        });
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

  getActiveJobsForRemote(remoteName: string, profile?: string): JobInfo[] {
    return this.activeJobs().filter(job => {
      if (job.parent_job_id) return false;
      const matchRemote = job.remote_name === remoteName;
      return profile ? matchRemote && job.profile === profile : matchRemote;
    });
  }

  getLatestJobForRemote(
    remoteName: string,
    profile?: string,
    operationType?: string
  ): JobInfo | null {
    let jobs = this._jobs().filter(job => job.remote_name === remoteName && !job.parent_job_id);

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

  async startProfileBatch(
    transferType:
      | 'Sync'
      | 'Copy'
      | 'Move'
      | 'Bisync'
      | 'Check'
      | 'Delete'
      | 'Copyurl'
      | 'Archivecreate'
      | 'Cryptcheck',
    params: {
      remoteName: string;
      profileName: string;
      source?: Origin;
      noCache?: boolean;
    }
  ): Promise<number> {
    const lowercaseType = transferType.toLowerCase() as unknown;
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
}
