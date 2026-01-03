//! Tauri Command Registration
//!
//! This module contains the invoke handler registration for all Tauri commands.
//! Commands are organized by category and only registered in desktop mode
//! (not in web-server mode where the REST API is used instead).

/// Generate the Tauri invoke handler with all registered commands.
///
/// This macro generates the command handler for desktop mode only.
#[macro_export]
#[cfg(not(feature = "web-server"))]
macro_rules! generate_invoke_handler {
    () => {
        tauri::generate_handler![
            // =================================================================
            // FILE OPERATIONS
            // =================================================================
            $crate::utils::io::file_helper::open_in_files,
            $crate::utils::io::file_helper::get_folder_location,
            $crate::utils::io::file_helper::get_file_location,
            // =================================================================
            // UI & THEME
            // =================================================================
            $crate::utils::app::ui::set_theme,
            $crate::utils::app::ui::get_system_theme,
            $crate::rclone::queries::get_rclone_rc_url,
            // =================================================================
            // PLATFORM
            // =================================================================
            $crate::utils::app::platform::get_build_type,
            $crate::utils::app::platform::are_updates_disabled,
            $crate::utils::app::platform::relaunch_app,
            // =================================================================
            // RCLONE OPERATIONS
            // =================================================================
            $crate::utils::rclone::provision::provision_rclone,
            $crate::rclone::queries::get_rclone_info,
            $crate::rclone::queries::get_rclone_pid,
            $crate::utils::rclone::updater::check_rclone_update,
            $crate::utils::rclone::updater::update_rclone,
            $crate::utils::process::process_manager::kill_process_by_pid,
            // =================================================================
            // RCLONE QUERIES
            // =================================================================
            $crate::rclone::queries::get_all_remote_configs,
            $crate::rclone::queries::get_core_stats,
            $crate::rclone::queries::get_core_stats_filtered,
            $crate::rclone::queries::get_completed_transfers,
            $crate::rclone::queries::get_fs_info,
            $crate::rclone::queries::get_disk_usage,
            $crate::rclone::queries::get_about_remote,
            $crate::rclone::queries::get_size,
            $crate::rclone::queries::get_stat,
            $crate::rclone::queries::get_hashsum,
            $crate::rclone::queries::get_public_link,
            $crate::rclone::queries::get_memory_stats,
            $crate::rclone::queries::get_remotes,
            $crate::rclone::queries::get_remote_config,
            $crate::rclone::queries::get_remote_types,
            $crate::rclone::queries::get_oauth_supported_remotes,
            $crate::rclone::queries::get_mounted_remotes,
            $crate::rclone::commands::system::set_bandwidth_limit,
            // =================================================================
            // SYNC OPERATIONS
            // =================================================================
            $crate::rclone::commands::sync::start_sync_profile,
            $crate::rclone::commands::sync::start_copy_profile,
            $crate::rclone::commands::sync::start_bisync_profile,
            $crate::rclone::commands::sync::start_move_profile,
            // =================================================================
            // MOUNT OPERATIONS
            // =================================================================
            $crate::rclone::commands::mount::mount_remote_profile,
            $crate::rclone::commands::mount::unmount_remote,
            $crate::rclone::commands::mount::unmount_all_remotes,
            $crate::rclone::queries::get_mount_types,
            // =================================================================
            // VFS COMMANDS
            // =================================================================
            $crate::rclone::queries::vfs_forget,
            $crate::rclone::queries::vfs_list,
            $crate::rclone::queries::vfs_poll_interval,
            $crate::rclone::queries::vfs_refresh,
            $crate::rclone::queries::vfs_stats,
            $crate::rclone::queries::vfs_queue,
            $crate::rclone::queries::vfs_queue_set_expiry,
            // =================================================================
            // SERVE OPERATIONS
            // =================================================================
            $crate::rclone::commands::serve::start_serve_profile,
            $crate::rclone::commands::serve::stop_serve,
            $crate::rclone::commands::serve::stop_all_serves,
            $crate::rclone::queries::get_serve_types,
            $crate::rclone::queries::flags::get_serve_flags,
            $crate::rclone::queries::list_serves,
            // =================================================================
            // REMOTE MANAGEMENT
            // =================================================================
            $crate::rclone::commands::remote::create_remote_interactive,
            $crate::rclone::commands::remote::continue_create_remote_interactive,
            $crate::rclone::commands::remote::create_remote,
            $crate::rclone::commands::remote::update_remote,
            $crate::rclone::commands::remote::delete_remote,
            $crate::rclone::commands::system::quit_rclone_oauth,
            $crate::rclone::queries::get_remote_paths,
            // =================================================================
            // FILESYSTEM COMMANDS
            // =================================================================
            $crate::rclone::commands::filesystem::mkdir,
            $crate::rclone::commands::filesystem::cleanup,
            $crate::rclone::commands::filesystem::copy_url,
            $crate::rclone::queries::get_local_drives,
            $crate::rclone::queries::get_bandwidth_limit,
            // =================================================================
            // FLAGS & OPTIONS
            // =================================================================
            $crate::rclone::queries::flags::get_option_blocks,
            $crate::rclone::queries::flags::get_flags_by_category,
            $crate::rclone::queries::flags::get_copy_flags,
            $crate::rclone::queries::flags::get_sync_flags,
            $crate::rclone::queries::flags::get_bisync_flags,
            $crate::rclone::queries::flags::get_move_flags,
            $crate::rclone::queries::flags::get_filter_flags,
            $crate::rclone::queries::flags::get_vfs_flags,
            $crate::rclone::queries::flags::get_mount_flags,
            $crate::rclone::queries::flags::get_backend_flags,
            $crate::rclone::queries::flags::get_grouped_options_with_values,
            $crate::rclone::queries::flags::set_rclone_option,
            // =================================================================
            // SETTINGS
            // =================================================================
            $crate::core::settings::operations::core::load_settings,
            $crate::core::settings::operations::core::save_setting,
            $crate::core::settings::operations::core::reset_settings,
            $crate::core::settings::operations::core::reset_setting,
            // =================================================================
            // RCLONE BACKEND SETTINGS
            // =================================================================
            $crate::core::settings::rclone_backend::load_rclone_backend_options,
            $crate::core::settings::rclone_backend::save_rclone_backend_options,
            $crate::core::settings::rclone_backend::save_rclone_backend_option,
            $crate::core::settings::rclone_backend::reset_rclone_backend_options,
            $crate::core::settings::rclone_backend::get_rclone_backend_store_path,
            $crate::core::settings::rclone_backend::remove_rclone_backend_option,
            // =================================================================
            // REMOTE SETTINGS
            // =================================================================
            $crate::core::settings::remote::manager::save_remote_settings,
            $crate::core::settings::remote::manager::get_remote_settings,
            $crate::core::settings::remote::manager::delete_remote_settings,
            // =================================================================
            // BACKUP & RESTORE
            // =================================================================
            $crate::core::settings::backup::backup_manager::backup_settings,
            $crate::core::settings::backup::backup_manager::analyze_backup_file,
            $crate::core::settings::backup::restore_manager::restore_settings,
            $crate::core::settings::backup::export_categories::get_export_categories,
            // =================================================================
            // NETWORK
            // =================================================================
            $crate::utils::io::network::check_links,
            $crate::utils::io::network::is_network_metered,
            // =================================================================
            // MOUNT PLUGIN
            // =================================================================
            $crate::utils::rclone::mount::check_mount_plugin_installed,
            $crate::utils::rclone::mount::install_mount_plugin,
            // =================================================================
            // CACHE
            // =================================================================
            $crate::rclone::state::cache::get_cached_remotes,
            $crate::rclone::state::cache::get_configs,
            $crate::rclone::state::cache::get_settings,
            $crate::rclone::state::cache::get_cached_mounted_remotes,
            $crate::rclone::state::cache::get_cached_serves,
            $crate::rclone::state::cache::rename_mount_profile_in_cache,
            $crate::rclone::state::cache::rename_serve_profile_in_cache,
            // =================================================================
            // BINARIES
            // =================================================================
            $crate::core::check_binaries::check_rclone_available,
            // =================================================================
            // LOGS
            // =================================================================
            $crate::rclone::state::log::get_remote_logs,
            $crate::rclone::state::log::clear_remote_logs,
            // =================================================================
            // JOBS
            // =================================================================
            $crate::rclone::commands::job::get_jobs,
            $crate::rclone::commands::job::get_active_jobs,
            $crate::rclone::commands::job::get_jobs_by_source,
            $crate::rclone::commands::job::get_job_status,
            $crate::rclone::commands::job::stop_job,
            $crate::rclone::commands::job::delete_job,
            $crate::rclone::commands::job::rename_profile_in_cache,
            // =================================================================
            // BACKEND MANAGEMENT
            // =================================================================
            $crate::rclone::commands::backend::list_backends,
            $crate::rclone::commands::backend::get_active_backend,
            $crate::rclone::commands::backend::switch_backend,
            $crate::rclone::commands::backend::add_backend,
            $crate::rclone::commands::backend::update_backend,
            $crate::rclone::commands::backend::remove_backend,
            $crate::rclone::commands::backend::test_backend_connection,
            // =================================================================
            // SCHEDULED TASKS
            // =================================================================
            $crate::rclone::state::scheduled_tasks::get_scheduled_tasks,
            $crate::rclone::state::scheduled_tasks::get_scheduled_task,
            $crate::rclone::state::scheduled_tasks::get_scheduled_tasks_stats,
            $crate::core::scheduler::commands::toggle_scheduled_task,
            $crate::core::scheduler::commands::validate_cron,
            $crate::core::scheduler::commands::reload_scheduled_tasks,
            $crate::rclone::state::scheduled_tasks::reload_scheduled_tasks_from_configs,
            $crate::core::scheduler::commands::clear_all_scheduled_tasks,
            // =================================================================
            // WATCHERS
            // =================================================================
            $crate::rclone::state::watcher::force_check_mounted_remotes,
            $crate::rclone::state::watcher::force_check_serves,
            // =================================================================
            // APPLICATION CONTROL
            // =================================================================
            $crate::core::lifecycle::shutdown::handle_shutdown,
            // =================================================================
            // SECURITY & PASSWORD MANAGEMENT
            // =================================================================
            $crate::core::security::store_config_password,
            $crate::core::security::get_config_password,
            $crate::core::security::has_stored_password,
            $crate::core::security::remove_config_password,
            $crate::core::security::validate_rclone_password,
            $crate::core::security::is_config_encrypted,
            $crate::core::security::encrypt_config,
            $crate::core::security::unencrypt_config,
            $crate::core::security::change_config_password,
            $crate::core::security::set_config_password_env,
            // =================================================================
            // UPDATER (Desktop + Updater feature only)
            // =================================================================
            #[cfg(all(desktop, feature = "updater"))]
            $crate::utils::app::updater::app_updates::fetch_update,
            #[cfg(all(desktop, feature = "updater"))]
            $crate::utils::app::updater::app_updates::get_download_status,
            #[cfg(all(desktop, feature = "updater"))]
            $crate::utils::app::updater::app_updates::install_update,
            // =================================================================
            // DEBUG TOOLS
            // =================================================================
            $crate::core::debug::get_debug_info,
            $crate::core::debug::open_devtools,
        ]
    };
}

#[cfg(feature = "web-server")]
#[macro_export]
macro_rules! generate_invoke_handler {
    () => {
        // No-op for web-server mode - commands are handled via REST API
        tauri::generate_handler![]
    };
}
