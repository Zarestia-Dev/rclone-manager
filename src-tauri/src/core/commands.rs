//! Tauri Command Registration
//!
//! This module contains the master list of all commands in the application.
//! We use a macro-based system to automatically generate both the Tauri
//! invoke handler and the HTTP bridge for the web server.

/// The Master Macro that defines every command in the system.
/// Format: (`name_for_bridge`, `function_path`, [`arguments_for_bridge`])
///
/// Note: `AppHandle` is automatically injected and should not be listed in arguments.
#[macro_export]
macro_rules! MASTER_COMMAND_LIST {
    ($action:ident) => {
        $action! {
            // =================================================================
            // FILE OPERATIONS (Utils)
            // =================================================================
            // File Picker / System Interaction (Desktop Only)
            #[cfg(not(feature = "web-server"))]
            (open_in_files, $crate::utils::io::file_helper::open_in_files, [path: std::path::PathBuf]);
            #[cfg(not(feature = "web-server"))]
            (get_folder_location, $crate::utils::io::file_helper::get_folder_location, [require_empty: bool]);
            #[cfg(not(feature = "web-server"))]
            (get_file_location, $crate::utils::io::file_helper::get_file_location, []);
            (get_audio_cover, $crate::utils::app::audio::get_audio_cover, [remote: String, path: String, is_local: bool]);

            // =================================================================
            // UI & THEME
            // =================================================================
            // UI / Theming (Desktop Only)
            #[cfg(not(feature = "web-server"))]
            (set_theme, $crate::utils::app::ui::set_theme, [theme: String]);
            #[cfg(not(feature = "web-server"))]
            (get_system_theme, $crate::utils::app::ui::get_system_theme, [], [sync, no_app, infallible]);
            (get_i18n, $crate::utils::i18n::get_i18n, [lang: String], [sync, no_app]);
            (get_rclone_rc_url, $crate::rclone::queries::get_rclone_rc_url, []);

            // =================================================================
            // PLATFORM
            // =================================================================
            (get_build_type, $crate::utils::app::platform::get_build_type, [], [sync, no_app, infallible]);
            (relaunch_app, $crate::utils::app::platform::relaunch_app, []);

            // =================================================================
            // RCLONE OPERATIONS
            // =================================================================
            (provision_rclone, $crate::utils::rclone::provision::provision_rclone, [path: Option<String>]);
            (get_rclone_info, $crate::rclone::queries::get_rclone_info, []);
            (get_rclone_pid, $crate::rclone::queries::get_rclone_pid, []);
            (check_rclone_update, $crate::utils::rclone::updater::check_rclone_update, [channel: Option<String>]);
            (get_rclone_update_info, $crate::utils::rclone::updater::get_rclone_update_info, []);
            (update_rclone, $crate::utils::rclone::updater::update_rclone, [channel: Option<String>]);
            (apply_rclone_update, $crate::utils::rclone::updater::apply_rclone_update, []);
            (kill_process_by_pid, $crate::utils::process::process_manager::kill_process_by_pid, [pid: u32], [sync, no_app]);

            // =================================================================
            // RCLONE QUERIES
            // =================================================================
            (get_stats, $crate::rclone::queries::get_stats, [group: Option<String>]);
            (get_completed_transfers, $crate::rclone::queries::get_completed_transfers, [group: Option<String>]);
            (get_fs_info, $crate::rclone::queries::get_fs_info, [remote: String, path: Option<String>, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (get_disk_usage, $crate::rclone::queries::get_disk_usage, [remote: String, path: Option<String>, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (get_about_remote, $crate::rclone::queries::get_about_remote, [remote: String, path: Option<String>, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (get_size, $crate::rclone::queries::get_size, [remote: String, path: Option<String>, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (get_stat, $crate::rclone::queries::get_stat, [remote: String, path: String, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (get_hashsum, $crate::rclone::queries::get_hashsum, [remote: String, path: String, hash_type: String, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (get_hashsum_file, $crate::rclone::queries::get_hashsum_file, [remote: String, path: String, hash_type: String, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (get_public_link, $crate::rclone::queries::get_public_link, [remote: String, path: String, options: Option<$crate::rclone::queries::filesystem::PublicLinkParams>, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (get_memory_stats, $crate::rclone::queries::get_memory_stats, []);
            (get_local_disk_usage, $crate::rclone::queries::system::get_local_disk_usage, [dir: Option<String>]);
            (get_remote_types, $crate::rclone::queries::get_remote_types, []);
            (get_oauth_supported_remotes, $crate::rclone::queries::get_oauth_supported_remotes, []);
            (get_rclone_config_file, $crate::rclone::queries::get_rclone_config_file, []);
            (set_bandwidth_limit, $crate::rclone::commands::system::set_bandwidth_limit, [rate: Option<String>]);

            // =================================================================
            // SYNC OPERATIONS
            // =================================================================
            (start_profile_batch, $crate::rclone::commands::sync::start_profile_batch, [items: Vec<$crate::utils::types::remotes::ProfileParams>, transfer_type: $crate::rclone::commands::sync::TransferType]);

            // =================================================================
            // MOUNT OPERATIONS
            // =================================================================
            (mount_remote_profile, $crate::rclone::commands::mount::mount_remote_profile, [params: $crate::utils::types::remotes::ProfileParams]);
            (unmount_remote, $crate::rclone::commands::mount::unmount_remote, [mount_point: String, remote_name: String]);
            (unmount_all_remotes, $crate::rclone::commands::mount::unmount_all_remotes, [context: String]);
            (get_mount_types, $crate::rclone::queries::get_mount_types, []);

            // =================================================================
            // VFS COMMANDS
            // =================================================================
            (vfs_forget, $crate::rclone::queries::vfs_forget, [fs: Option<String>, file: Option<String>]);
            (vfs_list, $crate::rclone::queries::vfs_list, []);
            (vfs_poll_interval, $crate::rclone::queries::vfs_poll_interval, [fs: Option<String>, interval: Option<String>, timeout: Option<String>]);
            (vfs_refresh, $crate::rclone::queries::vfs_refresh, [fs: Option<String>, dir: Option<String>, recursive: bool]);
            (vfs_stats, $crate::rclone::queries::vfs_stats, [fs: Option<String>]);
            (vfs_queue, $crate::rclone::queries::vfs_queue, [fs: Option<String>]);
            (vfs_queue_set_expiry, $crate::rclone::queries::vfs_queue_set_expiry, [fs: Option<String>, id: u64, expiry: f64, relative: bool]);

            // =================================================================
            // SERVE OPERATIONS
            // =================================================================
            (start_serve_profile, $crate::rclone::commands::serve::start_serve_profile, [params: $crate::utils::types::remotes::ProfileParams]);
            (stop_serve, $crate::rclone::commands::serve::stop_serve, [id: String, remote_name: String]);
            (stop_all_serves, $crate::rclone::commands::serve::stop_all_serves, [context: String]);
            (get_serve_types, $crate::rclone::queries::get_serve_types, []);
            (get_serve_flags, $crate::rclone::queries::flags::get_serve_flags, [serve_type: Option<String>]);
            (list_serves, $crate::rclone::queries::list_serves, []);

            // =================================================================
            // REMOTE MANAGEMENT
            // =================================================================
            (create_remote_interactive, $crate::rclone::commands::remote::create_remote_interactive, [name: String, rclone_type: String, parameters: Option<std::collections::HashMap<String, serde_json::Value>>, opt: Option<serde_json::Value>]);
            (continue_create_remote_interactive, $crate::rclone::commands::remote::continue_create_remote_interactive, [name: String, state_token: String, result: serde_json::Value, parameters: Option<std::collections::HashMap<String, serde_json::Value>>, opt: Option<serde_json::Value>]);
            (create_remote, $crate::rclone::commands::remote::create_remote, [name: String, parameters: std::collections::HashMap<String, serde_json::Value>, opt: Option<serde_json::Value>]);
            (update_remote, $crate::rclone::commands::remote::update_remote, [name: String, parameters: std::collections::HashMap<String, serde_json::Value>, opt: Option<serde_json::Value>]);
            (delete_remote, $crate::rclone::commands::remote::delete_remote, [name: String]);
            (quit_rclone_engine, $crate::rclone::commands::system::quit_rclone_engine, []);
            (quit_rclone_oauth, $crate::rclone::commands::system::quit_rclone_oauth, []);
            (get_remote_paths, $crate::rclone::queries::get_remote_paths, [remote: String, path: Option<String>, options: Option<$crate::utils::types::remotes::ListOptions>, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (run_garbage_collector, $crate::rclone::commands::system::run_garbage_collector, []);
            (get_fscache_entries, $crate::rclone::commands::system::get_fscache_entries, []);
            (clear_fscache, $crate::rclone::commands::system::clear_fscache, []);

            // =================================================================
            // FILESYSTEM COMMANDS
            // =================================================================
            (mkdir, $crate::rclone::commands::filesystem::mkdir, [remote: String, path: String, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (cleanup, $crate::rclone::commands::filesystem::cleanup, [remote: String, path: Option<String>, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (transfer, $crate::rclone::commands::filesystem::transfer, [items: Vec<$crate::rclone::commands::filesystem::FsItem>, dst_remote: String, dst_path: String, mode: String, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (delete, $crate::rclone::commands::filesystem::delete, [items: Vec<$crate::rclone::commands::filesystem::FsItem>, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (rename, $crate::rclone::commands::filesystem::rename, [items: Vec<$crate::rclone::commands::filesystem::RenameItem>, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (copy_url, $crate::rclone::commands::filesystem::copy_url, [remote: String, path: String, url_to_copy: String, auto_filename: bool, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (upload_file, $crate::rclone::commands::filesystem::upload_file, [remote: String, path: String, filename: String, content: String]);
            (upload_file_bytes, $crate::rclone::commands::filesystem::upload_file_bytes, [remote: String, path: String, filename: String, content: Vec<u8>]);
            (upload_local_drop_files, $crate::rclone::commands::filesystem::upload_local_drop_files, [remote: String, path: String, files: Vec<$crate::rclone::commands::filesystem::LocalDropUploadFile>, origin: Option<$crate::utils::types::origin::Origin>]);
            (upload_local_drop_paths, $crate::rclone::commands::filesystem::upload_local_drop_paths, [remote: String, path: String, paths: Vec<String>, origin: Option<$crate::utils::types::origin::Origin>]);
            (remove_empty_dirs, $crate::rclone::commands::filesystem::remove_empty_dirs, [remote: String, path: String, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (get_local_drives, $crate::rclone::queries::get_local_drives, []);
            (get_bandwidth_limit, $crate::rclone::queries::get_bandwidth_limit, []);

            // =================================================================
            // FLAGS & OPTIONS
            // =================================================================
            (get_option_blocks, $crate::rclone::queries::flags::get_option_blocks, []);
            (get_flags_by_category, $crate::rclone::queries::flags::get_flags_by_category, [category: String, filter_groups: Option<Vec<String>>, exclude_flags: Option<Vec<String>>]);
            (get_copy_flags, $crate::rclone::queries::flags::get_copy_flags, []);
            (get_sync_flags, $crate::rclone::queries::flags::get_sync_flags, []);
            (get_bisync_flags, $crate::rclone::queries::flags::get_bisync_flags, []);
            (get_move_flags, $crate::rclone::queries::flags::get_move_flags, []);
            (get_filter_flags, $crate::rclone::queries::flags::get_filter_flags, []);
            (get_vfs_flags, $crate::rclone::queries::flags::get_vfs_flags, []);
            (get_mount_flags, $crate::rclone::queries::flags::get_mount_flags, []);
            (get_backend_flags, $crate::rclone::queries::flags::get_backend_flags, []);
            (get_grouped_options_with_values, $crate::rclone::queries::flags::get_grouped_options_with_values, []);
            (set_rclone_option, $crate::rclone::queries::flags::set_rclone_option, [block_name: String, option_name: String, value: serde_json::Value]);

            // =================================================================
            // SETTINGS
            // =================================================================
            (load_settings, $crate::core::settings::operations::core::load_settings, []);
            (save_setting, $crate::core::settings::operations::core::save_setting, [category: String, key: String, value: serde_json::Value]);
            (reset_settings, $crate::core::settings::operations::core::reset_settings, []);
            (reset_setting, $crate::core::settings::operations::core::reset_setting, [category: String, key: String]);

            // =================================================================
            // RCLONE BACKEND SETTINGS
            // =================================================================
            (load_rclone_backend_options, $crate::core::settings::rclone_backend::load_rclone_backend_options, []);
            (save_rclone_backend_options, $crate::core::settings::rclone_backend::save_rclone_backend_options, [options: serde_json::Value]);
            (save_rclone_backend_option, $crate::core::settings::rclone_backend::save_rclone_backend_option, [block: String, option: String, value: serde_json::Value]);
            (reset_rclone_backend_options, $crate::core::settings::rclone_backend::reset_rclone_backend_options, []);
            (get_rclone_backend_store_path, $crate::core::settings::rclone_backend::get_rclone_backend_store_path, []);
            (remove_rclone_backend_option, $crate::core::settings::rclone_backend::remove_rclone_backend_option, [block: String, option: String]);

            // =================================================================
            // REMOTE SETTINGS
            // =================================================================
            (save_remote_settings, $crate::core::settings::remote::manager::save_remote_settings, [remote_name: String, settings: serde_json::Value]);
            (get_remote_settings, $crate::core::settings::remote::manager::get_remote_settings, [remote_name: String]);
            (delete_remote_settings, $crate::core::settings::remote::manager::delete_remote_settings, [remote_name: String]);

            // =================================================================
            // BACKUP & RESTORE
            // =================================================================
            (backup_settings, $crate::core::settings::backup::backup_manager::backup_settings, [backup_dir: String, export_type: $crate::utils::types::backup_types::ExportType, password: Option<String>, remote_name: Option<String>, user_note: Option<String>, include_profiles: Option<Vec<String>>]);
            (analyze_backup_file, $crate::core::settings::backup::backup_manager::analyze_backup_file, [path: std::path::PathBuf]);
            (restore_settings, $crate::core::settings::backup::restore_manager::restore_settings, [backup_path: std::path::PathBuf, password: Option<String>, restore_profile: Option<String>, restore_profile_as: Option<String>]);
            (get_export_categories, $crate::core::settings::backup::export_categories::get_export_categories, []);

            // =================================================================
            // NETWORK
            // =================================================================
            (check_links, $crate::utils::io::network::check_links, [links: Vec<String>, max_retries: usize, retry_delay_secs: u64], [no_app]);
            (is_network_metered, $crate::utils::io::network::is_network_metered, [], [no_app]);

            // =================================================================
            // MOUNT PLUGIN
            // =================================================================
            (check_mount_plugin_installed, $crate::utils::rclone::mount::check_mount_plugin_installed, [], [no_app]);
            (install_mount_plugin, $crate::utils::rclone::mount::install_mount_plugin, [], [no_app]);

            // =================================================================
            // CACHE
            // =================================================================
            (get_cached_remotes, $crate::rclone::state::cache::get_cached_remotes, []);
            (get_configs, $crate::rclone::state::cache::get_configs, []);
            (get_settings, $crate::rclone::state::cache::get_settings, []);
            (get_cached_mounted_remotes, $crate::rclone::state::cache::get_cached_mounted_remotes, []);
            (get_cached_serves, $crate::rclone::state::cache::get_cached_serves, []);
            (rename_mount_profile_in_cache, $crate::rclone::state::cache::rename_mount_profile_in_cache, [remote_name: String, old_name: String, new_name: String]);
            (rename_serve_profile_in_cache, $crate::rclone::state::cache::rename_serve_profile_in_cache, [remote_name: String, old_name: String, new_name: String]);

            // =================================================================
            // BINARIES
            // =================================================================
            (check_rclone_available, $crate::core::check_binaries::check_rclone_available, [path: String]);

            // =================================================================
            // LOGS
            // =================================================================
            (get_remote_logs, $crate::rclone::state::log::get_remote_logs, [remote_name: Option<String>]);
            (clear_remote_logs, $crate::rclone::state::log::clear_remote_logs, [remote_name: Option<String>]);

            // =================================================================
            // JOBS
            // =================================================================
            (get_jobs, $crate::rclone::commands::job::get_jobs, []);
            (get_active_jobs, $crate::rclone::commands::job::get_active_jobs, []);
            (get_job_status, $crate::rclone::commands::job::get_job_status, [jobid: u64]);
            (submit_batch_job, $crate::rclone::commands::job::submit_batch_job, [inputs: Vec<serde_json::Value>, metadata_list: Option<Vec<$crate::rclone::commands::job::JobMetadata>>, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>, job_type: $crate::utils::types::jobs::JobType]);
            (stop_job, $crate::rclone::commands::job::stop_job, [jobid: u64, remote_name: String]);
            (delete_job, $crate::rclone::commands::job::delete_job, [jobid: u64]);
            (stop_jobs_by_group, $crate::rclone::commands::job::stop_jobs_by_group, [group: String]);

            // =================================================================
            // STATS GROUP MANAGEMENT
            // =================================================================
            (get_stats_groups, $crate::rclone::commands::system::get_stats_groups, []);
            (reset_group_stats, $crate::rclone::commands::system::reset_group_stats, [group: Option<String>]);
            (delete_stats_group, $crate::rclone::commands::system::delete_stats_group, [group: String]);

            // =================================================================
            // BACKEND MANAGEMENT
            // =================================================================
            (get_backend_schema, $crate::rclone::commands::backend::get_backend_schema, [], [no_app]);
            (list_backends, $crate::rclone::commands::backend::list_backends, []);
            (get_active_backend, $crate::rclone::commands::backend::get_active_backend, []);
            (get_backend_profiles, $crate::rclone::commands::backend::get_backend_profiles, []);
            (switch_backend, $crate::rclone::commands::backend::switch_backend, [name: String]);
            (add_backend, $crate::rclone::commands::backend::add_backend, [params: $crate::rclone::commands::backend::AddBackendParams]);
            (update_backend, $crate::rclone::commands::backend::update_backend, [params: $crate::rclone::commands::backend::UpdateBackendParams]);
            (remove_backend, $crate::rclone::commands::backend::remove_backend, [name: String]);
            (test_backend_connection, $crate::rclone::commands::backend::test_backend_connection, [name: String]);

            // =================================================================
            // SCHEDULED TASKS
            // =================================================================
            (get_scheduled_tasks, $crate::rclone::state::scheduled_tasks::get_scheduled_tasks, []);
            (get_scheduled_task, $crate::rclone::state::scheduled_tasks::get_scheduled_task, [id: String]);
            (get_scheduled_tasks_stats, $crate::rclone::state::scheduled_tasks::get_scheduled_tasks_stats, []);
            (toggle_scheduled_task, $crate::core::scheduler::commands::toggle_scheduled_task, [id: String]);
            (validate_cron, $crate::core::scheduler::commands::validate_cron, [cron_expression: String], [no_app]);
            (reload_scheduled_tasks, $crate::core::scheduler::commands::reload_scheduled_tasks, []);
            (reload_scheduled_tasks_from_configs, $crate::core::scheduler::commands::reload_scheduled_tasks_from_configs, [all_settings: serde_json::Value]);
            (clear_all_scheduled_tasks, $crate::core::scheduler::commands::clear_all_scheduled_tasks, []);

            // =================================================================
            // WATCHERS
            // =================================================================
            (force_check_mounted_remotes, $crate::rclone::state::watcher::force_check_mounted_remotes, []);
            (force_check_serves, $crate::rclone::state::watcher::force_check_serves, []);

            // =================================================================
            // APPLICATION CONTROL
            // =================================================================
            (shutdown_app, $crate::core::lifecycle::shutdown::shutdown_app, []);

            // =================================================================
            // SECURITY & PASSWORD MANAGEMENT
            // =================================================================
            (store_config_password, $crate::core::security::store_config_password, [password: String]);
            (get_config_password, $crate::core::security::get_config_password, []);
            (has_stored_password, $crate::core::security::has_stored_password, []);
            (remove_config_password, $crate::core::security::remove_config_password, []);
            (validate_rclone_password, $crate::core::security::validate_rclone_password, [password: String]);
            (is_config_encrypted, $crate::core::security::is_config_encrypted, []);
            (encrypt_config, $crate::core::security::encrypt_config, [password: String]);
            (unencrypt_config, $crate::core::security::unencrypt_config, [password: String]);
            (change_config_password, $crate::core::security::change_config_password, [old_password: String, new_password: String]);
            (set_config_password_env, $crate::core::security::set_config_password_env, [password: String]);


            // =================================================================
            // ALERTS
            // =================================================================
            (get_alert_rules, $crate::core::alerts::commands::get_alert_rules, []);
            (save_alert_rule, $crate::core::alerts::commands::save_alert_rule, [rule: $crate::core::alerts::types::AlertRule]);
            (delete_alert_rule, $crate::core::alerts::commands::delete_alert_rule, [id: String]);
            (toggle_alert_rule, $crate::core::alerts::commands::toggle_alert_rule, [id: String, enabled: bool]);
            (get_alert_actions, $crate::core::alerts::commands::get_alert_actions, []);
            (save_alert_action, $crate::core::alerts::commands::save_alert_action, [action: $crate::core::alerts::types::AlertAction]);
            (delete_alert_action, $crate::core::alerts::commands::delete_alert_action, [id: String]);
            (test_alert_action, $crate::core::alerts::commands::test_alert_action, [id: String]);
            (get_alert_history, $crate::core::alerts::commands::get_alert_history, [filter: Option<$crate::core::alerts::types::AlertHistoryFilter>]);
            (acknowledge_alert, $crate::core::alerts::commands::acknowledge_alert, [id: String]);
            (acknowledge_all_alerts, $crate::core::alerts::commands::acknowledge_all_alerts, []);
            (clear_alert_history, $crate::core::alerts::commands::clear_alert_history, []);
            (get_alert_stats, $crate::core::alerts::commands::get_alert_stats, []);
            (get_unacknowledged_alert_count, $crate::core::alerts::commands::get_unacknowledged_alert_count, []);

            // =================================================================
            // DESKTOP & HEADLESS UTILITIES
            // =================================================================
            (fetch_update, $crate::utils::app::updater::app_updates::fetch_update, [channel: String]);
            (get_download_status, $crate::utils::app::updater::app_updates::get_download_status, []);
            (install_update, $crate::utils::app::updater::app_updates::install_update, []);
            (apply_app_update, $crate::utils::app::updater::app_updates::apply_app_update, []);
            (get_debug_info, $crate::core::debug::get_debug_info, [], [sync]);

            // =================================================================
            // DESKTOP ONLY
            // =================================================================
            #[cfg(not(feature = "web-server"))]
            (open_devtools, $crate::core::debug::open_devtools, [], [sync, no_app]);
            #[cfg(not(feature = "web-server"))]
            (new_nautilus_window, $crate::utils::app::builder::new_nautilus_window, [remote: Option<String>, path: Option<String>]);
        }
    }
}

#[macro_export]
macro_rules! tauri_handler_gen {
    ($( $(#[$meta:meta])? ($name:ident, $path:path, [$($arg:ident : $typ:ty),*] $(, [$($tag:ident),*])?) );* $(;)?) => {
        tauri::generate_handler![
            $(
                $(#[$meta])?
                $path
            ),*
        ]
    }
}

#[cfg(not(feature = "web-server"))]
pub fn dispatch_invoke(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
        crate::MASTER_COMMAND_LIST!(tauri_handler_gen);
    handler(invoke)
}

/// Internal helper macro to handle different function signatures (sync/async, with/without `AppHandle`)
#[macro_export]
macro_rules! call_internal {
    // 1. Sync + No AppHandle
    ($path:path, $app:expr, $args:expr, [$($arg:ident),*], [sync, no_app]) => {
        $path($($args.$arg),*).map_err(|e| e.to_string())?
    };
    // 2. Sync + AppHandle (Default if sync is present)
    ($path:path, $app:expr, $args:expr, [$($arg:ident),*], [sync]) => {
        $path($app.clone(), $($args.$arg),*).map_err(|e| e.to_string())?
    };
    // 3. Async + No AppHandle
    ($path:path, $app:expr, $args:expr, [$($arg:ident),*], [no_app]) => {
        $path($($args.$arg),*).await.map_err(|e| e.to_string())?
    };
    // 4. Async + AppHandle (Default)
    ($path:path, $app:expr, $args:expr, [$($arg:ident),*], []) => {
        $path($app.clone(), $($args.$arg),*).await.map_err(|e| e.to_string())?
    };
    // 5. Sync + No AppHandle + Infallible (function returns T directly, not Result)
    ($path:path, $app:expr, $args:expr, [$($arg:ident),*], [sync, no_app, infallible]) => {
        $path($($args.$arg),*)
    };
    // Fallback for tags in any order or other cases
    ($path:path, $app:expr, $args:expr, [$($arg:ident),*], [$($tag:ident),*]) => {
        $crate::call_internal_complex!($path, $app, $args, [$($arg),*], [$($tag),*])
    };
}

/// More complex helper to handle tag combinations in any order
#[macro_export]
macro_rules! call_internal_complex {
    ($path:path, $app:expr, $args:expr, [$($arg:ident),*], [no_app, sync]) => {
        $path($($args.$arg),*).map_err(|e| e.to_string())?
    };
    // Add more if needed, but these cover 99% of cases
}

/// Helper macro to generate the Axum bridge dispatcher.
#[cfg(feature = "web-server")]
macro_rules! axum_bridge_gen {
    ($( $(#[$meta:meta])? ($name:ident, $path:path, [$($arg:ident : $typ:ty),*] $(, [$($tag:ident),*])?) );* $(;)?) => {
        pub async fn bridge_dispatch(
            app: &tauri::AppHandle,
            command: &str,
            payload: serde_json::Value
        ) -> Result<serde_json::Value, String> {
            match command {
                $(
                    $(#[$meta])?
                    stringify!($name) => {
                        #[derive(serde::Deserialize)]
                        #[serde(rename_all = "camelCase")]
                        struct Args { $($arg: $typ),* }
                        #[allow(unused_variables)]
                        let args: Args = serde_json::from_value(payload).map_err(|e| e.to_string())?;

                        let res = $crate::call_internal!($path, app, args, [$($arg),*], [$($($tag),*)?]);
                        Ok(serde_json::to_value(res).map_err(|e| e.to_string())?)
                    }
                )*
                _ => Err(format!("Command '{}' not found in bridge", command))
            }
        }

        pub fn generate_bridge_router() -> axum::Router<$crate::server::WebServerState> {
            use axum::{Router, routing::post, extract::{State, Json}, response::Json as AxumJson};
            use serde_json::Value;
            use $crate::server::{ApiResponse, AppError, WebServerState};
            use serde::Deserialize;

            #[derive(Deserialize)]
            struct InvokeBody {
                command: String,
                args: Value,
            }

            Router::new().route("/invoke", post(|State(state): State<WebServerState>, Json(body): Json<InvokeBody>| async move {
                let res = bridge_dispatch(&state.app_handle, &body.command, body.args).await
                    .map_err(|e| AppError::InternalServerError(anyhow::Error::msg(e)))?;
                Ok::<AxumJson<ApiResponse<Value>>, AppError>(AxumJson(ApiResponse::success(res)))
            }))
        }
    };
}

// A unified dispatch function that can be used by the web server bridge.
#[cfg(feature = "web-server")]
MASTER_COMMAND_LIST!(axum_bridge_gen);
