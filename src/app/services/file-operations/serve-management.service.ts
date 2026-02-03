import { DestroyRef, inject, Injectable } from '@angular/core';
import { BehaviorSubject, merge } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslateService } from '@ngx-translate/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { NotificationService } from '@app/services';
import { ServeStartResponse, ServeListResponse, ServeListItem } from '@app/types';
import { EventListenersService } from '../system/event-listeners.service';

/**
 * Service for managing rclone serve instances
 * Handles starting/stopping serves and serve state management
 */
@Injectable({
  providedIn: 'root',
})
export class ServeManagementService extends TauriBaseService {
  private readonly notificationService = inject(NotificationService);
  private readonly eventListeners = inject(EventListenersService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  // Observable for running serves list
  private runningServesSubject = new BehaviorSubject<ServeListItem[]>([]);
  public runningServes$ = this.runningServesSubject.asObservable();

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
        servesToUpdate = response;
      } else if (response && 'list' in response && Array.isArray(response.list)) {
        servesToUpdate = response.list;
      }

      this.runningServesSubject.next(servesToUpdate);
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
      console.debug('Cache failed, falling back to API:', cacheErr);
      try {
        const response = await this.listServes();
        this.runningServesSubject.next(response?.list ?? []);
      } catch (apiErr) {
        console.error('Both cache and API failed:', apiErr);
      }
    }
  }

  /**
   * Start a serve using a named profile
   * Backend resolves all options (serve, vfs, filter, backend) from cached settings
   */
  async startServeProfile(remoteName: string, profileName: string): Promise<ServeStartResponse> {
    try {
      const params = { remote_name: remoteName, profile_name: profileName };
      console.debug('Invoking start_serve_profile with params', params);
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
    } catch (error) {
      this.notificationService.showError(
        this.translate.instant('serve.failedStart', { remote: remoteName, error: String(error) })
      );
      throw error;
    }
  }

  /**
   * Stop a specific serve instance
   */
  async stopServe(serverId: string, remoteName: string): Promise<void> {
    try {
      await this.invokeCommand<string>('stop_serve', {
        serverId,
        remoteName,
      });

      this.notificationService.showSuccess(
        this.translate.instant('serve.successStop', { id: serverId })
      );

      // Refresh the list of running serves
      await this.refreshServes();
    } catch (error) {
      this.notificationService.showError(
        this.translate.instant('serve.failedStop', { id: serverId, error: String(error) })
      );
      throw error;
    }
  }

  /**
   * Stop all running serve instances
   */
  async stopAllServes(): Promise<void> {
    try {
      await this.invokeCommand<string>('stop_all_serves', {
        context: 'manual',
      });

      this.notificationService.showSuccess(this.translate.instant('serve.successStopAll'));

      // Clear the running serves list
      this.runningServesSubject.next([]);
    } catch (error) {
      this.notificationService.showError(
        this.translate.instant('serve.failedStopAll', { error: String(error) })
      );
      throw error;
    }
  }

  /**
   * Get the current list of running serves
   */
  getRunningServes(): ServeListItem[] {
    return this.runningServesSubject.value;
  }

  /**
   * Check if a specific serve is running
   */
  isServeRunning(serverId: string): boolean {
    return this.runningServesSubject.value.some(serve => serve.id === serverId);
  }

  /**
   * Get serve instance by ID
   */
  getServeById(serverId: string): ServeListItem | undefined {
    return this.runningServesSubject.value.find(serve => serve.id === serverId);
  }

  /**
   * Get serves for a specific remote
   */
  getServesByRemote(fs: string): ServeListItem[] {
    return this.runningServesSubject.value.filter(serve => serve.params.fs === fs);
  }

  /**
   * Get serves by type
   */
  getServesByType(serveType: string): ServeListItem[] {
    return this.runningServesSubject.value.filter(serve => serve.params.type === serveType);
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
    return this.invokeCommand<number>('rename_serve_profile_in_cache', {
      remoteName,
      oldName,
      newName,
    });
  }

  /**
   * Get serves for a specific remote and profile
   */
  getServesForRemoteProfile(remoteName: string, profile?: string): ServeListItem[] {
    return this.runningServesSubject.value.filter(serve => {
      const matchesRemote = serve.params.fs.startsWith(remoteName);
      if (profile) {
        return matchesRemote && serve.profile === profile;
      }
      return matchesRemote;
    });
  }
}
