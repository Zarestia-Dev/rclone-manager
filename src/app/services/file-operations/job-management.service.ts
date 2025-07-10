import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { TauriBaseService } from '../core/tauri-base.service';
import { JobInfo } from '../../shared/components/types';

export type SyncOptions = Record<string, any>;

export type CopyOptions = Record<string, any>;

export type FilterOptions = Record<string, any>;

/**
 * Service for managing rclone jobs (sync, copy, etc.)
 * Handles job creation, monitoring, and lifecycle management
 */
@Injectable({
  providedIn: 'root',
})
export class JobManagementService extends TauriBaseService {
  private activeJobsSubject = new BehaviorSubject<JobInfo[]>([]);
  public activeJobs$ = this.activeJobsSubject.asObservable();

  constructor() {
    super();
    this.setupJobListeners();
  }

  /**
   * Start a sync job
   */
  async startSync(
    remoteName: string,
    source: string,
    dest: string,
    syncOptions?: SyncOptions,
    filterOptions?: FilterOptions
  ): Promise<number> {
    this.validatePaths(source, dest);

    const jobId = await this.invokeCommand<string>('start_sync', {
      remoteName,
      source,
      dest,
      syncOptions: syncOptions || {},
      filterOptions: filterOptions || {},
    });

    return parseInt(jobId, 10);
  }

  /**
   * Start a copy job
   */
  async startCopy(
    remoteName: string,
    source: string,
    dest: string,
    copyOptions?: CopyOptions,
    filterOptions?: FilterOptions
  ): Promise<number> {
    this.validatePaths(source, dest);

    const jobId = await this.invokeCommand<string>('start_copy', {
      remoteName,
      source,
      dest,
      copyOptions: copyOptions || {},
      filterOptions: filterOptions || {},
    });

    return parseInt(jobId, 10);
  }

  /**
   * Get all jobs
   */
  async getJobs(): Promise<JobInfo[]> {
    return this.invokeCommand<JobInfo[]>('get_jobs');
  }

  /**
   * Get active jobs
   */
  async getActiveJobs(): Promise<JobInfo[]> {
    const jobs = await this.invokeCommand<JobInfo[]>('get_active_jobs');
    this.activeJobsSubject.next(jobs);
    return jobs;
  }

  /**
   * Get job status
   */
  async getJobStatus(jobid: number): Promise<any | null> {
    return this.invokeCommand('get_job_status', { jobid });
  }

  /**
   * Stop a job
   */
  async stopJob(jobid: number, remoteName: string): Promise<void> {
    return this.invokeCommand('stop_job', { jobid, remoteName });
  }

  /**
   * Delete a job
   */
  async deleteJob(jobid: number): Promise<void> {
    return this.invokeCommand('delete_job', { jobid });
  }

  /**
   * Get jobs for a specific remote
   */
  async getJobsForRemote(remoteName: string): Promise<JobInfo[]> {
    const allJobs = await this.getJobs();
    return allJobs.filter(job => job.remote_name === remoteName);
  }

  /**
   * Get active jobs for a specific remote
   */
  async getActiveJobsForRemote(remoteName: string): Promise<JobInfo[]> {
    const activeJobs = await this.getActiveJobs();
    return activeJobs.filter(job => job.remote_name === remoteName);
  }

  /**
   * Get job stats with group filtering (for remote-specific stats)
   */
  async getJobStatsWithGroup(jobid: number, group?: string): Promise<any | null> {
    const params: any = { jobid };
    if (group) {
      params.group = group;
    }
    return this.invokeCommand('get_job_stats', params);
  }

  /**
   * Get completed transfers for a job/remote (using core/transferred API)
   */
  async getCompletedTransfers(group?: string): Promise<any[]> {
    const params: any = {};
    if (group) {
      params.group = group;
    }
    return this.invokeCommand('get_completed_transfers', params);
  }

  /**
   * Get remote-specific core stats (filtered by group)
   */
  async getCoreStatsForRemote(remoteName: string, jobid?: number): Promise<any | null> {
    const params: any = { remote_name: remoteName };
    if (jobid) {
      params.jobid = jobid;
      params.group = `job/${jobid}`;
    }
    return this.invokeCommand('get_core_stats_filtered', params);
  }

  /**
   * Setup job event listeners
   */
  private setupJobListeners(): void {
    // Listen for job updates
    this.listenToEvent<any>('ui_job_update').subscribe(payload => {
      const jobs = this.activeJobsSubject.value;
      const jobIndex = jobs.findIndex(j => j.jobid === payload.jobid);

      if (jobIndex >= 0) {
        jobs[jobIndex].stats = payload.stats;
        this.activeJobsSubject.next([...jobs]);
      }
    });

    // Listen for job completion
    this.listenToEvent<any>('ui_job_completed').subscribe(payload => {
      const jobs = this.activeJobsSubject.value;
      const jobIndex = jobs.findIndex(j => j.jobid === payload.jobid);

      if (jobIndex >= 0) {
        jobs[jobIndex].status = payload.success ? 'Completed' : 'Failed';
        this.activeJobsSubject.next([...jobs]);
      }
    });
  }

  /**
   * Validate source and destination paths
   */
  private validatePaths(source: string, dest: string): void {
    if (!source) {
      throw new Error('Source is required');
    }
    if (!dest) {
      throw new Error('Destination is required');
    }
  }
}
