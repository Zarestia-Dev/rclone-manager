import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { Entry, FsInfo, JobActionType, Origin } from '@app/types';

/**
 * Service for remote file system operations
 * Handles browsing, metadata, and active file operations (copy, move, delete, etc.)
 */
@Injectable({
  providedIn: 'root',
})
export class RemoteFileOperationsService extends TauriBaseService {
  private readonly http = inject(HttpClient);

  async getFsInfo(remote: string, source?: Origin, group?: string): Promise<FsInfo> {
    try {
      return this.invokeCommand<FsInfo>('get_fs_info', { remote, origin: source, group });
    } catch (error) {
      console.error('Error getting filesystem info:', error);
      throw error;
    }
  }

  async getDiskUsage(
    remote: string,
    path?: string,
    source?: Origin,
    group?: string
  ): Promise<{
    total: number;
    used: number;
    free: number;
  }> {
    return this.invokeCommand('get_disk_usage', { remote, path, origin: source, group });
  }

  async getSize(
    remote: string,
    path?: string,
    source?: Origin,
    group?: string
  ): Promise<{
    count: number;
    bytes: number;
  }> {
    return this.invokeCommand('get_size', { remote, path, origin: source, group });
  }

  async getStat(
    remote: string,
    path: string,
    source?: Origin,
    group?: string
  ): Promise<{ item: Entry }> {
    return this.invokeCommand('get_stat', { remote, path, origin: source, group });
  }

  async getHashsum(
    remote: string,
    path: string,
    hashType: string,
    source?: Origin,
    group?: string
  ): Promise<{ hashsum: string[]; hashType: string }> {
    return this.invokeCommand('get_hashsum', { remote, path, hashType, origin: source, group });
  }

  async getHashsumFile(
    remote: string,
    path: string,
    hashType: string,
    source?: Origin,
    group?: string
  ): Promise<{ hash: string; hashType: string }> {
    return this.invokeCommand('get_hashsum_file', {
      remote,
      path,
      hashType,
      origin: source,
      group,
    });
  }

  async getPublicLink(
    remote: string,
    path: string,
    unlink?: boolean,
    expire?: string,
    source?: Origin,
    group?: string
  ): Promise<{ url: string }> {
    return this.invokeCommand('get_public_link', {
      remote,
      path,
      unlink,
      expire,
      origin: source,
      group,
    });
  }

  async getRemotePaths(
    remote: string,
    path: string,
    options: Record<string, unknown>,
    source?: Origin,
    group?: string
  ): Promise<{ list: Entry[] }> {
    return this.invokeCommand<{ list: Entry[] }>('get_remote_paths', {
      remote,
      path,
      options,
      origin: source,
      group,
    });
  }

  async transferItems(
    items: { remote: string; path: string; name: string; isDir: boolean }[],
    dstRemote: string,
    dstPath: string,
    mode: 'copy' | 'move',
    source?: Origin,
    group?: string
  ): Promise<string> {
    return this.invokeCommand<string>('transfer', {
      items,
      dstRemote,
      dstPath,
      mode,
      origin: source,
      group,
    });
  }

  async deleteItems(
    items: { remote: string; path: string; isDir: boolean }[],
    source?: Origin,
    group?: string
  ): Promise<string> {
    return this.invokeCommand<string>('delete', {
      items,
      origin: source,
      group,
    });
  }

  async removeEmptyDirs(
    remote: string,
    path: string,
    source?: Origin,
    group?: string
  ): Promise<string> {
    return this.invokeCommand<string>('remove_empty_dirs', {
      remote,
      path,
      origin: source,
      group,
    });
  }

  async rename(
    remote: string,
    srcPath: string,
    dstPath: string,
    isDir: boolean,
    source?: Origin,
    group?: string
  ): Promise<string> {
    return this.invokeCommand<string>('rename', {
      remote,
      srcPath,
      dstPath,
      isDir,
      origin: source,
      group,
    });
  }

  /**
   * Upload local filesystem paths (desktop native drag-drop) to target remote path.
   * Leverages Rclone's operations/copyfile and sync/copy internally under one job id!
   */
  async uploadLocalDropPaths(
    remote: string,
    path: string,
    localPaths: string[],
    source?: Origin,
    group?: string
  ): Promise<string> {
    return this.invokeCommand<string>('upload_local_drop_paths', {
      remote,
      path,
      localPaths,
      origin: source,
      group,
    });
  }

