import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { TauriBaseService } from '../core/tauri-base.service';
import {
  BisyncOptions,
  BisyncParams,
  CopyOptions,
  CopyParams,
  FilterOptions,
  JobInfo,
  MoveOptions,
  MoveParams,
  SyncOptions,
  SyncParams,
} from '@app/types';

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
    createEmptySrcDirs?: boolean,
    syncOptions?: SyncOptions,
    filterOptions?: FilterOptions
  ): Promise<number> {
    this.validatePaths(source, dest);

    const params: SyncParams = {
      remote_name: remoteName,
      source,
      dest,
      create_empty_src_dirs: createEmptySrcDirs || false,
      sync_options: syncOptions || {},
      filter_options: filterOptions || {},
    };

    const jobId = await this.invokeCommand<string>('start_sync', { params });

    return parseInt(jobId, 10);
  }

  /**
   * Start a copy job
   */
  async startCopy(
    remoteName: string,
    source: string,
    dest: string,
    createEmptySrcDirs?: boolean,
    copyOptions?: CopyOptions,
    filterOptions?: FilterOptions
  ): Promise<number> {
    this.validatePaths(source, dest);

    const params: CopyParams = {
      remote_name: remoteName,
      source,
      dest,
      create_empty_src_dirs: createEmptySrcDirs || false,
      copy_options: copyOptions || {},
      filter_options: filterOptions || {},
    };

    const jobId = await this.invokeCommand<string>('start_copy', { params });

    return parseInt(jobId, 10);
  }

  async startBisync(
    remoteName: string,
    source: string,
    dest: string,
    bisyncOptions?: BisyncOptions,
    filterOptions?: FilterOptions,
    dryRun?: boolean,
    resync?: boolean,
    checkAccess?: boolean,
    checkFilename?: string,
    maxDelete?: number,
    force?: boolean,
    checkSync?: boolean | 'only',
    createEmptySrcDirs?: boolean,
    removeEmptyDirs?: boolean,
    filtersFile?: string,
    ignoreListingChecksum?: boolean,
    resilient?: boolean,
    workdir?: string,
    backupdir1?: string,
    backupdir2?: string,
    noCleanup?: boolean
  ): Promise<number> {
    this.validatePaths(source, dest);

    const params: BisyncParams = {
      remote_name: remoteName,
      source,
      dest,
      bisync_options: bisyncOptions || null,
      filter_options: filterOptions || null,
      resync: resync || false,
      dryRun: dryRun || false,
      checkAccess: checkAccess || false,
      checkFilename: checkFilename || '',
      maxDelete: maxDelete || 0,
      force: force || false,
      checkSync: checkSync || false,
      createEmptySrcDirs: createEmptySrcDirs || false,
      removeEmptyDirs: removeEmptyDirs || false,
      filtersFile: filtersFile || '',
      ignoreListingChecksum: ignoreListingChecksum || false,
      resilient: resilient || false,
      workdir: workdir || '',
      backupdir1: backupdir1 || '',
      backupdir2: backupdir2 || '',
      noCleanup: noCleanup || false,
    };

    const jobId = await this.invokeCommand<string>('start_bisync', {
      params,
    });

    return parseInt(jobId, 10);
  }

  async startMove(
    remoteName: string,
    source: string,
    dest: string,
    createEmptySrcDirs?: boolean,
    deleteEmptySrcDirs?: boolean,
    moveOptions?: MoveOptions,
    filterOptions?: FilterOptions
  ): Promise<number> {
    this.validatePaths(source, dest);
    const params: MoveParams = {
      remote_name: remoteName,
      source,
      dest,
      create_empty_src_dirs: createEmptySrcDirs || false,
      delete_empty_src_dirs: deleteEmptySrcDirs || false,
      move_options: moveOptions || {},
      filter_options: filterOptions || {},
    };
    const jobId = await this.invokeCommand<string>('start_move', { params });
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
