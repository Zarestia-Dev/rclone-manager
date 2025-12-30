/**
 * EXPLICIT endpoint mappings for headless mode.
 *
 * Only contains endpoints that DON'T follow the standard auto-derivation pattern.
 * Standard pattern: command_name -> /command-name
 *
 * If an endpoint follows the standard pattern, it doesn't need to be listed here.
 * The api-client.service.ts will auto-derive it.
 */
export const EXPLICIT_ENDPOINTS: Record<string, string> = {
  // Remote operations - shortened/nested routes
  get_remotes: '/remotes',
  get_remote_config: '/remote/:name',
  get_remote_types: '/remote-types',
  get_all_remote_configs: '/get-configs',
  get_configs: '/get-configs',

  // Stats - shortened/nested routes
  get_core_stats: '/stats',
  get_core_stats_filtered: '/stats/filtered',
  get_completed_transfers: '/transfers/completed',
  get_memory_stats: '/memory-stats',
  get_bandwidth_limit: '/bandwidth/limit',
  set_bandwidth_limit: '/bandwidth/limit',

  // Jobs - nested under /jobs
  get_jobs: '/jobs',
  get_active_jobs: '/jobs/active',
  get_job_status: '/jobs/:id/status',
  get_jobs_by_source: '/jobs/by-source',
  stop_job: '/jobs/stop',
  delete_job: '/jobs/delete',
  start_sync_profile: '/jobs/start-sync-profile',
  start_copy_profile: '/jobs/start-copy-profile',
  start_move_profile: '/jobs/start-move-profile',
  start_bisync_profile: '/jobs/start-bisync-profile',

  // Mount operations - shortened
  get_mounted_remotes: '/mounted-remotes',
  get_mount_types: '/mount-types',

  // VFS - nested under /vfs
  vfs_list: '/vfs/list',
  vfs_forget: '/vfs/forget',
  vfs_refresh: '/vfs/refresh',
  vfs_poll_interval: '/vfs/poll-interval',
  vfs_stats: '/vfs/stats',
  vfs_queue: '/vfs/queue',
  vfs_queue_set_expiry: '/vfs/queue/set-expiry',

  // Serve - nested under /serve
  list_serves: '/serve/list',
  get_serve_types: '/serve/types',
  get_serve_flags: '/serve/flags',
  start_serve_profile: '/serve/start-profile',
  stop_serve: '/serve/stop',
  stop_all_serves: '/serve/stop-all',

  // System - shortened
  get_rclone_info: '/rclone-info',
  get_rclone_pid: '/rclone-pid',
  get_disk_usage: '/disk-usage',

  // Settings - shortened/nested
  get_settings: '/settings',
  load_settings: '/settings/load',

  // Filesystem - nested
  get_fs_info: '/fs/info',
  get_remote_paths: '/remote/paths',
  convert_file_src: '/convert-asset-src',

  // Flags - nested under /flags or /options
  get_option_blocks: '/options/blocks',
  get_all_options_info: '/options/info',
  get_flags_by_category: '/flags/category',
  get_copy_flags: '/flags/copy',
  get_sync_flags: '/flags/sync',
  get_bisync_flags: '/flags/bisync',
  get_move_flags: '/flags/move',
  get_mount_flags: '/flags/mount',
  get_vfs_flags: '/flags/vfs',
  get_filter_flags: '/flags/filter',
  get_backend_flags: '/flags/backend',
};

/**
 * Set of commands that must be sent as HTTP POST requests.
 * All other commands will be sent as GET.
 */
export const POST_COMMANDS = new Set([
  // Remote paths listing requires a JSON body in headless mode
  'get_remote_paths',
  'save_setting',
  'reset_setting',
  'reset_settings',
  'save_remote_settings',
  'reload_scheduled_tasks_from_configs',
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
  // Profile-based commands
  'start_sync_profile',
  'start_copy_profile',
  'start_move_profile',
  'start_bisync_profile',
  'mount_remote_profile',
  'start_serve_profile',
  'stop_job',
  'delete_job',
  'stop_serve',
  'stop_all_serves',
  'handle_shutdown',
  'set_config_password_env',
  'clear_config_password_env',
  'change_config_password',
  'restore_settings',
  'install_update',
  'relaunch_app',
  // VFS Commands
  'vfs_forget',
  'vfs_refresh',
  'vfs_poll_interval',
  'vfs_queue_set_expiry',
  // Filesystem Commands
  'mkdir',
  'cleanup',
  'copy_url',
  // Backend Commands
  'add_backend',
  'update_backend',
  'remove_backend',
  'switch_backend',
  'test_backend_connection',
  'force_check_serves',
  'save_rclone_backend_options',
  'reset_rclone_backend_options',
]);
