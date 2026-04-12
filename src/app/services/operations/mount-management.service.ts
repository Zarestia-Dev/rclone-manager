import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { merge } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { MountedRemote, Origin } from '@app/types';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { getRemoteNameFromFs } from '../remote/utils/remote-config.utils';

/**
 * Service for managing rclone mounts
 * Handles mount/unmount operations and mount state management
 * Self-refreshes on MOUNT_STATE_CHANGED events from backend
 */
@Injectable({
  providedIn: 'root',
})
export class MountManagementService extends TauriBaseService {
  private readonly _mountedRemotes = signal<MountedRemote[]>([]);
  public readonly mountedRemotes = this._mountedRemotes.asReadonly();

  private eventListeners = inject(EventListenersService);
  private destroyRef = inject(DestroyRef);

  constructor() {
    super();
    this.initializeEventListeners();
  }

  /**
   * Initialize event listeners for mount state changes
   * Service auto-refreshes when backend emits mount state changes or engine becomes ready
   */
  private initializeEventListeners(): void {
    merge(
      this.eventListeners.listenToMountCacheUpdated(),
      this.eventListeners.listenToRcloneEngineReady()
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.getMountedRemotes().catch(err =>
          console.error('[MountManagementService] Failed to refresh mounts:', err)
        );
      });
  }

  /**
   * Get mounted remotes with details
   */
  async getMountedRemotes(): Promise<MountedRemote[]> {
    const mountedRemotes = await this.invokeCommand<MountedRemote[]>('get_cached_mounted_remotes');
    this._mountedRemotes.set(mountedRemotes);
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
  async mountRemoteProfile(
    remoteName: string,
    profileName: string,
    source?: Origin,
    noCache?: boolean
  ): Promise<void> {
    const params = {
      remote_name: remoteName,
      profile_name: profileName,
      source: source,
      no_cache: noCache,
    };

    await this.invokeWithNotification(
      'mount_remote_profile',
      { params },
      {
        successKey: 'mount.successMount',
        successParams: { remote: remoteName, profile: profileName },
        errorKey: 'mount.failedMount',
        errorParams: { remote: remoteName },
      }
    );
  }

  /**
   * Unmount a remote
   */
  async unmountRemote(mountPoint: string, remoteName: string): Promise<void> {
    await this.invokeWithNotification(
      'unmount_remote',
      { mountPoint, remoteName },
      {
        successKey: 'mount.successUnmount',
        successParams: { remote: remoteName },
        errorKey: 'mount.failedUnmount',
        errorParams: { remote: remoteName },
      }
    );
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
    const updated = await this.invokeCommand<number>('rename_mount_profile_in_cache', {
      remoteName,
      oldName,
      newName,
    });

    if (updated > 0) {
      await this.getMountedRemotes();
    }

    return updated;
  }

  /**
   * Get mounts for a specific remote and profile
   */
  getMountsForRemoteProfile(remoteName: string, profile?: string): MountedRemote[] {
    return this._mountedRemotes().filter(mount => {
      const matchesRemote = getRemoteNameFromFs(mount.fs) === remoteName;
      if (profile) {
        return matchesRemote && mount.profile === profile;
      }
      return matchesRemote;
    });
  }
}
