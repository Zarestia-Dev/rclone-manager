import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { DiskUsageSeverity, Entry, FsInfo, JobActionType, Origin } from '@app/types';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';

@Injectable({ providedIn: 'root' })
export class RemoteFileOperationsService extends TauriBaseService {
  private readonly http = inject(HttpClient);

  async getFsInfo(remote: string, source?: Origin, group?: string): Promise<FsInfo> {
    return this.invokeCommand<FsInfo>('get_fs_info', { remote, origin: source, group }).catch(e => {
      console.error(e);
      throw e;
    });
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
    usagePercentage: number;
    usagePercentageLabel: string;
    usageSeverity: DiskUsageSeverity;
  }> {
    return this.invokeCommand('get_disk_usage', { remote, path, origin: source, group });
  }

  async getSize(
    remote: string,
    path?: string,
    source?: Origin,
    group?: string
  ): Promise<{ count: number; bytes: number }> {
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
    items: any[],
    dstRemote: string,
    dstPath: string,
    mode: 'copy' | 'move',
    source?: Origin,
    group?: string,
    parentJobId?: number
  ): Promise<string> {
    return this.invokeCommand<string>('transfer', {
      items,
      dstRemote,
      dstPath,
      mode,
      origin: source,
      group,
      parentJobId,
    });
  }

  async deleteItems(items: any[], source?: Origin, group?: string): Promise<string> {
    return this.invokeCommand<string>('delete', { items, origin: source, group });
  }

  async removeEmptyDirs(
    remote: string,
    path: string,
    source?: Origin,
    group?: string
  ): Promise<string> {
    return this.invokeCommand<string>('remove_empty_dirs', { remote, path, origin: source, group });
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
      items: [
        {
          remote,
          srcPath,
          dstPath,
          isDir,
        },
      ],
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
    return this.invokeCommand<void>('mkdir', { remote, path, origin: source, group });
  }

  async cleanup(remote: string, path?: string, source?: Origin, group?: string): Promise<void> {
    return this.invokeCommand<void>('cleanup', { remote, path, origin: source, group });
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
      origin: source,
      group,
    });
  }

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

  async uploadFileSimple(
    remote: string,
    path: string,
    name: string,
    content: Uint8Array
  ): Promise<string> {
    return this.invokeCommand<string>('upload_file', {
      remote,
      path,
      name,
      content: Array.from(content),
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
    const fd = new FormData();
    fd.append('remote', remote);
    fd.append('path', path);
    if (source) fd.append('origin', JSON.stringify(source));
    if (batchId) fd.append('batchId', batchId);
    if (jobId !== undefined) fd.append('jobId', jobId.toString());
    if (fileIndex !== undefined) fd.append('fileIndex', fileIndex.toString());
    if (totalFiles !== undefined) fd.append('totalFiles', totalFiles.toString());
    fd.append('file', file, overrideName || file.name);

    const res = await firstValueFrom(
      this.http.post<{ success: boolean; data: string; error?: string }>(
        `${this.apiClient.getApiBase()}/upload`,
        fd,
        { withCredentials: true }
      )
    );
    if (res.success) return res.data;
    throw new Error(res.error || 'Upload failed');
  }

  async uploadWebFilesBatch(
    remote: string,
    path: string,
    files: { file: File; relativePath: string }[],
    source?: Origin
  ): Promise<{ successCount: number; failedPaths: string[] }> {
    const batchId = Date.now().toString(),
      jobId = Date.now(),
      totalFiles = files.length,
      totalBytes = files.reduce((s, f) => s + f.file.size, 0);
    await this.registerPreparingJob(jobId, remote, path, totalFiles, totalBytes, source);

    let uploadedBytes = 0,
      successCount = 0;
    const completed: any[] = [],
      failedPaths: string[] = [];

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
        completed.push({
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
          completed,
          transferring: [],
          preparing: true,
        });
      } catch (err) {
        console.error(err);
        failedPaths.push(relativePath);
      }
    }
    return { successCount, failedPaths };
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

  async updateJobStats(jobId: number, stats: unknown): Promise<void> {
    return this.apiClient.invoke('update_job_stats', { jobid: jobId, stats });
  }

  async submitBatchJob(
    inputs: Record<string, unknown>[],
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

  async archiveCreate(
    source: string,
    destination: string,
    format?: string,
    prefix?: string,
    fullPath?: boolean,
    include?: string[]
  ): Promise<unknown> {
    return this.invokeCommand('archive_create', {
      source,
      destination,
      format,
      prefix,
      fullPath,
      include,
    });
  }

  async archiveExtract(source: string, destination: string): Promise<unknown> {
    return this.invokeCommand('archive_extract', { source, destination });
  }

  async archiveList(
    source: string,
    long?: boolean,
    plain?: boolean,
    filesOnly?: boolean,
    dirsOnly?: boolean
  ): Promise<any> {
    return this.invokeCommand('archive_list', {
      source,
      long,
      plain,
      files_only: filesOnly,
      dirs_only: dirsOnly,
    });
  }
}
