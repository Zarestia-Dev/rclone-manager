import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { TauriBaseService } from '../core/tauri-base.service';
import {
  BackendOptions,
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
    filterOptions?: FilterOptions,
    backendOptions?: BackendOptions,
    profile?: string
  ): Promise<number> {
    this.validatePaths(source, dest);

    const params: SyncParams = {
      remote_name: remoteName,
      source,
      dest,
      create_empty_src_dirs: createEmptySrcDirs || false,
      sync_options: syncOptions || {},
      filter_options: filterOptions || {},
      backend_options: backendOptions || {},
      profile,
    };

    console.debug('Invoking start_sync with params', params);
    const jobId = await this.invokeCommand<number>('start_sync', { params });

    return jobId;
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
    filterOptions?: FilterOptions,
    backendOptions?: BackendOptions,
    profile?: string
  ): Promise<number> {
    this.validatePaths(source, dest);

    const params: CopyParams = {
      remote_name: remoteName,
      source,
      dest,
      create_empty_src_dirs: createEmptySrcDirs || false,
      copy_options: copyOptions || {},
      filter_options: filterOptions || {},
      backend_options: backendOptions || {},
      profile,
    };

    console.debug('Invoking start_copy with params', params);
    const jobId = await this.invokeCommand<number>('start_copy', { params });

    return jobId;
  }

  async startBisync(
    remoteName: string,
    source: string,
    dest: string,
    bisyncOptions?: BisyncOptions,
    filterOptions?: FilterOptions,
    backendOptions?: BackendOptions,
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
    noCleanup?: boolean,
    profile?: string
  ): Promise<number> {
    this.validatePaths(source, dest);

    const params: BisyncParams = {
      remote_name: remoteName,
      source,
      dest,
      bisync_options: bisyncOptions || null,
      filter_options: filterOptions || null,
      backend_options: backendOptions || {},
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
      profile,
    };

    console.debug('Invoking start_bisync with params', params);
    return await this.invokeCommand<number>('start_bisync', { params });
  }

  async startMove(
    remoteName: string,
    source: string,
    dest: string,
    createEmptySrcDirs?: boolean,
    deleteEmptySrcDirs?: boolean,
    moveOptions?: MoveOptions,
    filterOptions?: FilterOptions,
    backendOptions?: BackendOptions,
    profile?: string
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
      backend_options: backendOptions || {},
      profile,
    };
    console.debug('Invoking start_move with params', params);
    return await this.invokeCommand<number>('start_move', { params });
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
}
