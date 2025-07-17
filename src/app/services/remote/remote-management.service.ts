import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { TauriBaseService } from '../core/tauri-base.service';

export interface RemoteProvider {
  name: string;
  description: string;
}

export type RemoteConfig = Record<string, any>;

/**
 * Service for managing rclone remotes
 * Handles CRUD operations, OAuth, and remote configuration
 */
@Injectable({
  providedIn: 'root',
})
export class RemoteManagementService extends TauriBaseService {
  async forceRefreshMountedRemotes(): Promise<void> {
    try {
      await this.emitEvent('remote_state_changed');
    } catch (error) {
      console.error('Failed to refresh mounted remotes:', error);
      throw error;
    }
  }
  private remotesCache = new BehaviorSubject<string[]>([]);
  public remotes$ = this.remotesCache.asObservable();

  /**
   * Get all available remote types
   */
  async getRemoteTypes(): Promise<RemoteProvider[]> {
    const response =
      await this.invokeCommand<Record<string, { Name: string; Description: string }[]>>(
        'get_remote_types'
      );

    return Object.values(response)
      .flat()
      .map(provider => ({
        name: provider.Name,
        description: provider.Description,
      }));
  }

  /**
   * Get OAuth-supported remote types
   */
  async getOAuthSupportedRemotes(): Promise<RemoteProvider[]> {
    const response = await this.invokeCommand<
      Record<string, { Name: string; Description: string }[]>
    >('get_oauth_supported_remotes');

    return Object.values(response)
      .flat()
      .map(provider => ({
        name: provider.Name,
        description: provider.Description,
      }));
  }

  /**
   * Get configuration fields for a specific remote type
   */
  async getRemoteConfigFields(type: string): Promise<any[]> {
    const response = await this.invokeCommand<{ providers: any[] }>('get_remote_types');
    const provider = response.providers.find(p => p.Name === type);
    return provider ? provider.Options : [];
  }

  /**
   * Get all remotes
   */
  async getRemotes(): Promise<string[]> {
    const remotes = await this.invokeCommand<string[]>('get_cached_remotes');
    this.remotesCache.next(remotes);
    return remotes;
  }

  /**
   * Get all remote configurations
   */
  async getAllRemoteConfigs(): Promise<Record<string, any>> {
    return this.invokeCommand<Record<string, any>>('get_configs');
  }

  /**
   * Create a new remote
   */
  async createRemote(name: string, parameters: RemoteConfig): Promise<void> {
    await this.invokeCommand('create_remote', { name, parameters });
    await this.refreshRemotes();
  }

  /**
   * Update an existing remote
   */
  async updateRemote(name: string, parameters: RemoteConfig): Promise<void> {
    await this.invokeCommand('update_remote', { name, parameters });
    await this.refreshRemotes();
  }

  /**
   * Delete a remote
   */
  async deleteRemote(name: string): Promise<void> {
    await this.batchInvoke([
      { command: 'delete_remote', args: { name } },
      { command: 'delete_remote_settings', args: { remoteName: name } },
    ]);
    await this.refreshRemotes();
  }

  /**
   * Quit OAuth process
   */
  async quitOAuth(): Promise<void> {
    return this.invokeCommand('quit_rclone_oauth');
  }

  /**
   * Get filesystem info for a remote
   */
  async getFsInfo(remote: string): Promise<any> {
    return this.invokeCommand('get_fs_info', { remote });
  }

  /**
   * Get disk usage for a remote
   */
  async getDiskUsage(remote: string): Promise<{
    total: string;
    used: string;
    free: string;
  }> {
    return this.invokeCommand('get_disk_usage', { remote });
  }

  /**
   * Get remote paths
   */
  async getRemotePaths(remote: string, path: string, options: Record<string, any>): Promise<any> {
    return this.invokeCommand('get_remote_paths', { remote, path, options });
  }

  /**
   * Listen to remote deletion events
   */
  listenToRemoteDeletion(): Observable<string> {
    return this.listenToEvent<string>('remote_deleted');
  }

  /**
   * Refresh the remotes cache
   */
  private async refreshRemotes(): Promise<void> {
    const remotes = await this.getRemotes();
    this.remotesCache.next(remotes);
  }
}
