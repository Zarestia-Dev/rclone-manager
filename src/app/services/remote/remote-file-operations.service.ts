import { Injectable } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { Entry, FsInfo, Origin } from '@app/types';

export interface LocalDropUploadResult {
  uploaded: number;
  failed: string[];
}

export interface LocalDropUploadEntry {
  relativePath: string;
  filename: string;
  size: number;
  content?: Uint8Array;
  localPath?: string | null;
}

/**
 * Service for remote file system operations
 * Handles browsing, metadata, and active file operations (copy, move, delete, etc.)
 */
@Injectable({
  providedIn: 'root',
})
export class RemoteFileOperationsService extends TauriBaseService {
  /**
   * Get filesystem info for a remote
   */
  async getFsInfo(remote: string, source?: Origin, group?: string): Promise<FsInfo> {
    try {
      return this.invokeCommand<FsInfo>('get_fs_info', { remote, origin: source, group });
    } catch (error) {
      console.error('Error getting filesystem info:', error);
      throw error;
    }
  }

  /**
   * Get disk usage for a remote
   */
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

  /**
   * Get size for a remote
   */
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

  /**
   * Get stats for a single path
   */
  async getStat(
    remote: string,
    path: string,
    source?: Origin,
    group?: string
  ): Promise<{ item: Entry }> {
    return this.invokeCommand('get_stat', { remote, path, origin: source, group });
  }

  /**
   * Get hashsum for a file
   */
  async getHashsum(
    remote: string,
    path: string,
    hashType: string,
    source?: Origin,
    group?: string
  ): Promise<{ hashsum: string[]; hashType: string }> {
    return this.invokeCommand('get_hashsum', { remote, path, hashType, origin: source, group });
  }

  /**
   * Get hashsum for a single file
   */
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

  /**
   * Get or create a public link for a file or folder
   */
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

  /**
   * Get remote paths (directory listing)
   */
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

  /**
   * Transfer multiple items (copy or move)
   */
  async transferItems(
    items: { srcRemote: string; srcPath: string; name: string; isDir: boolean }[],
    dstRemote: string,
    dstPath: string,
    mode: 'copy' | 'move',
    source?: Origin,
    group?: string
  ): Promise<string> {
    return this.invokeCommand<string>('transfer_items', {
      items,
      dstRemote,
      dstPath,
      mode,
      origin: source,
      group,
    });
  }

  /**
   * Delete multiple items
   */
  async deleteItems(
    items: { remote: string; path: string; isDir: boolean }[],
    source?: Origin,
    group?: string
  ): Promise<string> {
    return this.invokeCommand<string>('delete_items', {
      items,
      origin: source,
      group,
    });
  }

  /**
   * Remove all empty directories within a path
   */
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

  /**
   * Rename a single file
   */
  async renameFile(
    remote: string,
    srcPath: string,
    dstPath: string,
    source?: Origin,
    group?: string
  ): Promise<void> {
    return this.invokeCommand<void>('rename_file', {
      remote,
      srcPath,
      dstPath,
      source,
      group,
    });
  }

  /**
   * Rename a directory
   */
  async renameDir(
    remote: string,
    srcPath: string,
    dstPath: string,
    source?: Origin,
    group?: string
  ): Promise<void> {
    return this.invokeCommand<void>('rename_dir', {
      remote,
      srcPath,
      dstPath,
      source,
      group,
    });
  }

  /**
   * Upload a file content string to a remote file
   */
  async uploadFile(
    remote: string,
    path: string,
    filename: string,
    content: string,
    source?: Origin
  ): Promise<string> {
    return this.invokeCommand<string>('upload_file', {
      remote,
      path,
      filename,
      content,
      source,
    });
  }

  /**
   * Upload raw file bytes to a remote file.
   */
  async uploadFileBytes(
    remote: string,
    path: string,
    filename: string,
    content: Uint8Array,
    source?: Origin
  ): Promise<string> {
    return this.invokeCommand<string>('upload_file_bytes', {
      remote,
      path,
      filename,
      content,
      source,
    });
  }

  /**
   * Upload local filesystem paths (desktop native drag-drop) to target remote path.
   */
  async uploadLocalDropPaths(
    remote: string,
    path: string,
    localPaths: string[],
    source?: Origin
  ): Promise<LocalDropUploadResult> {
    return this.invokeCommand<LocalDropUploadResult>('upload_local_drop_paths', {
      remote,
      path,
      localPaths,
      source,
    });
  }

  /**
   * Upload browser-dropped entries (files and directories) to a remote path.
   */
  async uploadLocalDropEntries(
    remote: string,
    path: string,
    entries: LocalDropUploadEntry[],
    source?: Origin
  ): Promise<LocalDropUploadResult> {
    return this.invokeCommand<LocalDropUploadResult>('upload_local_drop_entries', {
      remote,
      path,
      entries,
      source,
    });
  }

  /**
   * Create a directory on the remote via backend `mkdir` command
   */
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

  /**
   * Cleanup trashed files on the remote (optional path)
   */
  async cleanup(remote: string, path?: string, source?: Origin, group?: string): Promise<void> {
    return this.invokeCommand<void>('cleanup', { remote, path, source, group });
  }

  /**
   * Copy a URL directly to a remote path
   */
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
  /**
   * Submit a batch of operations to the remote via job/batch
   */
  async submitBatchJob(
    inputs: Record<string, any>[],
    source?: Origin,
    group?: string
  ): Promise<string> {
    return this.invokeCommand<string>('submit_batch_job', {
      inputs,
      source,
      group,
    });
  }
}
