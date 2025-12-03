import { inject, Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { TauriBaseService } from '../core/tauri-base.service';
import { NotificationService } from '../../shared/services/notification.service';

import {
  MountOptions,
  VfsOptions,
  MountParams,
  BackendOptions,
  FilterOptions,
  MountedRemote,
} from '@app/types';

/**
 * Service for managing rclone mounts
 * Handles mount/unmount operations and mount state management
 */
@Injectable({
  providedIn: 'root',
})
export class MountManagementService extends TauriBaseService {
  private mountedRemotesCache = new BehaviorSubject<MountedRemote[]>([]);
  public mountedRemotes$ = this.mountedRemotesCache.asObservable();

  private notificationService = inject(NotificationService);
  constructor() {
    super();
  }

  /**
   * Get mounted remotes with details
   */
  async getMountedRemotes(): Promise<MountedRemote[]> {
    const mountedRemotes = await this.invokeCommand<MountedRemote[]>('get_cached_mounted_remotes');
    this.mountedRemotesCache.next(mountedRemotes);
    return mountedRemotes;
  }

  /**
   * Get mount types
   */
  async getMountTypes(): Promise<string[]> {
    return this.invokeCommand<string[]>('get_mount_types');
  }

  /**
   * Mount a remote
   */
  async mountRemote(
    remoteName: string,
    source: string,
    mountPoint: string,
    mountType: string,
    mountOptions?: MountOptions,
    vfsOptions?: VfsOptions,
    filterOptions?: FilterOptions,
    backendOptions?: BackendOptions
  ): Promise<void> {
    try {
      const params: MountParams = {
        remote_name: remoteName,
        source: source || '',
        mount_point: mountPoint || '',
        mount_type: mountType || '',
        mount_options: mountOptions || {},
        vfs_options: vfsOptions || {},
        filter_options: filterOptions || {},
        backend_options: backendOptions || {},
      };
      await this.invokeCommand('mount_remote', { params });
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
  public async forceCheckMountedRemotes(): Promise<void> {
    await this.invokeCommand('force_check_mounted_remotes');
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
   * Get backend flags
   */
  async getBackendFlags(): Promise<any> {
    return this.invokeCommand('get_backend_flags');
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
