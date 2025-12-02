import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
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
  private apiBaseUrl = 'http://localhost:8080/api'; // Default for headless

  /**
   * Set of commands that must be sent as HTTP POST requests.
   * All other commands will be sent as GET.
   */
  private postCommands = new Set([
    // Remote paths listing requires a JSON body in headless mode
    'get_remote_paths',
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
    'create_remote_interactive',
    'continue_create_remote_interactive',
    'update_remote',
    'delete_remote',
    'delete_remote_settings',
    'quit_rclone_oauth',
    'remove_config_password',
    'store_config_password',
    'unencrypt_config',
    'encrypt_config',
    'toggle_scheduled_task',
    'clear_all_scheduled_tasks',
    'set_bandwidth_limit',
    'start_sync',
    'start_copy',
    'start_move',
    'start_bisync',
    'stop_job',
    'delete_job',
    'start_serve',
    'stop_serve',
    'stop_all_serves',
    'handle_shutdown',
    'open_terminal_config',
    'set_config_password_env',
    'clear_config_password_env',
    'change_config_password',
    'restore_settings',
    // VFS Commands
    'vfs_forget',
    'vfs_refresh',
    'vfs_poll_interval',
    'vfs_queue_set_expiry',
    'vfs_poll_interval',
    // Filesystem Commands
    'mkdir',
    'cleanup',
    'copy_url',
  ]);

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
   * Converts an arguments object to a string-based record for HttpParams.
   */
  private toHttpParams(args: Record<string, unknown>): Record<string, string> {
    const params: Record<string, string> = {};
    Object.entries(args).forEach(([key, value]) => {
      if (value !== null && value !== undefined) {
        if (Array.isArray(value)) {
          // Note: This matches how headless.rs expects 'links'
          value.forEach(item => {
            params[key] = String(item);
          });
        } else {
          params[key] = String(value);
        }
      }
    });
    return params;
  }

  /**
   * HTTP API invocation for headless mode
   */
  private async invokeHttp<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    // Special handling for commands that should be handled locally in web mode
    if (command === 'set_theme') {
      console.log('🎨 Theme setting handled locally in web mode');
      return Promise.resolve({} as T);
    }

    if (command === 'get_system_theme') {
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = isDark ? 'dark' : 'light';
      console.log('🌙 System theme detected from browser:', theme);
      return Promise.resolve(theme as T);
    }

    if (command === 'are_updates_disabled') {
      console.log('🔄 Updates disabled for web mode (no Tauri updater)');
      return Promise.resolve(true as T);
    }

    if (command === 'get_build_type') {
      console.log('📦 Build type: web');
      return Promise.resolve('web' as T);
    }

    // Map Tauri command names to HTTP endpoints
    const endpoint = this.mapCommandToEndpoint(command);
    const isPostCommand = this.postCommands.has(command);

    if (this.isHeadlessMode) {
      console.debug(`[Headless API] ${isPostCommand ? 'POST' : 'GET'} ${endpoint}`, args);
    }

    try {
      const httpOptions: { params?: Record<string, string> } = {};

      if (!isPostCommand && args) {
        httpOptions.params = this.toHttpParams(args);
      }

      const response = await firstValueFrom(
        isPostCommand
          ? this.http.post<{ success: boolean; data: T; error?: string }>(
              `${this.apiBaseUrl}${endpoint}`,
              args || {} // Body remains as JSON object
            )
          : this.http.get<{ success: boolean; data: T; error?: string }>(
              `${this.apiBaseUrl}${endpoint}`,
              httpOptions
            )
      );

      if (response.success && response.data !== undefined) {
        return response.data;
      } else {
        throw new Error(response.error || 'Unknown error');
      }
    } catch (error: unknown) {
      // Re-throw with the error message from the API if available
      if (error instanceof HttpErrorResponse) {
        if (error.error?.error) {
          throw new Error(error.error.error);
        }
        if (error.status === 0) {
          throw new Error('API server is unreachable. Is the headless server running?');
        }
        throw new Error(error.message);
      }
      throw error;
    }
  }

  /**
   * Map Tauri command names to HTTP API endpoints.
   * This MUST match the routes defined in `src/headless.rs`.
   */
  private mapCommandToEndpoint(command: string): string {
    const commandMap: Record<string, string> = {
      // Remote operations
      get_remotes: '/remotes',
      get_cached_remotes: '/get-cached-remotes',
      get_remote_config: '/remote/:name', // Note: actual name is passed as param
      get_remote_types: '/remote-types',
      get_all_remote_configs: '/get-configs', // Maps to get_configs
      get_configs: '/get-configs',
      create_remote: '/create-remote',
      update_remote: '/update-remote',
      delete_remote: '/delete-remote',
      create_remote_interactive: '/create-remote-interactive',
      continue_create_remote_interactive: '/continue-create-remote-interactive',
      get_oauth_supported_remotes: '/get-oauth-supported-remotes',
      quit_rclone_oauth: '/quit-rclone-oauth',

      // Stats and monitoring
      get_core_stats: '/stats',
      get_core_stats_filtered: '/stats/filtered',
      get_completed_transfers: '/transfers/completed',
      get_memory_stats: '/memory-stats',
      get_bandwidth_limit: '/bandwidth/limit',
      set_bandwidth_limit: '/bandwidth/limit', // POST

      // Jobs
      get_jobs: '/jobs',
      get_active_jobs: '/jobs/active',
      get_job_status: '/jobs/:id/status', // Note: actual id is passed as param
      stop_job: '/jobs/stop',
      delete_job: '/jobs/delete',
      start_sync: '/jobs/start-sync',
      start_copy: '/jobs/start-copy',
      start_move: '/jobs/start-move',
      start_bisync: '/jobs/start-bisync',

      // Mount operations
      get_mounted_remotes: '/mounted-remotes',
      get_cached_mounted_remotes: '/get-cached-mounted-remotes',
      get_mount_types: '/mount-types',
      mount_remote: '/mount-remote',
      unmount_remote: '/unmount-remote',
      unmount_all_remotes: '/unmount-all-remotes',
      check_mount_plugin_installed: '/check-mount-plugin-installed',
      install_mount_plugin: '/install-mount-plugin',
      force_check_mounted_remotes: '/force-check-mounted-remotes',

      // VFS Operations
      vfs_list: '/vfs/list',
      vfs_forget: '/vfs/forget',
      vfs_refresh: '/vfs/refresh',
      vfs_poll_interval: '/vfs/poll-interval',
      vfs_stats: '/vfs/stats',
      vfs_queue: '/vfs/queue',
      vfs_queue_set_expiry: '/vfs/queue/set-expiry',

      // Serve operations
      list_serves: '/serve/list',
      get_cached_serves: '/get-cached-serves',
      get_serve_types: '/serve/types',
      get_serve_flags: '/serve/flags',
      start_serve: '/serve/start',
      stop_serve: '/serve/stop',
      stop_all_serves: '/serve/stop-all',
      force_check_serves: '/force-check-serves',

      // System info
      get_rclone_info: '/rclone-info',
      get_rclone_pid: '/rclone-pid',
      get_rclone_rc_url: '/get-rclone-rc-url',
      get_disk_usage: '/disk-usage',
      kill_process_by_pid: '/kill-process-by-pid',
      check_rclone_available: '/check-rclone-available',
      is_7z_available: '/is-7z-available',
      provision_rclone: '/provision-rclone',

      // Settings
      get_settings: '/settings',
      load_settings: '/settings/load',
      save_setting: '/save-setting',
      reset_setting: '/reset-setting',
      save_remote_settings: '/save-remote-settings',
      delete_remote_settings: '/delete-remote-settings',
      get_remote_settings: '/get-remote-settings',

      // RClone Backend Options
      load_rclone_backend_options: '/load-rclone-backend-options',
      save_rclone_backend_options: '/save-rclone-backend-options',
      save_rclone_backend_option: '/save-rclone-backend-option',
      reset_rclone_backend_options: '/reset-rclone-backend-options',
      get_rclone_backend_store_path: '/get-rclone-backend-store-path',
      remove_rclone_backend_option: '/remove-rclone-backend-option',

      // Filesystem
      get_fs_info: '/fs/info',
      get_local_drives: '/get-local-drives',
      get_size: '/get-size',
      mkdir: '/mkdir',
      cleanup: '/cleanup',
      copy_url: '/copy-url',
      get_remote_paths: '/remote/paths',
      get_folder_location: '/get-folder-location', // Note: Will fail in headless
      get_file_location: '/get-file-location', // Note: Will fail in headless
      open_in_files: '/open-in-files', // Note: Will fail in headless
      open_terminal_config: '/open-terminal-config', // Note: Will fail in headless

      // Flags and options
      get_option_blocks: '/options/blocks',
      get_all_options_info: '/options/info',
      get_grouped_options_with_values: '/get-grouped-options-with-values',
      set_rclone_option: '/set-rclone-option',
      get_flags_by_category: '/flags/category',
      get_copy_flags: '/flags/copy',
      get_sync_flags: '/flags/sync',
      get_mount_flags: '/flags/mount',
      get_vfs_flags: '/flags/vfs',
      get_filter_flags: '/flags/filter',
      get_backend_flags: '/flags/backend',
      get_rclone_config_file: '/get-rclone-config-file',

      // Network
      check_links: '/check-links',
      is_network_metered: '/is-network-metered',

      // App Updates (Tauri)
      fetch_update: '/fetch-update', // Note: Mapped, but are_updates_disabled handles it
      get_download_status: '/get-download-status',
      install_update: '/install-update',

      // Rclone Updates
      check_rclone_update: '/check-rclone-update',
      update_rclone: '/update-rclone',

      // Scheduled Tasks
      reload_scheduled_tasks_from_configs: '/reload-scheduled-tasks-from-configs',
      get_scheduled_tasks: '/get-scheduled-tasks',
      get_scheduled_task: '/get-scheduled-task',
      toggle_scheduled_task: '/toggle-scheduled-task',
      get_scheduled_tasks_stats: '/get-scheduled-tasks-stats',
      validate_cron: '/validate-cron',
      reload_scheduled_tasks: '/reload-scheduled-tasks',
      clear_all_scheduled_tasks: '/clear-all-scheduled-tasks',

      // Security & Password
      get_cached_encryption_status: '/get-cached-encryption-status',
      has_stored_password: '/has-stored-password',
      is_config_encrypted_cached: '/is-config-encrypted-cached',
      is_config_encrypted: '/is-config-encrypted',
      has_config_password_env: '/has-config-password-env',
      remove_config_password: '/remove-config-password',
      validate_rclone_password: '/validate-rclone-password',
      store_config_password: '/store-config-password',
      unencrypt_config: '/unencrypt-config',
      encrypt_config: '/encrypt-config',
      change_config_password: '/change-config-password',
      get_config_password: '/get-config-password',
      set_config_password_env: '/set-config-password-env',
      clear_config_password_env: '/clear-config-password-env',
      clear_encryption_cache: '/clear-encryption-cache',

      // Backup & Restore
      backup_settings: '/backup-settings',
      restore_settings: '/restore-settings',
      analyze_backup_file: '/analyze-backup-file',

      // Logs
      get_remote_logs: '/get-remote-logs',
      clear_remote_logs: '/clear-remote-logs',

      // App Lifecycle
      handle_shutdown: '/handle-shutdown',
    };

    const mapped = commandMap[command];
    if (!mapped) {
      console.warn(`[Headless API] No endpoint map found for command: ${command}. Using default.`);
      // Fallback: convert snake_case to kebab-case
      return `/${command.replace(/_/g, '-')}`;
    }
    return mapped;
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
