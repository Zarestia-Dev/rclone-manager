import { Injectable } from '@angular/core';
import { BehaviorSubject, map } from 'rxjs';
import { TauriBaseService } from '../core/tauri-base.service';
import { JobInfo, JOB_CACHE_CHANGED } from '@app/types';

/**
 * Service for managing rclone jobs (sync, copy, etc.)
 * Handles job creation, monitoring, and lifecycle management
 *
 * Single source of truth architecture:
 * - jobsSubject holds ALL jobs
 * - activeJobs$ is derived from jobs$ (filtered by Running status)
 * - All other job queries filter from the same source
 * - Self-refreshes on JOB_CACHE_CHANGED events from backend
 */
@Injectable({
  providedIn: 'root',
})
export class JobManagementService extends TauriBaseService {
  // ============================================================================
  // UNIFIED JOB STATE - Single Source of Truth
  // ============================================================================

  /** All jobs (running, completed, failed, stopped) */
  private jobsSubject = new BehaviorSubject<JobInfo[]>([]);
  public jobs$ = this.jobsSubject.asObservable();

  /** Active (running) jobs - derived from jobs$ */
  public activeJobs$ = this.jobs$.pipe(map(jobs => jobs.filter(job => job.status === 'Running')));

  // Nautilus-specific jobs stream (kept for nautilus file browser)
  private nautilusJobsSubject = new BehaviorSubject<JobInfo[]>([]);
  public nautilusJobs$ = this.nautilusJobsSubject.asObservable();

  constructor() {
    super();
    this.initializeEventListeners();
  }

  /**
   * Initialize event listeners for job cache changes
   * Service auto-refreshes when backend emits job state changes
   */
  private initializeEventListeners(): void {
    this.listenToEvent<unknown>(JOB_CACHE_CHANGED).subscribe(() => {
      this.refreshJobs().catch(err =>
        console.error('Failed to refresh jobs on cache change:', err)
      );
    });
  }

  // ============================================================================
  // JOB STATE ACCESSORS
  // ============================================================================

  /** Get current jobs snapshot (synchronous) */
  getJobsSnapshot(): JobInfo[] {
    return this.jobsSubject.value;
  }

  /** Get active jobs snapshot (synchronous) */
  getActiveJobsSnapshot(): JobInfo[] {
    return this.jobsSubject.value.filter(job => job.status === 'Running');
  }

  /**
   * Get active jobs for a specific remote (synchronous)
   * Filters from the unified jobs source
   */
  getActiveJobsForRemote(remoteName: string, profile?: string): JobInfo[] {
    const activeJobs = this.getActiveJobsSnapshot();
    return activeJobs.filter(job => {
      const matchRemote = job.remote_name === remoteName;
      if (profile) {
        return matchRemote && job.profile === profile;
      }
      return matchRemote;
    });
  }

  /**
   * Get jobs filtered by a specific remote (all statuses)
   */
  getJobsForRemote(remoteName: string): JobInfo[] {
    return this.jobsSubject.value.filter(job => job.remote_name === remoteName);
  }

  // ============================================================================
  // JOB STATE MANAGEMENT
  // ============================================================================

  /**
   * Refresh all jobs from backend and update the unified state
   * This is the primary method for syncing frontend state with backend
   */
  async refreshJobs(): Promise<JobInfo[]> {
    const jobs = await this.invokeCommand<JobInfo[]>('get_jobs');
    this.jobsSubject.next(jobs);
    console.debug(
      '[JobManagementService] Jobs refreshed:',
      jobs.map(j => ({
        jobid: j.jobid,
        remote_name: j.remote_name,
        status: j.status,
        profile: j.profile,
      }))
    );
    return jobs;
  }

  /**
   * Get all jobs (fetches from backend and updates state)
   * @deprecated Use refreshJobs() instead for clarity
   */
  async getJobs(): Promise<JobInfo[]> {
    return this.refreshJobs();
  }

  /**
   * Get active jobs (returns from cached state after refresh)
   * Updates the unified state and returns active jobs
   */
  async getActiveJobs(): Promise<JobInfo[]> {
    await this.refreshJobs();
    const activeJobs = this.getActiveJobsSnapshot();
    console.debug('[JobManagementService] Active jobs:', activeJobs.length);
    return activeJobs;
  }

  // ============================================================================
  // PROFILE-BASED JOB OPERATIONS
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
   */
  async copyUrl(remote: string, path: string, url: string, autoFilename: boolean): Promise<void> {
    await this.invokeCommand('copy_url', { remote, path, urlToCopy: url, autoFilename });
    this.refreshNautilusJobs();
  }

  // ============================================================================
  // JOB LIFECYCLE OPERATIONS
  // ============================================================================

  /**
   * Stop a job
   */
  async stopJob(jobid: number, remoteName: string): Promise<void> {
    await this.invokeCommand('stop_job', { jobid, remoteName });
  }

  /**
   * Delete a job from the cache
   */
  async deleteJob(jobid: number): Promise<void> {
    await this.invokeCommand('delete_job', { jobid });
  }

  /**
   * Get job status
   */
  async getJobStatus(jobid: number): Promise<JobInfo | null> {
    return this.invokeCommand('get_job_status', { jobid });
  }

  // ============================================================================
  // SPECIALIZED JOB QUERIES
  // ============================================================================

  /**
   * Get jobs filtered by source UI
   * @param source The source UI identifier (e.g., 'nautilus', 'dashboard', 'scheduled')
   */
  async getJobsBySource(source: string): Promise<JobInfo[]> {
    return this.invokeCommand<JobInfo[]>('get_jobs_by_source', { source });
  }

  /**
   * Refresh the nautilus jobs stream
   */
  async refreshNautilusJobs(): Promise<void> {
    try {
      const jobs = await this.getJobsBySource('nautilus');
      this.nautilusJobsSubject.next(jobs);
    } catch (err) {
      console.error('Failed to refresh nautilus jobs:', err);
    }
  }

  /**
   * Get the current nautilus jobs synchronously from the stream
   */
  getNautilusJobs(): JobInfo[] {
    return this.nautilusJobsSubject.value;
  }

  /**
   * Get completed transfers for a job/remote (using core/transferred API)
   */
  async getCompletedTransfers(group?: string): Promise<unknown[]> {
    const params: Record<string, string> = {};
    if (group) {
      params['group'] = group;
    }
    return this.invokeCommand('get_completed_transfers', params);
  }

  /**
   * Get remote-specific core stats (filtered by group)
   */
  async getCoreStatsForRemote(remoteName: string, jobid?: number): Promise<unknown | null> {
    const params: Record<string, unknown> = { remote_name: remoteName };
    if (jobid) {
      params['jobid'] = jobid;
      params['group'] = `job/${jobid}`;
    }
    return this.invokeCommand('get_core_stats_filtered', params);
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
