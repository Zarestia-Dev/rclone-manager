import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { generatePrefixedId } from 'src/app/shared/utils';
import {
  Entry,
  FsInfo,
  JobActionType,
  Origin,
  FsTransferItem,
  FsDeleteItem,
  ArchiveListResponse,
  RenameItem,
} from '@app/types';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';

@Injectable({ providedIn: 'root' })
export class RemoteFileOperationsService extends TauriBaseService {
  private readonly http = inject(HttpClient);

  async getFsInfo(remote: string, source?: Origin, group?: string): Promise<FsInfo> {
    return this.invokeCommand<FsInfo>('get_fs_info', { remote, origin: source, group });
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
  ): Promise<{ count: number; bytes: number }> {
    return this.invokeCommand('get_size', { remote, path, origin: source, group });
  }

  async getStat(
    remote: string,
    path: string,
    opt?: Record<string, unknown>,
    source?: Origin,
    group?: string
  ): Promise<{ item: Entry }> {
    return this.invokeCommand('get_stat', { remote, path, opt, origin: source, group });
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
    items: FsTransferItem[],
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

  async deleteItems(items: FsDeleteItem[], source?: Origin, group?: string): Promise<string> {
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
    return this.renameBatch([{ remote, srcPath, dstPath, isDir }], source, group);
  }

  async renameBatch(items: RenameItem[], source?: Origin, group?: string): Promise<string> {
    return this.invokeCommand<string>('rename', {
      items,
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
    relativePath = file.name,
    group?: string
  ): Promise<string> {
    const body = new FormData();
    body.append('remote', remote);
    body.append('path', path);
    if (source) body.append('origin', JSON.stringify(source));
    if (group) body.append('group', group);
    body.append('mtime', file.lastModified.toString());
    body.append('file', file, relativePath || file.name);

    const response = await firstValueFrom(
      this.http.post<{ success: boolean; data: string; error?: string }>(
        `${this.apiClient.getApiBase()}/upload`,
        body,
        { withCredentials: true }
      )
    );
    if (!response.success) throw new Error(response.error || 'Upload failed');
    return response.data;
  }

  async uploadWebFilesBatch(
    remote: string,
    path: string,
    files: { file: File; relativePath: string }[],
    source?: Origin,
    emptyDirectories?: string[]
  ): Promise<{ successCount: number; failedPaths: string[] }> {
    const uniqueDirs = emptyDirectories?.length ? [...new Set(emptyDirectories)] : [];
    if (!files.length && !uniqueDirs.length) {
      return { successCount: 0, failedPaths: [] };
    }

    const body = new FormData();
    body.append('remote', remote);
    body.append('path', path);
    if (source) body.append('origin', JSON.stringify(source));
    body.append('group', generatePrefixedId('upload'));

    for (const dir of uniqueDirs) {
      body.append('emptyDirs', dir);
    }

    for (const { file, relativePath } of files) {
      body.append('mtime', file.lastModified.toString());
      body.append('file', file, relativePath || file.name);
    }

    try {
      const response = await firstValueFrom(
        this.http.post<{ success: boolean; data: string; error?: string }>(
          `${this.apiClient.getApiBase()}/upload`,
          body,
          { withCredentials: true }
        )
      );
      if (!response.success) {
        return {
          successCount: 0,
          failedPaths: files.length ? files.map(f => f.relativePath || f.file.name) : uniqueDirs,
        };
      }
      return { successCount: files.length, failedPaths: [] };
    } catch {
      return {
        successCount: 0,
        failedPaths: files.length ? files.map(f => f.relativePath || f.file.name) : uniqueDirs,
      };
    }
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
  ): Promise<ArchiveListResponse> {
    return this.invokeCommand<ArchiveListResponse>('archive_list', {
      source,
      long,
      plain,
      files_only: filesOnly,
      dirs_only: dirsOnly,
    });
  }
}