  async makeDirectory(
    remote: string,
    path: string,
    source?: Origin,
    group?: string
  ): Promise<void> {
    return this.invokeCommand<void>('mkdir', {
      remote,
      path,
      source,
      group,
    });
  }

  async cleanup(remote: string, path?: string, source?: Origin, group?: string): Promise<void> {
    return this.invokeCommand<void>('cleanup', { remote, path, source, group });
  }

  async copyUrl(
    remote: string,
    path: string,
    urlToCopy: string,
    autoFilename: boolean,
    source?: Origin,
    group?: string
  ): Promise<void> {
    return this.invokeCommand<void>('copy_url', {
      remote,
      path,
      urlToCopy,
      autoFilename,
      source,
      group,
    });
  }

  async registerPreparingJob(
    jobId: number,
    remote: string,
    destination: string,
    totalFiles: number,
    totalBytes: number,
    origin?: Origin
  ): Promise<void> {
    return this.apiClient.invoke('register_preparing_job', {
      jobid: jobId,
      remote,
      destination,
      totalFiles,
      totalBytes,
      origin,
    });
  }

  async updateJobStats(jobId: number, stats: any): Promise<void> {
    return this.apiClient.invoke('update_job_stats', {
      jobid: jobId,
      stats,
    });
  }

  async uploadFileStream(
    remote: string,
    path: string,
    file: File,
    source?: Origin,
    overrideName?: string,
    batchId?: string,
    fileIndex?: number,
    totalFiles?: number,
    jobId?: number
  ): Promise<string> {
    const formData = new FormData();
    formData.append('remote', remote);
    formData.append('path', path);
    if (source) formData.append('origin', JSON.stringify(source));
    if (batchId) formData.append('batchId', batchId);
    if (jobId !== undefined) formData.append('jobId', jobId.toString());
    if (fileIndex !== undefined) formData.append('fileIndex', fileIndex.toString());
    if (totalFiles !== undefined) formData.append('totalFiles', totalFiles.toString());
    formData.append('file', file, overrideName || file.name);

    const uploadUrl = `${this.apiClient.getApiBaseUrl()}/upload`;
    const response = (await firstValueFrom(
      this.http.post<{ success: boolean; data: string; error?: string }>(uploadUrl, formData, {
        withCredentials: true,
      })
    )) as { success: boolean; data: string; error?: string };

    if (response.success) {
      return response.data;
    } else {
      throw new Error(response.error || 'Upload failed');
    }
  }

  async uploadWebFilesBatch(
    remote: string,
    path: string,
    files: { file: File; relativePath: string }[],
    source?: Origin
  ): Promise<{ successCount: number; failedPaths: string[] }> {
    const batchId = Date.now().toString();
    const jobId = Date.now();
    const totalFiles = files.length;
    let totalBytes = 0;
    for (const f of files) totalBytes += f.file.size;

    await this.registerPreparingJob(jobId, remote, path, totalFiles, totalBytes, source);

    let uploadedBytes = 0;
    const completedItems: any[] = [];
    const failedPaths: string[] = [];
    let successCount = 0;

    for (let i = 0; i < totalFiles; i++) {
      const { file, relativePath } = files[i];
      try {
        await this.uploadFileStream(
          remote,
          path,
          file,
          source,
          relativePath,
          batchId,
          i,
          totalFiles,
          jobId
        );
        successCount++;
        uploadedBytes += file.size;
        completedItems.push({
          name: relativePath,
          size: file.size,
          bytes: file.size,
          completed_at: new Date().toISOString(),
        });

        await this.updateJobStats(jobId, {
          totalBytes,
          bytes: uploadedBytes,
          transfers: successCount,
          totalTransfers: totalFiles,
          completed: completedItems,
          transferring: [],
          preparing: true,
        });
      } catch (err) {
        console.error(`Upload failed for ${relativePath}:`, err);
        failedPaths.push(relativePath);
      }
    }
    return { successCount, failedPaths };
  }

  async submitBatchJob(
    inputs: Record<string, any>[],
    jobType: JobActionType,
    source?: Origin,
    group?: string
  ): Promise<string> {
    return this.invokeCommand<string>('submit_batch_job', {
      inputs,
      job_type: jobType,
      origin: source,
      group,
    });
  }
}
