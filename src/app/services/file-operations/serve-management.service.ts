import { inject, Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { TauriBaseService } from '../core/tauri-base.service';
import { NotificationService } from '../../shared/services/notification.service';

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

  // Observable for running serves list
  private runningServesSubject = new BehaviorSubject<ServeListItem[]>([]);
  public runningServes$ = this.runningServesSubject.asObservable();

  constructor() {
    super();
    // Initialize by loading running serves
    this.refreshServes().catch(error => {
      console.error('Failed to initialize running serves:', error);
    });

    // Subscribe to serve state changes emitted from the backend and refresh list
    this.eventListeners.listenToServeStateChanged().subscribe(() => {
      this.refreshServes().catch(err => {
        console.error('Failed to refresh serves after serve_state_changed:', err);
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
      console.log('Fetched serves from cache:', response);

      let servesToUpdate: ServeListItem[] = [];
      if (Array.isArray(response)) {
        servesToUpdate = response;
      } else if (response && 'list' in response && Array.isArray(response.list)) {
        servesToUpdate = response.list;
      }

      this.runningServesSubject.next(servesToUpdate);
      console.log('Updated running serves from cache:', servesToUpdate);
      console.log('Refreshed serves from cache successfully');
      console.log(this.runningServesSubject.value); // <-- This will now log the array
    } catch (error) {
      console.error('Failed to refresh serves from cache:', error);
      throw error; // Re-throw to be caught by refreshServes if needed
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
      const params = { remoteName, profileName };
      const response = await this.invokeCommand<ServeStartResponse>('start_serve_profile', {
        params,
      });

      this.notificationService.showSuccess(
        `Started serve for ${remoteName} (${profileName}) at ${response.addr}`
      );
      await this.refreshServes();

      return response;
    } catch (error) {
      this.notificationService.showError(
        `Failed to start serve for ${remoteName} (${profileName}): ${error}`
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

      this.notificationService.showSuccess(`Successfully stopped serve ${serverId}`);

      // Refresh the list of running serves
      await this.refreshServes();
    } catch (error) {
      this.notificationService.showError(`Failed to stop serve ${serverId}: ${error}`);
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

      this.notificationService.showSuccess('Successfully stopped all serves');

      // Clear the running serves list
      this.runningServesSubject.next([]);
    } catch (error) {
      this.notificationService.showError(`Failed to stop all serves: ${error}`);
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
