import { Injectable } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import {
  Entry,
  FsInfo,
  Origin,
} from '@app/types';

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
  async getFsInfo(remote: string, source?: Origin): Promise<FsInfo> {
    try {
      return this.invokeCommand<FsInfo>('get_fs_info', { remote, origin: source });
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
    source?: Origin
  ): Promise<{
    total: number;
    used: number;
    free: number;
  }> {
    return this.invokeCommand('get_disk_usage', { remote, path, origin: source });
  }

  /**
   * Get size for a remote
   */
  async getSize(
    remote: string,
    path?: string,
    source?: Origin
  ): Promise<{
    count: number;
    bytes: number;
  }> {
    return this.invokeCommand('get_size', { remote, path, origin: source });
  }

  /**
   * Get stats for a single path
   */
  async getStat(remote: string, path: string, source?: Origin): Promise<{ item: Entry }> {
    return this.invokeCommand('get_stat', { remote, path, origin: source });
  }

  /**
   * Get hashsum for a file
   */
  async getHashsum(
    remote: string,
    path: string,
    hashType: string,
    source?: Origin
  ): Promise<{ hashsum: string[]; hashType: string }> {
    return this.invokeCommand('get_hashsum', { remote, path, hashType, origin: source });
  }

  /**
   * Get hashsum for a single file
   */
  async getHashsumFile(
    remote: string,
    path: string,
    hashType: string,
    source?: Origin
  ): Promise<{ hash: string; hashType: string }> {
    return this.invokeCommand('get_hashsum_file', { remote, path, hashType, origin: source });
  }

  /**
   * Get or create a public link for a file or folder
   */
  async getPublicLink(
    remote: string,
    path: string,
    unlink?: boolean,
    expire?: string,
    source?: Origin
  ): Promise<{ url: string }> {
    return this.invokeCommand('get_public_link', { remote, path, unlink, expire, origin: source });
  }

  /**
   * Get remote paths (directory listing)
   */
  async getRemotePaths(
    remote: string,
    path: string,
    options: Record<string, unknown>,
    source?: Origin
  ): Promise<{ list: Entry[] }> {
    return this.invokeCommand<{ list: Entry[] }>('get_remote_paths', {
      remote,
      path,
      options,
      origin: source,
    });
  }

  /**
   * Delete a single file
   */
  async deleteFile(
    remote: string,
    path: string,
    source?: Origin,
    noCache?: boolean
  ): Promise<number> {
    return this.invokeWithNotification<number>(
      'delete_file',
      { remote, path, source, noCache },
      {
        successKey: 'remote.operations.deleteSuccess',
        errorKey: 'remote.operations.deleteError',
        successParams: { name: path.split('/').pop() || path },
      }
    );
  }

  /**
   * Purge a directory (recursive delete)
   */
  async purgeDirectory(
    remote: string,
    path: string,
    source?: Origin,
    noCache?: boolean
  ): Promise<number> {
    return this.invokeWithNotification<number>(
      'purge_directory',
      { remote, path, source, noCache },
      {
        successKey: 'remote.operations.purgeSuccess',
        errorKey: 'remote.operations.purgeError',
        successParams: { name: path.split('/').pop() || path },
      }
    );
  }

  /**
   * Remove all empty directories within a path
   */
  async removeEmptyDirs(
    remote: string,
    path: string,
    source?: Origin,
    noCache?: boolean
  ): Promise<number> {
    return this.invokeWithNotification<number>(
      'remove_empty_dirs',
      { remote, path, source, noCache },
      {
        successKey: 'remote.operations.rmdirsSuccess',
        errorKey: 'remote.operations.rmdirsError',
        successParams: { name: path.split('/').pop() || path },
      }
    );
  }

  /**
   * Copy a single file
   */
  async copyFile(
    srcRemote: string,
    srcPath: string,
    dstRemote: string,
    dstPath: string,
    source?: Origin,
    noCache?: boolean
  ): Promise<number> {
    return this.invokeWithNotification<number>(
      'copy_file',
      { srcRemote, srcPath, dstRemote, dstPath, source, noCache },
      {
        successKey: 'remote.operations.copySuccess',
        errorKey: 'remote.operations.copyError',
        successParams: { name: srcPath.split('/').pop() || srcPath },
      }
    );
  }

  /**
   * Move a single file
   */
  async moveFile(
    srcRemote: string,
    srcPath: string,
    dstRemote: string,
    dstPath: string,
    source?: Origin,
    noCache?: boolean
  ): Promise<number> {
    return this.invokeWithNotification<number>(
      'move_file',
      { srcRemote, srcPath, dstRemote, dstPath, source, noCache },
      {
        successKey: 'remote.operations.moveSuccess',
        errorKey: 'remote.operations.moveError',
        successParams: { name: srcPath.split('/').pop() || srcPath },
      }
    );
  }

  /**
   * Rename a single file
   */
  async renameFile(
    remote: string,
    srcPath: string,
    dstPath: string,
    source?: Origin,
    noCache?: boolean
  ): Promise<number> {
    return this.invokeWithNotification<number>(
      'rename_file',
      { remote, srcPath, dstPath, source, noCache },
      {
        successKey: 'remote.operations.renameSuccess',
        errorKey: 'remote.operations.renameError',
        successParams: { name: srcPath.split('/').pop() || srcPath },
      }
    );
  }

  /**
   * Rename a directory
   */
  async renameDir(
    remote: string,
    srcPath: string,
    dstPath: string,
    source?: Origin,
    noCache?: boolean
  ): Promise<number> {
    return this.invokeWithNotification<number>(
      'rename_dir',
      { remote, srcPath, dstPath, source, noCache },
      {
        successKey: 'remote.operations.renameSuccess',
        errorKey: 'remote.operations.renameError',
        successParams: { name: srcPath.split('/').pop() || srcPath },
      }
    );
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
    return this.invokeWithNotification<string>(
      'upload_file',
      { remote, path, filename, content, source },
      {
        successKey: 'remote.operations.uploadSuccess',
        errorKey: 'remote.operations.uploadError',
        successParams: { name: filename },
      }
    );
  }

  /**
   * Copy a directory
   */
  async copyDirectory(
    srcRemote: string,
    srcPath: string,
    dstRemote: string,
    dstPath: string,
    source?: Origin,
    noCache?: boolean
  ): Promise<number> {
    return this.invokeWithNotification<number>(
      'copy_dir',
      { srcRemote, srcPath, dstRemote, dstPath, source, noCache },
      {
        successKey: 'remote.operations.copySuccess',
        errorKey: 'remote.operations.copyError',
        successParams: { name: srcPath.split('/').pop() || srcPath },
      }
    );
  }

  /**
   * Move a directory
   */
  async moveDirectory(
    srcRemote: string,
    srcPath: string,
    dstRemote: string,
    dstPath: string,
    source?: Origin,
    noCache?: boolean
  ): Promise<number> {
    return this.invokeWithNotification<number>(
      'move_dir',
      { srcRemote, srcPath, dstRemote, dstPath, source, noCache },
      {
        successKey: 'remote.operations.moveSuccess',
        errorKey: 'remote.operations.moveError',
        successParams: { name: srcPath.split('/').pop() || srcPath },
      }
    );
  }

  /**
   * Create a directory on the remote via backend `mkdir` command
   */
  async makeDirectory(
    remote: string,
    path: string,
    source?: Origin,
    noCache?: boolean
  ): Promise<number> {
    return this.invokeWithNotification<number>(
      'mkdir',
      { remote, path, source, noCache },
      {
        successKey: 'remote.operations.mkdirSuccess',
        errorKey: 'remote.operations.mkdirError',
        successParams: { name: path.split('/').pop() || path },
      }
    );
  }

  /**
   * Cleanup trashed files on the remote (optional path)
   */
  async cleanup(
    remote: string,
    path?: string,
    source?: Origin,
    noCache?: boolean
  ): Promise<number> {
    return this.invokeWithNotification<number>(
      'cleanup',
      { remote, path, source, noCache },
      {
        successKey: 'remote.operations.cleanupSuccess',
        errorKey: 'remote.operations.cleanupError',
        successParams: { name: remote },
      }
    );
  }
}
