import { Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import {
  RemoteProvider,
  RemoteConfig,
  RcConfigQuestionResponse,
  Entry,
  LocalDrive,
  FsInfo,
} from '@app/types';

/**
 * Service for managing rclone remotes
 * Handles CRUD operations, OAuth, and remote configuration
 * Self-refreshes on REMOTE_CACHE_UPDATED events from backend
 */
@Injectable({
  providedIn: 'root',
})
export class RemoteManagementService extends TauriBaseService {
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
    const response = await this.invokeCommand<unknown>('get_remote_types');

    // Response can be either { providers: [...] } or a record of arrays
    let providers: unknown[] = [];
    if (
      typeof response === 'object' &&
      response !== null &&
      'providers' in (response as Record<string, unknown>) &&
      Array.isArray((response as Record<string, unknown>)['providers'] as unknown[])
    ) {
      providers = (response as Record<string, unknown>)['providers'] as unknown[];
    } else if (typeof response === 'object' && response !== null) {
      for (const v of Object.values(response as Record<string, unknown>)) {
        if (Array.isArray(v)) providers = providers.concat(v as unknown[]);
      }
    }

    const match = providers.find(
      p => typeof p === 'object' && p !== null && (p as Record<string, unknown>)['Name'] === type
    ) as Record<string, unknown> | undefined;

    const options = match ? (match['Options'] as unknown) : undefined;
    return Array.isArray(options) ? (options as unknown[]) : [];
  }

  /**
   * Get all remotes
   */
  async getRemotes(): Promise<string[]> {
    return this.invokeCommand<string[]>('get_cached_remotes');
  }

  /**
   * Get all remote configurations
   */
  async getAllRemoteConfigs(): Promise<Record<string, unknown>> {
    return this.invokeCommand<Record<string, unknown>>('get_configs');
  }

  /**
   * Create a new remote
   */
  async createRemote(name: string, parameters: RemoteConfig): Promise<void> {
    await this.invokeCommand('create_remote', { name, parameters });
  }

  /**
   * Update an existing remote
   */
  async updateRemote(name: string, parameters: RemoteConfig): Promise<void> {
    await this.invokeCommand('update_remote', { name, parameters });
  }

  /**
   * Delete a remote
   */
  async deleteRemote(name: string): Promise<void> {
    await this.batchInvoke([
      { command: 'delete_remote', args: { name } },
      { command: 'delete_remote_settings', args: { remoteName: name } },
    ]);
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
  async getFsInfo(remote: string): Promise<FsInfo> {
    try {
      return this.invokeCommand<FsInfo>('get_fs_info', { remote });
    } catch (error) {
      console.error('Error getting filesystem info:', error);
      throw error;
    }
  }

  /**
   * Get disk usage for a remote
   */
  async getDiskUsage(
    remote: string,
    path?: string
  ): Promise<{
    total: number;
    used: number;
    free: number;
  }> {
    return this.invokeCommand('get_disk_usage', { remote, path });
  }

  /**
   * Get size for a remote
   */
  async getSize(
    remote: string,
    path?: string
  ): Promise<{
    count: number;
    bytes: number;
  }> {
    return this.invokeCommand('get_size', { remote, path });
  }

  async getStat(remote: string, path: string): Promise<{ item: Entry }> {
    return this.invokeCommand('get_stat', { remote, path });
  }

  /**
   * Get hashsum for a file
   * @param remote - Remote name (e.g., "drive:")
   * @param path - Path to the file
   * @param hashType - Hash algorithm (e.g., "md5", "sha1")
   * @returns Hash result with hashsum array and hashType
   */
  async getHashsum(
    remote: string,
    path: string,
    hashType: string
  ): Promise<{ hashsum: string[]; hashType: string }> {
    return this.invokeCommand('get_hashsum', { remote, path, hashType });
  }

  /**
   * Get hashsum for a single file
   * @param remote - Remote name (e.g., "drive:")
   * @param path - Path to the file
   * @param hashType - Hash algorithm (e.g., "md5", "sha1")
   * @returns Hash result with hash and hashType
   */
  async getHashsumFile(
    remote: string,
    path: string,
    hashType: string
  ): Promise<{ hash: string; hashType: string }> {
    return this.invokeCommand('get_hashsum_file', { remote, path, hashType });
  }

  /**
   * Get or create a public link for a file or folder
   * @param remote - Remote name (e.g., "drive:")
   * @param path - Path to the file or folder
   * @param unlink - If true, removes the link instead of creating it
   * @returns Public URL for sharing
   */
  async getPublicLink(
    remote: string,
    path: string,
    unlink?: boolean,
    expire?: string
  ): Promise<{ url: string }> {
    return this.invokeCommand('get_public_link', { remote, path, unlink, expire });
  }

  /**
   * Get remote paths
   */
  async getRemotePaths(
    remote: string,
    path: string,
    options: Record<string, unknown>
  ): Promise<{ list: Entry[] }> {
    return this.invokeCommand<{ list: Entry[] }>('get_remote_paths', { remote, path, options });
  }

  async getLocalDrives(): Promise<LocalDrive[]> {
    return this.invokeCommand<LocalDrive[]>('get_local_drives');
  }

  /**
   * Create a directory on the remote via backend `mkdir` command
   */
  async makeDirectory(remote: string, path: string): Promise<void> {
    return this.invokeCommand('mkdir', { remote, path });
  }

  /**
   * Cleanup trashed files on the remote (optional path)
   */
  async cleanup(remote: string, path?: string): Promise<void> {
    return this.invokeCommand('cleanup', { remote, path });
  }

  /**
   * Start non-interactive remote config. Returns a question or an empty state when finished.
   */
  async startRemoteConfigInteractive(
    name: string,
    type: string,
    parameters?: Record<string, unknown>,
    opt?: Record<string, unknown>
  ): Promise<RcConfigQuestionResponse> {
    return this.invokeCommand('create_remote_interactive', {
      name,
      // Send both casing variants for compatibility with different backend builds
      rclone_type: type,
      rcloneType: type,
      parameters: parameters ?? {},
      opt: opt ?? {},
    });
  }

  /**
   * Continue non-interactive remote config flow by passing state and user's answer (result).
   */
  async continueRemoteConfigNonInteractive(
    name: string,
    state: string,
    result: unknown,
    parameters?: Record<string, unknown>,
    opt?: Record<string, unknown>
  ): Promise<RcConfigQuestionResponse> {
    return this.invokeCommand('continue_create_remote_interactive', {
      name,
      // Send both casing variants for compatibility
      state_token: state,
      stateToken: state,
      result,
      parameters: parameters ?? {},
      opt: opt ?? {},
    });
  }
}
