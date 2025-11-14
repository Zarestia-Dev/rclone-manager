import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { invoke } from '@tauri-apps/api/core';
import { firstValueFrom } from 'rxjs';

/**
 * Environment detection and API communication service
 * Automatically detects whether running in Tauri (desktop) or headless (web) mode
 * and routes API calls accordingly
 */
@Injectable({
  providedIn: 'root',
})
export class ApiClientService {
  private http = inject(HttpClient);
  private isHeadlessMode: boolean;
  private apiBaseUrl = 'http://localhost:8080/api';

  constructor() {
    // Check if we're running in Tauri environment
    this.isHeadlessMode = !(window as Window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__;

    if (this.isHeadlessMode) {
      console.log('🌐 Running in headless web mode - using HTTP API');
    } else {
      console.log('🖥️  Running in Tauri desktop mode - using Tauri commands');
    }
  }

  /**
   * Invoke a command - automatically routes to Tauri or HTTP API
   */
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (this.isHeadlessMode) {
      // Use HTTP API
      return this.invokeHttp<T>(command, args);
    } else {
      // Use Tauri invoke
      return invoke<T>(command, args || {});
    }
  }

  /**
   * HTTP API invocation for headless mode
   */
  private async invokeHttp<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    // Special handling for commands that should be handled locally in web mode
    if (command === 'set_theme') {
      // For web mode, theme setting is handled entirely in the frontend
      // The backend set_theme command is for Tauri window theming only
      console.log('🎨 Theme setting handled locally in web mode');
      return Promise.resolve({} as T);
    }

    if (command === 'get_system_theme') {
      // For web mode, get system theme from browser's prefers-color-scheme
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = isDark ? 'dark' : 'light';
      console.log('🌙 System theme detected from browser:', theme);
      return Promise.resolve(theme as T);
    }

    if (command === 'are_updates_disabled') {
      // For web mode, updates are always "disabled" since web apps don't use Tauri's updater
      console.log('🔄 Updates disabled for web mode (no Tauri updater)');
      return Promise.resolve(true as T);
    }

    if (command === 'get_build_type') {
      // For web mode, return "web" to indicate this is a web build
      console.log('📦 Build type: web');
      return Promise.resolve('web' as T);
    }

    // Map Tauri command names to HTTP endpoints
    const endpoint = this.mapCommandToEndpoint(command);

    // Commands that need POST with JSON body
    const postCommands = new Set([
      'save_setting',
      'reset_setting',
      'save_remote_settings',
      'reload_scheduled_tasks_from_configs',
      'mount_remote',
      'unmount_remote',
      'save_rclone_backend_option',
      'set_rclone_option',
      'remove_rclone_backend_option',
      'create_remote',
      'quit_rclone_oauth',
      'toggle_scheduled_task',
      'remove_config_password',
      'store_config_password',
      'unencrypt_config',
      'encrypt_config',
    ]);
    const isPostCommand = postCommands.has(command);

    try {
      const response = await firstValueFrom(
        isPostCommand
          ? this.http.post<{ success: boolean; data: T; error?: string }>(
              `${this.apiBaseUrl}${endpoint}`,
              args || {}
            )
          : this.http.get<{ success: boolean; data: T; error?: string }>(
              `${this.apiBaseUrl}${endpoint}`,
              {
                params: args as Record<string, string | number | boolean>,
              }
            )
      );

      if (response.success && response.data !== undefined) {
        return response.data;
      } else {
        throw new Error(response.error || 'Unknown error');
      }
    } catch (error: unknown) {
      // Re-throw with the error message from the API if available
      if (error && typeof error === 'object' && 'error' in error) {
        const apiError = error as { error?: { error?: string } };
        if (apiError.error?.error) {
          throw new Error(apiError.error.error);
        }
      }
      throw error;
    }
  }

  /**
   * Map Tauri command names to HTTP API endpoints
   */
  private mapCommandToEndpoint(command: string): string {
    const commandMap: Record<string, string> = {
      // Remote operations
      get_remotes: '/remotes',
      get_remote_config: '/remote/:name',
      get_remote_types: '/remote-types',
      get_all_remote_configs: '/remotes/all',

      // Stats and monitoring
      get_core_stats: '/stats',
      get_core_stats_filtered: '/stats/filtered',
      get_job_stats: '/jobs/stats',
      get_completed_transfers: '/transfers/completed',

      // Jobs
      get_jobs: '/jobs',
      get_active_jobs: '/jobs/active',
      get_job_status: '/jobs/:id/status',

      // Mount operations
      get_mounted_remotes: '/mounted-remotes',
      get_mount_types: '/mount-types',

      // System info
      get_rclone_info: '/rclone-info',
      get_rclone_pid: '/rclone-pid',
      get_memory_stats: '/memory-stats',
      get_disk_usage: '/disk-usage',

      // Settings
      get_settings: '/settings',
      load_settings: '/settings/load',
      save_setting: '/save-setting',
      reset_setting: '/reset-setting',
      save_remote_settings: '/save-remote-settings',

      // Filesystem
      get_fs_info: '/fs/info',
      get_remote_paths: '/remote/paths',

      // Flags and options
      get_flags_by_category: '/flags/category',
      get_copy_flags: '/flags/copy',
      get_sync_flags: '/flags/sync',
      get_mount_flags: '/flags/mount',
      get_vfs_flags: '/flags/vfs',
      get_filter_flags: '/flags/filter',
      get_backend_flags: '/flags/backend',

      // Bandwidth
      get_bandwidth_limit: '/bandwidth/limit',
      get_grouped_options_with_values: '/get-grouped-options-with-values',
      get_oauth_supported_remotes: '/get-oauth-supported-remotes',
      get_cached_remotes: '/get-cached-remotes',
      create_remote: '/create-remote',
      quit_rclone_oauth: '/quit-rclone-oauth',
      toggle_scheduled_task: '/toggle-scheduled-task',
      get_scheduled_tasks_stats: '/get-scheduled-tasks-stats',
      get_cached_encryption_status: '/get-cached-encryption-status',
      has_stored_password: '/has-stored-password',
      is_config_encrypted_cached: '/is-config-encrypted-cached',
      has_config_password_env: '/has-config-password-env',
      remove_config_password: '/remove-config-password',
      validate_rclone_password: '/validate-rclone-password',
      store_config_password: '/store-config-password',
      unencrypt_config: '/unencrypt-config',
      encrypt_config: '/encrypt-config',
    };

    return commandMap[command] || `/${command.replace(/_/g, '-')}`;
  }

  /**
   * Check if running in headless mode
   */
  isHeadless(): boolean {
    return this.isHeadlessMode;
  }

  /**
   * Get the API base URL (for headless mode)
   */
  getApiBaseUrl(): string {
    return this.apiBaseUrl;
  }

  /**
   * Set custom API base URL (useful for Docker/different ports)
   */
  setApiBaseUrl(url: string): void {
    this.apiBaseUrl = url;
  }
}
