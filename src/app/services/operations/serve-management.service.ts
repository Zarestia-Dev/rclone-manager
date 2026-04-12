import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { merge } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { ServeStartResponse, ServeListResponse, ServeListItem } from '@app/types';
import { EventListenersService, normalizeFs } from '@app/services';
import { getRemoteNameFromFs } from '../remote/utils/remote-config.utils';

/**
 * Service for managing rclone serve instances
 * Handles starting/stopping serves and serve state management
 */
@Injectable({
  providedIn: 'root',
})
export class ServeManagementService extends TauriBaseService {
  private readonly eventListeners = inject(EventListenersService);
  private readonly destroyRef = inject(DestroyRef);

  // Observable for running serves list
  private readonly _runningServes = signal<ServeListItem[]>([]);
  public readonly runningServes = this._runningServes.asReadonly();

  private normalizeServeItem(serve: ServeListItem): ServeListItem {
    return {
      ...serve,
      params: {
        ...serve.params,
        fs: normalizeFs(serve.params?.fs),
      },
    };
  }

  private normalizeServeList(serves: ServeListItem[]): ServeListItem[] {
    return serves.map(serve => this.normalizeServeItem(serve));
  }

  constructor() {
    super();
    this.refreshServes().catch(error => {
      console.error('Failed to initialize running serves:', error);
    });

    merge(
      this.eventListeners.listenToServeStateChanged(),
      this.eventListeners.listenToRcloneEngineReady()
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.refreshServes().catch(err => {
          console.error('[ServeManagementService] Failed to refresh serves:', err);
        });
      });
  }

  /**
   * Get all supported serve types
   */
  async getServeTypes(): Promise<string[]> {
    return this.invokeCommand<string[]>('get_serve_types');
  }

  /**
   * List all currently running serve instances
   */
  async listServes(): Promise<ServeListResponse> {
    return this.invokeCommand<ServeListResponse>('list_serves');
  }

  /**
   * Refresh serves from cache
   */
  async refreshServesFromCache(): Promise<void> {
    try {
      const response = await this.invokeCommand<ServeListItem[] | ServeListResponse>(
        'get_cached_serves'
      );

      let servesToUpdate: ServeListItem[] = [];
      if (Array.isArray(response)) {
        servesToUpdate = this.normalizeServeList(response);
      } else if (response && 'list' in response && Array.isArray(response.list)) {
        servesToUpdate = this.normalizeServeList(response.list);
      }

      this._runningServes.set(servesToUpdate);
    } catch (error) {
      console.error('[ServeManagementService] Failed to refresh serves from cache:', error);
      throw error;
    }
  }

  /**
   * Refresh the list of running serves with fallback logic
   */
  async refreshServes(): Promise<void> {
    try {
      await this.refreshServesFromCache();
    } catch (cacheErr) {
      console.debug('[ServeManagementService] Cache failed, falling back to API:', cacheErr);
      try {
        const response = await this.listServes();
        this._runningServes.set(this.normalizeServeList(response?.list ?? []));
      } catch (apiErr) {
        console.error('[ServeManagementService] Both cache and API failed:', apiErr);
      }
    }
  }

  /**
   * Start a serve using a named profile
   * Backend resolves all options (serve, vfs, filter, backend) from cached settings
   */
  async startServeProfile(remoteName: string, profileName: string): Promise<ServeStartResponse> {
    const params = { remote_name: remoteName, profile_name: profileName };
    const response = await this.invokeCommand<ServeStartResponse>('start_serve_profile', {
      params,
    });

    this.notificationService.showSuccess(
      this.translate.instant('serve.successStart', {
        remote: remoteName,
        profile: profileName,
        addr: response.addr,
      })
    );

    await this.refreshServes();
    return response;
  }

  /**
   * Stop a specific serve instance
   */
  async stopServe(serverId: string, remoteName: string): Promise<void> {
    await this.invokeWithNotification(
      'stop_serve',
      { serverId, remoteName },
      {
        successKey: 'serve.successStop',
        successParams: { id: serverId },
        errorKey: 'serve.failedStop',
        errorParams: { id: serverId },
      }
    );

    await this.refreshServes();
  }

  /**
   * Stop all running serve instances
   */
  async stopAllServes(): Promise<void> {
    await this.invokeWithNotification(
      'stop_all_serves',
      { context: 'manual' },
      {
        successKey: 'serve.successStopAll',
        errorKey: 'serve.failedStopAll',
      }
    );

    this._runningServes.set([]);
  }

  /**
   * Get the current list of running serves
   */
  getRunningServes(): ServeListItem[] {
    return this._runningServes();
  }

  /**
   * Check if a specific serve is running
   */
  isServeRunning(serverId: string): boolean {
    return this._runningServes().some(serve => serve.id === serverId);
  }

  /**
   * Get serve instance by ID
   */
  getServeById(serverId: string): ServeListItem | undefined {
    return this._runningServes().find(serve => serve.id === serverId);
  }

  /**
   * Get serves for a specific remote
   */
  getServesByRemote(fs: string): ServeListItem[] {
    const targetRemote = getRemoteNameFromFs(fs);
    return this._runningServes().filter(
      serve => getRemoteNameFromFs(serve.params?.fs) === targetRemote
    );
  }

  /**
   * Get serves by type
   */
  getServesByType(serveType: string): ServeListItem[] {
    return this._runningServes().filter(serve => serve.params.type === serveType);
  }

  /**
   * Rename a profile in all cached serves for a given remote
   * Returns the number of serves updated
   */
  async renameProfileInServeCache(
    remoteName: string,
    oldName: string,
    newName: string
  ): Promise<number> {
    const updated = await this.invokeCommand<number>('rename_serve_profile_in_cache', {
      remoteName,
      oldName,
      newName,
    });

    if (updated > 0) {
      await this.refreshServesFromCache();
    }

    return updated;
  }

  /**
   * Get serves for a specific remote and profile
   */
  getServesForRemoteProfile(remoteName: string, profile?: string): ServeListItem[] {
    return this._runningServes().filter(serve => {
      const matchesRemote = getRemoteNameFromFs(serve.params?.fs) === remoteName;
      if (profile) {
        return matchesRemote && serve.profile === profile;
      }
      return matchesRemote;
    });
  }
}
