import { inject, Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { TauriBaseService } from '../core/tauri-base.service';
import { NotificationService } from '@app/services';
import { MountedRemote, MOUNT_STATE_CHANGED } from '@app/types';

/**
 * Service for managing rclone mounts
 * Handles mount/unmount operations and mount state management
 * Self-refreshes on MOUNT_STATE_CHANGED events from backend
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
    this.initializeEventListeners();
  }

  /**
   * Initialize event listeners for mount state changes
   */
  private initializeEventListeners(): void {
    this.listenToEvent<unknown>(MOUNT_STATE_CHANGED).subscribe(() => {
      this.getMountedRemotes().catch(err =>
        console.error('Failed to refresh mounts on state change:', err)
      );
    });
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
   * Mount a remote using a named profile
   * Backend resolves all options (mount, vfs, filter, backend) from cached settings
   */
  async mountRemoteProfile(remoteName: string, profileName: string): Promise<void> {
    try {
      const params = { remote_name: remoteName, profile_name: profileName };
      await this.invokeCommand('mount_remote_profile', { params });
      this.notificationService.showSuccess(`Successfully mounted ${remoteName} (${profileName})`);
    } catch (error) {
      this.notificationService.showError(
        `Failed to mount ${remoteName} (${profileName}): ${error}`
      );
      throw error;
    }
  }

  /**
   * Unmount a remote
   */
  async unmountRemote(mountPoint: string, remoteName: string): Promise<void> {
    try {
      await this.invokeCommand('unmount_remote', { mountPoint, remoteName });
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
   * Rename a profile in all cached mounts for a given remote
   * Returns the number of mounts updated
   */
  async renameProfileInMountCache(
    remoteName: string,
    oldName: string,
    newName: string
  ): Promise<number> {
    return this.invokeCommand<number>('rename_mount_profile_in_cache', {
      remoteName,
      oldName,
      newName,
    });
  }

  /**
   * Get mounts for a specific remote and profile
   */
  getMountsForRemoteProfile(remoteName: string, profile?: string): MountedRemote[] {
    return this.mountedRemotesCache.value.filter(mount => {
      const matchesRemote = mount.fs.startsWith(remoteName);
      if (profile) {
        return matchesRemote && mount.profile === profile;
      }
      return matchesRemote;
    });
  }
}
