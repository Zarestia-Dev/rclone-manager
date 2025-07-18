import { inject, Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { TauriBaseService } from '../core/tauri-base.service';
import { NotificationService } from '../../shared/services/notification.service';

export type MountOptions = Record<string, string | number | boolean>;

export type VfsOptions = Record<string, string | number | boolean>;

/**
 * Service for managing rclone mounts
 * Handles mount/unmount operations and mount state management
 */
@Injectable({
  providedIn: 'root',
})
export class MountManagementService extends TauriBaseService {
  private mountedRemotesCache = new BehaviorSubject<any[]>([]);
  public mountedRemotes$ = this.mountedRemotesCache.asObservable();

  private notificationService = inject(NotificationService);
  constructor() {
    super();
  }

  /**
   * List all mounted remotes
   */
  async listMounts(): Promise<string[]> {
    return this.invokeCommand<string[]>('list_mounts');
  }

  /**
   * Get mounted remotes with details
   */
  async getMountedRemotes(): Promise<any[]> {
    const mountedRemotes = await this.invokeCommand<any[]>('get_cached_mounted_remotes');
    this.mountedRemotesCache.next(mountedRemotes);
    return mountedRemotes;
  }

  /**
   * Mount a remote
   */
  async mountRemote(
    remoteName: string,
    source: string,
    mountPoint: string,
    mountOptions?: MountOptions,
    vfsOptions?: VfsOptions
  ): Promise<void> {
    try {
      await this.invokeCommand('mount_remote', {
        remoteName,
        source,
        mountPoint,
        mountOptions: mountOptions || {},
        vfsOptions: vfsOptions || {},
      });

      await this.refreshMountedRemotes();
      this.notificationService.showSuccess(`Successfully mounted ${remoteName}`);
    } catch (error) {
      this.notificationService.showError(`Failed to mount ${remoteName}: ${error}`);
      throw error;
    }
  }

  /**
   * Unmount a remote
   */
  async unmountRemote(mountPoint: string, remoteName: string): Promise<void> {
    try {
      await this.invokeCommand('unmount_remote', { mountPoint, remoteName });
      await this.refreshMountedRemotes();
      this.notificationService.showSuccess(`Successfully unmounted ${remoteName}`);
    } catch (error) {
      this.notificationService.showError(`Failed to unmount ${remoteName}: ${error}`);
      throw error;
    }
  }

  /**
   * Force check mounted remotes
   */
  async forceCheckMountedRemotes(): Promise<void> {
    try {
      await this.invokeCommand('force_check_mounted_remotes');
      this.notificationService.openSnackBar(
        'Force check mounted remotes completed successfully',
        'Close'
      );
    } catch (error) {
      this.notificationService.openSnackBar(
        `Failed to force check mounted remotes: ${error}`,
        'Close'
      );
      throw error;
    }
  }

  /**
   * Open mount point in file manager
   */
  async openInFiles(mountPoint: string): Promise<void> {
    return this.invokeCommand('open_in_files', { path: mountPoint });
  }

  /**
   * Get mount flags
   */
  async getMountFlags(): Promise<any> {
    return this.invokeCommand('get_mount_flags');
  }

  /**
   * Get VFS flags
   */
  async getVfsFlags(): Promise<any> {
    return this.invokeCommand('get_vfs_flags');
  }

  /**
   * Get sync flags
   */
  async getSyncFlags(): Promise<any> {
    return this.invokeCommand('get_sync_flags');
  }

  /**
   * Get copy flags
   */
  async getCopyFlags(): Promise<any> {
    return this.invokeCommand('get_copy_flags');
  }

  /**
   * Get filter flags
   */
  async getFilterFlags(): Promise<any> {
    return this.invokeCommand('get_filter_flags');
  }

  /**
   * Get global flags
   */
  async getGlobalFlags(): Promise<any> {
    return this.invokeCommand('get_global_flags');
  }

  /**
   * Refresh mounted remotes cache
   */
  private async refreshMountedRemotes(): Promise<void> {
    const mountedRemotes = await this.getMountedRemotes();
    this.mountedRemotesCache.next(mountedRemotes);
  }
}
