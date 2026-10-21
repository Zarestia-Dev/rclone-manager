//! Shared command contract
//!
//! Shared operations are declared once for the transport-neutral dispatcher.
//! Native-only window and file-dialog commands belong to the desktop IPC adapter.

/// Shared command catalog.
/// Format: (`name_for_bridge`, `function_path`, [`arguments_for_bridge`])
///
/// Note: `AppHandle` is automatically injected and should not be listed in arguments.
#[macro_export]
macro_rules! MASTER_COMMAND_LIST {
    ($action:ident) => {
        $action! {
            // CONNECTION
            (get_rclone_rc_url, $crate::rclone::queries::get_rclone_rc_url, []);

            // PLATFORM
            (get_build_type, $crate::utils::app::platform::get_build_type, [], [sync, no_app, infallible]);
            (can_auto_install, $crate::services::updates::policy::can_auto_install, [], [infallible]);
            #[cfg(feature = "updater")]
            (confirm_app_update_startup, $crate::services::updates::health::confirm_frontend_ready, [], [infallible]);
            (get_update_policy, $crate::services::updates::policy::get_update_policy, [], [infallible]);
            (is_librclone, $crate::utils::app::platform::is_librclone, [], [sync, no_app, infallible]);
            (check_pending_app_exit, $crate::utils::app::platform::check_pending_app_exit, [], [sync, no_app, infallible]);
            #[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
            (request_app_exit, $crate::utils::app::platform::request_app_exit, []);
            (relaunch_app, $crate::utils::app::platform::relaunch_app, []);

            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            (register_send_to, $crate::utils::app::send_to::register_send_to, [remote: String, path: Option<String>]);
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            (unregister_send_to, $crate::utils::app::send_to::unregister_send_to, [remote: String, path: Option<String>]);
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            (is_send_to_registered, $crate::utils::app::send_to::is_send_to_registered, [remote: String, path: Option<String>]);

            // RCLONE OPERATIONS
            #[cfg(not(feature = "librclone"))]
            (kill_process_by_pid, $crate::utils::process::process_manager::kill_process_by_pid, [pid: u32], [sync, no_app]);
            #[cfg(not(feature = "librclone"))]
            (provision_rclone, $crate::rclone::binaries::provision::provision_rclone, [path: Option<String>]);
            #[cfg(not(feature = "librclone"))]
            (cancel_provision_rclone, $crate::rclone::binaries::provision::cancel_provision_rclone, []);
            #[cfg(not(feature = "librclone"))]
            (get_provision_status, $crate::rclone::binaries::provision::get_provision_status, [], [sync]);
            #[cfg(not(feature = "librclone"))]
            (check_rclone_update, $crate::rclone::binaries::updater::check_rclone_update, [channel: Option<String>]);
            #[cfg(not(feature = "librclone"))]
            (get_rclone_update_info, $crate::rclone::binaries::updater::get_rclone_update_info, []);
            #[cfg(not(feature = "librclone"))]
            (update_rclone, $crate::rclone::binaries::updater::update_rclone, [channel: Option<String>]);
            #[cfg(not(feature = "librclone"))]
            (cancel_rclone_update, $crate::rclone::binaries::updater::cancel_rclone_update, []);
            #[cfg(not(feature = "librclone"))]
            (apply_rclone_update, $crate::rclone::binaries::updater::apply_rclone_update, []);

            // RCLONE QUERIES
            (get_fs_info, $crate::rclone::queries::get_fs_info, [remote: String, path: Option<String>, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (get_disk_usage, $crate::rclone::queries::get_disk_usage, [remote: String, path: Option<String>, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (get_size, $crate::rclone::queries::get_size, [remote: String, path: Option<String>, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (get_stat, $crate::rclone::queries::get_stat, [remote: String, path: String, opt: Option<serde_json::Value>, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (get_hashsum, $crate::rclone::queries::get_hashsum, [remote: String, path: String, hash_type: String, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (get_hashsum_file, $crate::rclone::queries::get_hashsum_file, [remote: String, path: String, hash_type: String, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (get_public_link, $crate::rclone::queries::get_public_link, [remote: String, path: String, options: Option<$crate::rclone::queries::filesystem::PublicLinkParams>, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (get_local_disk_usage, $crate::rclone::queries::system::get_local_disk_usage, [dir: Option<String>]);
            (obscure_value, $crate::rclone::queries::system::obscure_value, [clear: String]);
            (get_remote_types, $crate::rclone::queries::get_remote_types, []);
            (get_oauth_supported_remotes, $crate::rclone::queries::get_oauth_supported_remotes, []);
            (get_rclone_config_file, $crate::rclone::queries::get_rclone_config_file, []);
            (bandwidth_limit, $crate::rclone::commands::system::bandwidth_limit, [rate: Option<String>]);

            // SYNC OPERATIONS
            (start_profile_batch, $crate::rclone::commands::sync::start_profile_batch, [transfer_type: $crate::utils::types::remotes::OperationType, params: $crate::utils::types::remotes::ProfileParams]);

            // MOUNT OPERATIONS
            (mount_remote_profile, $crate::rclone::commands::mount::mount_remote_profile, [params: $crate::utils::types::remotes::ProfileParams]);
            (unmount_remote, $crate::rclone::commands::mount::unmount_remote, [mount_point: String, remote_name: String]);
            (unmount_all_remotes, $crate::rclone::commands::mount::unmount_all_remotes, [context: $crate::rclone::commands::common::OperationContext]);
            (get_mount_types, $crate::rclone::queries::get_mount_types, []);

            // VFS COMMANDS
            (vfs_forget, $crate::rclone::queries::vfs_forget, [fs: Option<String>, file: Option<String>]);
            (vfs_list, $crate::rclone::queries::vfs_list, []);
            (vfs_poll_interval, $crate::rclone::queries::vfs_poll_interval, [fs: Option<String>, interval: Option<String>, timeout: Option<String>]);
            (vfs_refresh, $crate::rclone::queries::vfs_refresh, [fs: Option<String>, dir: Option<String>, recursive: bool]);
            (vfs_stats, $crate::rclone::queries::vfs_stats, [fs: Option<String>]);
            (vfs_queue, $crate::rclone::queries::vfs_queue, [fs: Option<String>]);
            (vfs_queue_set_expiry, $crate::rclone::queries::vfs_queue_set_expiry, [fs: Option<String>, id: u64, expiry: f64, relative: bool]);

            // SERVE OPERATIONS
            (start_serve_profile, $crate::rclone::commands::serve::start_serve_profile, [params: $crate::utils::types::remotes::ProfileParams]);
            (stop_serve, $crate::rclone::commands::serve::stop_serve, [server_id: String, remote_name: String]);
            (stop_all_serves, $crate::rclone::commands::serve::stop_all_serves, [context: $crate::rclone::commands::common::OperationContext]);
            (get_serve_types, $crate::rclone::queries::get_serve_types, []);
            (get_serve_flags, $crate::rclone::queries::flags::get_serve_flags, [serve_type: Option<String>]);
            (list_serves, $crate::rclone::queries::list_serves, []);

            // REMOTE MANAGEMENT
            (create_remote_interactive, $crate::rclone::commands::remote::create_remote_interactive, [name: String, rclone_type: String, parameters: Option<std::collections::HashMap<String, serde_json::Value>>, opt: Option<serde_json::Value>, backend_name: Option<String>]);
            (continue_create_remote_interactive, $crate::rclone::commands::remote::continue_create_remote_interactive, [name: String, state_token: String, result: serde_json::Value, parameters: Option<std::collections::HashMap<String, serde_json::Value>>, opt: Option<serde_json::Value>, backend_name: Option<String>]);
            (create_remote, $crate::rclone::commands::remote::create_remote, [name: String, parameters: std::collections::HashMap<String, serde_json::Value>, opt: Option<serde_json::Value>, backend_name: Option<String>]);
            (update_remote, $crate::rclone::commands::remote::update_remote, [name: String, parameters: std::collections::HashMap<String, serde_json::Value>, opt: Option<serde_json::Value>, backend_name: Option<String>]);
            (delete_remote, $crate::rclone::commands::remote::delete_remote, [name: String, backend_name: Option<String>]);
            (cancel_oauth, $crate::rclone::commands::system::cancel_oauth, []);
            (get_remote_paths, $crate::rclone::queries::get_remote_paths, [remote: String, path: Option<String>, options: Option<$crate::utils::types::remotes::ListOptions>, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (run_garbage_collector, $crate::rclone::commands::system::run_garbage_collector, []);
            (get_fscache_entries, $crate::rclone::commands::system::get_fscache_entries, []);
            (clear_fscache, $crate::rclone::commands::system::clear_fscache, []);
            #[cfg(not(feature = "librclone"))]
            (quit_rclone_engine, $crate::rclone::commands::system::quit_rclone_engine, []);

            // FILESYSTEM COMMANDS
            (mkdir, $crate::rclone::commands::filesystem::mkdir, [remote: String, path: String, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>, backend_name: Option<String>]);
            (cleanup, $crate::rclone::commands::filesystem::cleanup, [remote: String, path: Option<String>, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (transfer, $crate::rclone::commands::filesystem::transfer, [items: Vec<$crate::rclone::commands::filesystem::FsItem>, dst_remote: String, dst_path: String, mode: $crate::rclone::commands::filesystem::TransferMode, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>, parent_job_id: Option<u64>]);
            (delete, $crate::rclone::commands::filesystem::delete, [items: Vec<$crate::rclone::commands::filesystem::FsItem>, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (rename, $crate::rclone::commands::filesystem::rename, [items: Vec<$crate::rclone::commands::filesystem::RenameItem>, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (copy_url, $crate::rclone::commands::filesystem::copy_url, [remote: String, path: String, url_to_copy: String, auto_filename: bool, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (upload_local_drop_paths, $crate::rclone::commands::upload::upload_local_drop_paths, [remote: String, path: String, local_paths: Vec<String>, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (upload_file, $crate::rclone::commands::upload::upload_file, [remote: String, path: String, name: String, content: Vec<u8>]);
            (remove_empty_dirs, $crate::rclone::commands::filesystem::remove_empty_dirs, [remote: String, path: String, origin: Option<$crate::utils::types::origin::Origin>, group: Option<String>]);
            (get_local_drives, $crate::rclone::queries::get_local_drives, []);

            // ARCHIVE OPERATIONS
            (archive_create, $crate::rclone::commands::archive::archive_create, [source: String, destination: String, format: Option<String>, prefix: Option<String>, full_path: Option<bool>, include: Option<Vec<String>>]);
            (archive_extract, $crate::rclone::commands::archive::archive_extract, [source: String, destination: String]);
            (archive_list, $crate::rclone::commands::archive::archive_list, [source: String, long: Option<bool>, plain: Option<bool>, files_only: Option<bool>, dirs_only: Option<bool>]);

            // FLAGS & OPTIONS
            (get_option_blocks, $crate::rclone::queries::flags::get_option_blocks, []);
            (get_operation_flags, $crate::rclone::queries::flags::get_operation_flags, [operation: String]);
            (get_filter_flags, $crate::rclone::queries::flags::get_filter_flags, []);
            (get_vfs_flags, $crate::rclone::queries::flags::get_vfs_flags, []);
            (get_mount_flags, $crate::rclone::queries::flags::get_mount_flags, []);
            (get_backend_flags, $crate::rclone::queries::flags::get_backend_flags, []);
            (get_grouped_options_with_values, $crate::rclone::queries::flags::get_grouped_options_with_values, []);
            (set_rclone_option, $crate::rclone::queries::flags::set_rclone_option, [block_name: String, option_name: String, value: serde_json::Value]);

            // SETTINGS
            (load_settings, $crate::services::settings::operations::core::load_settings, []);
            (save_setting, $crate::services::settings::operations::core::save_setting, [category: String, key: String, value: serde_json::Value]);
            (reset_settings, $crate::services::settings::operations::core::reset_settings, []);
            (reset_setting, $crate::services::settings::operations::core::reset_setting, [category: String, key: String]);
            (list_user_templates, $crate::services::settings::operations::templates::list_user_templates, []);
            (save_user_template, $crate::services::settings::operations::templates::save_user_template, [id: String, template: serde_json::Value]);
            (update_user_template, $crate::services::settings::operations::templates::update_user_template, [id: String, template: serde_json::Value]);
            (delete_user_template, $crate::services::settings::operations::templates::delete_user_template, [id: String]);

            // RCLONE BACKEND SETTINGS
            (load_rclone_backend_options, $crate::services::settings::rclone_backend::load_rclone_backend_options, []);
            (save_rclone_backend_options, $crate::services::settings::rclone_backend::save_rclone_backend_options, [options: serde_json::Value]);
            (save_rclone_backend_option, $crate::services::settings::rclone_backend::save_rclone_backend_option, [block: String, option: String, value: serde_json::Value]);
            (reset_rclone_backend_options, $crate::services::settings::rclone_backend::reset_rclone_backend_options, []);
            (get_rclone_backend_store_path, $crate::services::settings::rclone_backend::get_rclone_backend_store_path, []);
            (remove_rclone_backend_option, $crate::services::settings::rclone_backend::remove_rclone_backend_option, [block: String, option: String]);

            // REMOTE SETTINGS
            (save_remote_settings, $crate::services::settings::remote::manager::save_remote_settings, [remote_name: String, settings: serde_json::Value, backend_name: Option<String>]);
            (delete_remote_settings, $crate::services::settings::remote::manager::delete_remote_settings, [remote_name: String]);

            // BACKUP & RESTORE
            (backup_settings, $crate::services::settings::backup::backup_manager::backup_settings, [backup_dir: String, export_type: $crate::utils::types::backup_types::ExportType, password: Option<String>, remote_name: Option<String>, user_note: Option<String>, include_profiles: Option<Vec<String>>, include_secrets: Option<bool>]);
            (analyze_backup_file, $crate::services::settings::backup::backup_manager::analyze_backup_file, [path: std::path::PathBuf]);
            (restore_settings, $crate::services::settings::backup::restore_manager::restore_settings, [backup_path: std::path::PathBuf, password: Option<String>, restore_profile: Option<String>, restore_profile_as: Option<String>]);
            (get_export_categories, $crate::services::settings::backup::export_categories::get_export_categories, []);

            // NETWORK
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            (check_links, $crate::utils::io::network::check_links, [links: Vec<String>, max_retries: usize, retry_delay_secs: u64], [no_app]);
            (is_network_metered, $crate::utils::io::network::is_network_metered, [], [no_app]);

            // MOUNT PLUGIN
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            (check_mount_plugin_installed, $crate::rclone::binaries::mount::check_mount_plugin_installed, [], [sync, no_app, infallible]);
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            (install_mount_plugin, $crate::rclone::binaries::mount::install_mount_plugin, []);
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            (cancel_mount_plugin_install, $crate::rclone::binaries::mount::cancel_mount_plugin_install, []);

            // CACHE
            (get_cached_remotes, $crate::rclone::state::cache::get_cached_remotes, []);
            (get_configs, $crate::rclone::state::cache::get_configs, []);
            (get_settings, $crate::rclone::state::cache::get_settings, []);
            (get_cached_mounted_remotes, $crate::rclone::state::cache::get_cached_mounted_remotes, []);
            (get_cached_serves, $crate::rclone::state::cache::get_cached_serves, []);
            (rename_mount_profile_in_cache, $crate::rclone::state::cache::rename_mount_profile_in_cache, [remote_name: String, old_name: String, new_name: String]);
            (rename_serve_profile_in_cache, $crate::rclone::state::cache::rename_serve_profile_in_cache, [remote_name: String, old_name: String, new_name: String]);

            // BINARIES
            #[cfg(not(feature = "librclone"))]
            (check_rclone_available, $crate::services::check_binaries::check_rclone_available, [path: String]);

            // LOGS
            (get_remote_logs, $crate::rclone::state::log::get_remote_logs, [remote_name: Option<String>]);
            (clear_remote_logs, $crate::rclone::state::log::clear_remote_logs, [remote_name: Option<String>]);

            // JOBS
            (get_jobs, $crate::rclone::commands::job::get_jobs, []);
            (submit_batch_job, $crate::rclone::commands::job::submit_batch_job, [inputs: Vec<serde_json::Value>, metadata: $crate::rclone::commands::job::JobMetadata]);
            (stop_job, $crate::rclone::commands::job::stop_job, [jobid: u64, remote_name: String]);
            (delete_job, $crate::rclone::commands::job::delete_job, [jobid: u64]);
            (stop_jobs_by_group, $crate::rclone::commands::job::stop_jobs_by_group, [group: String]);
            (stop_all_active_jobs, $crate::services::lifecycle::shutdown::stop_all_active_jobs, []);
            (register_preparing_job, $crate::rclone::commands::job::register_preparing_job, [jobid: u64, remote: String, destination: String, total_files: usize, total_bytes: u64, origin: Option<$crate::utils::types::origin::Origin>]);
            (update_job_stats, $crate::rclone::commands::job::update_job_stats, [jobid: u64, stats: serde_json::Value]);

            // STATS GROUP MANAGEMENT
            (reset_group_stats, $crate::rclone::commands::system::reset_group_stats, [group: Option<String>]);

            // BACKEND MANAGEMENT
            (list_backends, $crate::rclone::commands::backend::list_backends, []);
            (get_active_backend, $crate::rclone::commands::backend::get_active_backend, []);
            (get_backend_profiles, $crate::rclone::commands::backend::get_backend_profiles, []);
            (switch_backend, $crate::rclone::commands::backend::switch_backend, [name: String]);
            (add_backend, $crate::rclone::commands::backend::add_backend, [params: $crate::rclone::commands::backend::AddBackendParams]);
            (update_backend, $crate::rclone::commands::backend::update_backend, [params: $crate::rclone::commands::backend::UpdateBackendParams]);
            (remove_backend, $crate::rclone::commands::backend::remove_backend, [name: String]);
            (test_backend_connection, $crate::rclone::commands::backend::test_backend_connection, [name: String]);
            (test_backend_connection_details, $crate::rclone::commands::backend::test_backend_connection_details, [host: String, port: u16, username: Option<String>, password: Option<String>]);
            (clear_engine_auth_error, $crate::rclone::engine::lifecycle::clear_engine_auth_error, []);
            #[cfg(not(feature = "librclone"))]
            (find_available_port, $crate::rclone::commands::backend::find_available_port, [start_port: Option<u16>], [sync, no_app]);
            #[cfg(not(feature = "librclone"))]
            (check_port_available, $crate::rclone::commands::backend::check_port_available, [port: u16], [sync, no_app]);

            // AUTOMATIONS
            (get_automations, $crate::rclone::state::automations::get_automations, []);
            (get_automation, $crate::rclone::state::automations::get_automation, [automation_id: String]);
            (toggle_automation, $crate::services::automation::commands::toggle_automation, [automation_id: String]);
            (validate_cron, $crate::services::automation::commands::validate_cron, [cron_expression: String], [no_app]);
            (reload_automations, $crate::services::automation::commands::reload_automations, []);
            (clear_all_automations, $crate::services::automation::commands::clear_all_automations, []);

            // QUICK RUNS (FLOW WORKSPACE)
            (list_quick_runs, $crate::services::flow::quick_run::commands::list_quick_runs, []);
            (create_quick_run, $crate::services::flow::quick_run::commands::create_quick_run, [quick_run: $crate::services::flow::quick_run::types::QuickRunInput]);
            (update_quick_run, $crate::services::flow::quick_run::commands::update_quick_run, [quick_run: $crate::services::flow::quick_run::types::QuickRunInput]);
            (delete_quick_run, $crate::services::flow::quick_run::commands::delete_quick_run, [quick_run_id: String]);
            (start_quick_run, $crate::services::flow::quick_run::commands::start_quick_run, [quick_run_id: String, workflow_id: Option<String>, node_id: Option<String>]);
            (stop_quick_run, $crate::services::flow::quick_run::commands::stop_quick_run, [quick_run_id: String, job_id: Option<u64>]);

            // WORKFLOWS (FLOW WORKSPACE)
            (list_workflows, $crate::services::flow::workflow::commands::list_workflows, []);
            (get_workflow, $crate::services::flow::workflow::commands::get_workflow, [workflow_id: String]);
            (create_workflow, $crate::services::flow::workflow::commands::create_workflow, [workflow: $crate::services::flow::workflow::types::WorkflowInput]);
            (update_workflow, $crate::services::flow::workflow::commands::update_workflow, [workflow: $crate::services::flow::workflow::types::WorkflowInput]);
            (delete_workflow, $crate::services::flow::workflow::commands::delete_workflow, [workflow_id: String]);
            (duplicate_workflow, $crate::services::flow::workflow::commands::duplicate_workflow, [workflow_id: String]);
            (validate_workflow, $crate::services::flow::workflow::commands::validate_workflow, [workflow: $crate::services::flow::workflow::types::WorkflowDefinition], [no_app]);
            (execute_workflow, $crate::services::flow::workflow::commands::execute_workflow, [workflow_id: String, dry_run: Option<bool>]);
            (stop_workflow, $crate::services::flow::workflow::commands::stop_workflow, [workflow_id: String]);
            (export_workflow, $crate::services::flow::workflow::commands::export_workflow, [workflow_id: String]);
            (import_workflow, $crate::services::flow::workflow::commands::import_workflow, [json_str: String]);
            (test_rc_command, $crate::services::flow::workflow::commands::test_rc_command, [command: String, params: Option<serde_json::Value>]);

            // WATCHERS
            (force_check_mounted_remotes, $crate::rclone::state::watcher::force_check_mounted_remotes, []);
            (force_check_serves, $crate::rclone::state::watcher::force_check_serves, []);
            (set_poller_visibility, $crate::rclone::engine::poller::set_poller_visibility, [visible: bool], [sync]);
            (get_system_status_snapshot, $crate::rclone::engine::poller::get_system_status_snapshot, []);

            // APPLICATION CONTROL
            #[cfg(not(any(target_os = "ios")))]
            (shutdown_app, $crate::services::lifecycle::shutdown::shutdown_app, []);
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            (execute_system_power, $crate::services::power::actions::execute_system_power, [action: String], [no_app]);

            // SECURITY & PASSWORD MANAGEMENT
            (store_config_password, $crate::services::security::store_config_password, [password: String]);
            (get_config_password, $crate::services::security::get_config_password, []);
            (has_stored_password, $crate::services::security::has_stored_password, []);
            (remove_config_password, $crate::services::security::remove_config_password, []);
            (validate_rclone_password, $crate::services::security::validate_rclone_password, [password: String]);
            (is_config_encrypted, $crate::services::security::is_config_encrypted, []);
            (encrypt_config, $crate::services::security::encrypt_config, [password: String]);
            (unencrypt_config, $crate::services::security::unencrypt_config, [password: String]);
            (change_config_password, $crate::services::security::change_config_password, [old_password: String, new_password: String]);
            (set_config_password_env, $crate::services::security::set_config_password_env, [password: String]);

            // CONFIGURATION VAULT (rcman)
            (get_vault_info, $crate::services::settings::vault::get_vault_info, []);
            (unlock_vault, $crate::services::settings::vault::unlock_vault, [password: String]);
            (lock_vault, $crate::services::settings::vault::lock_vault, []);
            (enable_vault, $crate::services::settings::vault::enable_vault, [password: String, timeout_secs: Option<u64>]);
            (disable_vault, $crate::services::settings::vault::disable_vault, [password: String]);
            (change_vault_password, $crate::services::settings::vault::change_vault_password, [old_password: String, new_password: String]);
            (set_vault_lock_timeout, $crate::services::settings::vault::set_vault_lock_timeout, [timeout_secs: Option<u64>]);
            (touch_vault, $crate::services::settings::vault::touch_vault, []);

            // ALERTS
            (get_alert_rules, $crate::services::alerts::commands::get_alert_rules, []);
            (save_alert_rule, $crate::services::alerts::commands::save_alert_rule, [rule: $crate::services::alerts::types::AlertRule]);
            (delete_alert_rule, $crate::services::alerts::commands::delete_alert_rule, [id: String]);
            (toggle_alert_rule, $crate::services::alerts::commands::toggle_alert_rule, [id: String, enabled: bool]);
            (get_alert_actions, $crate::services::alerts::commands::get_alert_actions, []);
            (save_alert_action, $crate::services::alerts::commands::save_alert_action, [action: $crate::services::alerts::types::AlertAction]);
            (delete_alert_action, $crate::services::alerts::commands::delete_alert_action, [id: String]);
            (test_alert_action, $crate::services::alerts::commands::test_alert_action, [id: String]);
            (get_alert_history, $crate::services::alerts::commands::get_alert_history, [filter: Option<$crate::services::alerts::types::AlertHistoryFilter>]);
            (acknowledge_alert, $crate::services::alerts::commands::acknowledge_alert, [id: String]);
            (acknowledge_all_alerts, $crate::services::alerts::commands::acknowledge_all_alerts, []);
            (clear_alert_history, $crate::services::alerts::commands::clear_alert_history, []);
            (get_alert_stats, $crate::services::alerts::commands::get_alert_stats, []);
            (get_alert_template_keys, $crate::services::alerts::commands::get_alert_template_keys, [], [sync, no_app, infallible]);

            // DESKTOP & HEADLESS UTILITIES
            (fetch_update, $crate::services::updates::fetch_update, [channel: String]);
            (get_app_update_info, $crate::services::updates::get_app_update_info, []);
            #[cfg(feature = "updater")]
            (install_update, $crate::services::updates::install::install_update, []);
            #[cfg(feature = "updater")]
            (cancel_app_update, $crate::services::updates::install::cancel_app_update, []);
            #[cfg(feature = "updater")]
            (apply_app_update, $crate::services::updates::install::apply_app_update, []);
            (get_debug_info, $crate::services::debug::get_debug_info, [], [sync]);

            // DESKTOP ONLY
        }
    }
}
