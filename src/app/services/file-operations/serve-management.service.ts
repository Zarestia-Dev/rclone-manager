import { inject, Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { TauriBaseService } from '../core/tauri-base.service';
import { NotificationService } from '../../shared/services/notification.service';

import { ServeStartResponse, ServeListResponse, ServeListItem, RcConfigOption } from '@app/types';

/**
 * Service for managing rclone serve instances
 * Handles starting/stopping serves and serve state management
 */
@Injectable({
  providedIn: 'root',
})
export class ServeManagementService extends TauriBaseService {
  private readonly notificationService = inject(NotificationService);

  // Observable for running serves list
  private runningServesSubject = new BehaviorSubject<ServeListItem[]>([]);
  public runningServes$ = this.runningServesSubject.asObservable();

  constructor() {
    super();
    // Initialize by loading running serves
    this.refreshServes().catch(error => {
      console.error('Failed to initialize running serves:', error);
    });
  }

  /**
   * Get all supported serve types
   */
  async getServeTypes(): Promise<string[]> {
    return this.invokeCommand<string[]>('get_serve_types');
  }

  /**
   * Get flags/options for a specific serve type
   */
  async getServeFlags(serveType: string): Promise<RcConfigOption[]> {
    return this.invokeCommand<RcConfigOption[]>('get_serve_flags', { serveType });
  }

  /**
   * List all currently running serve instances
   */
  async listServes(): Promise<ServeListResponse> {
    return this.invokeCommand<ServeListResponse>('list_serves');
  }

  /**
   * Refresh the list of running serves
   */
  async refreshServes(): Promise<void> {
    try {
      const response = await this.listServes();
      this.runningServesSubject.next(response.list || []);
    } catch (error) {
      console.error('Failed to refresh serves:', error);
      this.runningServesSubject.next([]);
    }
  }

  /**
   * Start a new serve instance
   */
  async startServe(
    remoteName: string,
    serveOptions: Record<string, unknown>,
    backendOptions?: Record<string, unknown>,
    filterOptions?: Record<string, unknown>,
    vfsOptions?: Record<string, unknown>
  ): Promise<ServeStartResponse> {
    try {
      // Get serve type from options for notification
      console.log('Starting serve with options:', serveOptions);

      const serveType = (serveOptions['type'] as string) || 'serve';

      const params = {
        remote_name: remoteName,
        serve_options: serveOptions,
        filter_options: filterOptions || null,
        backend_options: backendOptions || null,
        vfs_options: vfsOptions || null,
      };

      const response = await this.invokeCommand<ServeStartResponse>('start_serve', { params });

      this.notificationService.showSuccess(
        `Successfully started ${serveType} serve at ${response.addr}`
      );

      // Refresh the list of running serves
      await this.refreshServes();

      return response;
    } catch (error) {
      const serveType = (serveOptions['type'] as string) || 'serve';
      this.notificationService.showError(`Failed to start ${serveType}: ${error}`);
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
}
