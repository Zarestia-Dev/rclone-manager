import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { TauriBaseService } from '../core/tauri-base.service';
import { JobInfo } from '@app/types';

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
  }

  // ============================================================================
  // PROFILE-BASED METHODS
  // These methods only require remote and profile names - the backend resolves
  // all options (sync, filter, backend, vfs) from cached settings.
  // ============================================================================

  /**
   * Start a sync job using a named profile
   * Backend resolves all options from cached settings
   */
  async startSyncProfile(remoteName: string, profileName: string): Promise<number> {
    const params = { remote_name: remoteName, profile_name: profileName };
    console.debug('Invoking start_sync_profile with params', params);
    return this.invokeCommand<number>('start_sync_profile', { params });
  }

  /**
   * Start a copy job using a named profile
   */
  async startCopyProfile(remoteName: string, profileName: string): Promise<number> {
    const params = { remote_name: remoteName, profile_name: profileName };
    console.debug('Invoking start_copy_profile with params', params);
    return this.invokeCommand<number>('start_copy_profile', { params });
  }

  /**
   * Start a bisync job using a named profile
   */
  async startBisyncProfile(remoteName: string, profileName: string): Promise<number> {
    const params = { remote_name: remoteName, profile_name: profileName };
    console.debug('Invoking start_bisync_profile with params', params);
    return this.invokeCommand<number>('start_bisync_profile', { params });
  }

  /**
   * Start a move job using a named profile
   */
  async startMoveProfile(remoteName: string, profileName: string): Promise<number> {
    const params = { remote_name: remoteName, profile_name: profileName };
    console.debug('Invoking start_move_profile with params', params);
    return this.invokeCommand<number>('start_move_profile', { params });
  }

  /**
   * Copy a file from a URL to the remote
   * @param remote The remote to copy to
   * @param path The path on the remote to copy to
   * @param url The URL to copy from
   * @param autoFilename Whether to automatically determine the filename
   */
  async copyUrl(remote: string, path: string, url: string, autoFilename: boolean): Promise<void> {
    return this.invokeCommand('copy_url', { remote, path, urlToCopy: url, autoFilename });
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
    console.log('Active jobs updated:', jobs);

    return jobs;
  }

  /**
   * Get job status
   */
  async getJobStatus(jobid: number): Promise<JobInfo | null> {
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
   * Get active jobs for a specific remote from the current state
   */
  getActiveJobsForRemote(remoteName: string, profile?: string): JobInfo[] {
    const activeJobs = this.activeJobsSubject.value;
    return activeJobs.filter(job => {
      const matchRemote = job.remote_name === remoteName;
      if (profile) {
        return matchRemote && job.profile === profile;
      }
      return matchRemote;
    });
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

  /**
   * Rename a profile in all cached running jobs
   * Returns the number of jobs updated
   */
  async renameProfileInCache(
    remoteName: string,
    oldName: string,
    newName: string
  ): Promise<number> {
    return this.invokeCommand<number>('rename_profile_in_cache', {
      remoteName,
      oldName,
      newName,
    });
  }
}
