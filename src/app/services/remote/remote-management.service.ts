import { Injectable } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { RemoteProvider, ConfigRecord, RcConfigQuestionResponse, LocalDrive } from '@app/types';

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

  async getRemoteConfigFields(type: string): Promise<any[]> {
    const response = await this.invokeCommand<any>('get_remote_types');

    // Response can be either { [category]: Provider[] } or { providers: Provider[] }
    let providers: any[] = [];
    if (response && response.providers && Array.isArray(response.providers)) {
      providers = response.providers;
    } else if (response && typeof response === 'object') {
      providers = Object.values(response).flat() as any[];
    }

    const match = providers.find(p => p && p.Name === type);
    return Array.isArray(match?.Options) ? match.Options : [];
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

  async createRemote(
    name: string,
    parameters: ConfigRecord,
    opt?: Record<string, unknown>
  ): Promise<void> {
    await this.invokeWithNotification(
      'create_remote',
      { name, parameters, opt },
      {
        successKey: 'remotes.createSuccess',
        errorKey: 'remotes.createError',
      }
    );
  }

  /**
   * Update an existing remote
   */
  async updateRemote(
    name: string,
    parameters: ConfigRecord,
    opt?: Record<string, unknown>
  ): Promise<void> {
    await this.invokeWithNotification(
      'update_remote',
      { name, parameters, opt },
      {
        successKey: 'remotes.updateSuccess',
        errorKey: 'remotes.updateError',
      }
    );
  }

  /**
   * Delete a remote
   */
  async deleteRemote(name: string): Promise<void> {
    const confirmed = await this.notificationService.confirmModal(
      this.translate.instant('remotes.deleteConfirm.title'),
      this.translate.instant('remotes.deleteConfirm.message', { name }),
      this.translate.instant('common.delete'),
      this.translate.instant('common.cancel'),
      { confirmButtonColor: 'warn', icon: 'delete' }
    );

    if (!confirmed) return;

    await this.invokeWithNotification(
      'delete_remote',
      { name },
      {
        successKey: 'remotes.deleteSuccess',
        errorKey: 'remotes.deleteError',
      }
    );

    // Also cleanup settings silently
    await this.invokeCommand('delete_remote_settings', { remoteName: name }).catch(() => {
      this.notificationService.showError(this.translate.instant('remotes.deleteSettingsError'));
    });
  }

  /**
   * Quit OAuth process
   */
  async quitOAuth(): Promise<void> {
    return this.invokeCommand('quit_rclone_oauth');
  }

  async getLocalDrives(): Promise<LocalDrive[]> {
    return this.invokeCommand<LocalDrive[]>('get_local_drives');
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
