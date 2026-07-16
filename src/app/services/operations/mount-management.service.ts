import { DestroyRef, inject, Injectable, signal, computed } from '@angular/core';
import { merge } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { MountedRemote, Origin } from '@app/types';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { PathService } from '../infrastructure/platform/path.service';
import { groupBy } from '../remote/utils/remote-config.utils';

@Injectable({
  providedIn: 'root',
})
export class MountManagementService extends TauriBaseService {
  private readonly _mountedRemotes = signal<MountedRemote[]>([]);
  public readonly mountedRemotes = this._mountedRemotes.asReadonly();

  public readonly mountsByRemote = computed(() =>
    groupBy(this._mountedRemotes(), m => this.pathService.getRemoteNameFromFs(m.fs))
  );

  private readonly mountsByRemoteProfile = computed(() => {
    const map = new Map<string, MountedRemote[]>();
    for (const m of this._mountedRemotes()) {
      const key = this.pathService.getRemoteNameFromFs(m.fs);
      const list = map.get(key);
      if (list) {
        list.push(m);
      } else {
        map.set(key, [m]);
      }
    }
    return map;
  });

  private readonly eventListeners = inject(EventListenersService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly pathService = inject(PathService);

  constructor() {
    super();
    this.initializeEventListeners();
  }

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

  async getMountedRemotes(): Promise<MountedRemote[]> {
    const mountedRemotes = await this.invokeCommand<MountedRemote[]>('get_cached_mounted_remotes');
    this._mountedRemotes.set(mountedRemotes);
    return mountedRemotes;
  }

  async mountRemoteProfile(
    remoteName: string,
    profileName: string,
    source?: Origin,
    noCache?: boolean
  ): Promise<void> {
    const params = {
      remoteName,
      profileName,
      source,
      noCache,
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

  async forceCheckMountedRemotes(): Promise<void> {
    await this.invokeCommand('force_check_mounted_remotes');
  }

  async getMountTypes(): Promise<string[]> {
    return this.invokeCommand<string[]>('get_mount_types');
  }

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

  getMountsForRemoteProfile(remoteName: string, profile?: string): MountedRemote[] {
    const all = this.mountsByRemoteProfile().get(remoteName) ?? [];
    if (!profile) return all;
    return all.filter(m => m.profile === profile);
  }
}
