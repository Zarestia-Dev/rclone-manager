use axum::{
    Router,
    routing::{get, post},
};

use super::handlers;
use super::state::{WebServerState, auth_middleware};

pub fn build_api_router(state: WebServerState) -> Router {
    let jobs_router = jobs_routes().with_state(state.clone());

    Router::new()
        .merge(remote_routes())
        .merge(system_routes())
        .merge(file_operations_routes())
        .merge(settings_routes())
        .merge(mount_serve_routes())
        .merge(scheduled_tasks_routes())
        .merge(flags_routes())
        .merge(security_routes())
        .merge(logs_routes())
        .merge(vfs_routes())
        .merge(backup_routes())
        .merge(backend_routes())
        .merge(debug_routes())
        .nest("/jobs", jobs_router)
        .route("/events", get(handlers::sse_handler))
        .with_state(state.clone())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
}

fn jobs_routes() -> Router<WebServerState> {
    Router::new()
        .route("/", get(handlers::get_jobs_handler))
        .route("/active", get(handlers::get_active_jobs_handler))
        .route("/by-source", get(handlers::get_jobs_by_source_handler))
        .route("/stop", post(handlers::stop_job_handler))
        .route("/delete", post(handlers::delete_job_handler))
        .route(
            "/start-sync-profile",
            post(handlers::start_sync_profile_handler),
        )
        .route(
            "/start-copy-profile",
            post(handlers::start_copy_profile_handler),
        )
        .route(
            "/start-move-profile",
            post(handlers::start_move_profile_handler),
        )
        .route(
            "/start-bisync-profile",
            post(handlers::start_bisync_profile_handler),
        )
        .route("/:id/status", get(handlers::get_job_status_handler))
        .route(
            "/rename-profile-in-cache",
            post(handlers::rename_job_profile_handler),
        )
}

fn remote_routes() -> Router<WebServerState> {
    Router::new()
        .route("/remotes", get(handlers::get_remotes_handler))
        .route("/remote/:name", get(handlers::get_remote_config_handler))
        .route("/remote-types", get(handlers::get_remote_types_handler))
        .route("/create-remote", post(handlers::create_remote_handler))
        .route(
            "/create-remote-interactive",
            post(handlers::create_remote_interactive_handler),
        )
        .route(
            "/continue-create-remote-interactive",
            post(handlers::continue_create_remote_interactive_handler),
        )
        .route(
            "/quit-rclone-oauth",
            post(handlers::quit_rclone_oauth_handler),
        )
        .route("/delete-remote", post(handlers::delete_remote_handler))
        .route(
            "/save-remote-settings",
            post(handlers::save_remote_settings_handler),
        )
        .route(
            "/delete-remote-settings",
            post(handlers::delete_remote_settings_handler),
        )
        .route(
            "/get-cached-remotes",
            get(handlers::get_cached_remotes_handler),
        )
        .route(
            "/get-oauth-supported-remotes",
            get(handlers::get_oauth_supported_remotes_handler),
        )
        .route(
            "/save-rclone-backend-option",
            post(handlers::save_rclone_backend_option_handler),
        )
        .route(
            "/set-rclone-option",
            post(handlers::set_rclone_option_handler),
        )
        .route(
            "/remove-rclone-backend-option",
            post(handlers::remove_rclone_backend_option_handler),
        )
        .route(
            "/get-grouped-options-with-values",
            get(handlers::get_grouped_options_with_values_handler),
        )
        .route("/update-remote", post(handlers::update_remote_handler))
}

fn system_routes() -> Router<WebServerState> {
    Router::new()
        .route("/stats", get(handlers::get_stats_handler))
        .route(
            "/stats/filtered",
            get(handlers::get_core_stats_filtered_handler),
        )
        .route(
            "/transfers/completed",
            get(handlers::get_completed_transfers_handler),
        )
        .route("/memory-stats", get(handlers::get_memory_stats_handler))
        .route(
            "/bandwidth/limit",
            get(handlers::get_bandwidth_limit_handler),
        )
        .route("/rclone-info", get(handlers::get_rclone_info_handler))
        .route("/rclone-pid", get(handlers::get_rclone_pid_handler))
        .route(
            "/get-rclone-rc-url",
            get(handlers::get_rclone_rc_url_handler),
        )
        .route(
            "/kill-process-by-pid",
            get(handlers::kill_process_by_pid_handler),
        )
        .route(
            "/check-rclone-available",
            get(handlers::check_rclone_available_handler),
        )
        .route(
            "/check-mount-plugin-installed",
            get(handlers::check_mount_plugin_installed_handler),
        )
        .route(
            "/is-network-metered",
            get(handlers::is_network_metered_handler),
        )
        .route("/provision-rclone", get(handlers::provision_rclone_handler))
        .route("/validate-cron", get(handlers::validate_cron_handler))
        .route("/handle-shutdown", post(handlers::handle_shutdown_handler))
        .route("/get-configs", get(handlers::get_configs_handler))
        .route(
            "/force-check-serves",
            post(handlers::force_check_serves_handler),
        )
        .route("/fetch-update", get(handlers::fetch_update_handler))
        .route(
            "/get-download-status",
            get(handlers::get_download_status_handler),
        )
        .route("/install-update", post(handlers::install_update_handler))
        .route("/relaunch-app", post(handlers::relaunch_app_handler))
        .route(
            "/are-updates-disabled",
            get(handlers::are_updates_disabled_handler),
        )
        .route("/get-build-type", get(handlers::get_build_type_handler))
        .route(
            "/quit-rclone-engine",
            post(handlers::quit_rclone_engine_handler),
        )
        .route("/gc", post(handlers::run_garbage_collector_handler))
        .route(
            "/get-fscache-entries",
            get(handlers::get_fscache_entries_handler),
        )
        .route("/clear-fscache", post(handlers::clear_fscache_handler))
}

fn file_operations_routes() -> Router<WebServerState> {
    Router::new()
        .route("/fs/info", get(handlers::get_fs_info_handler))
        .route("/disk-usage", get(handlers::get_disk_usage_handler))
        .route("/get-local-drives", get(handlers::get_local_drives_handler))
        .route("/get-size", get(handlers::get_size_handler))
        .route("/get-stat", get(handlers::get_stat_handler))
        .route("/get-hashsum", get(handlers::get_hashsum_handler))
        .route("/get-hashsum-file", get(handlers::get_hashsum_file_handler))
        .route("/get-public-link", get(handlers::get_public_link_handler))
        .route("/mkdir", post(handlers::mkdir_handler))
        .route("/cleanup", post(handlers::cleanup_handler))
        .route("/copy-url", post(handlers::copy_url_handler))
        .route("/remote/paths", post(handlers::get_remote_paths_handler))
        .route("/fs/stream", get(handlers::stream_file_handler))
}

fn settings_routes() -> Router<WebServerState> {
    Router::new()
        .route("/settings", get(handlers::get_settings_handler))
        .route("/settings/load", get(handlers::load_settings_handler))
        .route("/save-setting", post(handlers::save_setting_handler))
        .route("/reset-setting", post(handlers::reset_setting_handler))
        .route("/reset-settings", post(handlers::reset_settings_handler))
        .route(
            "/save-rclone-backend-options",
            post(handlers::save_rclone_backend_options_handler),
        )
        .route(
            "/reset-rclone-backend-options",
            post(handlers::reset_rclone_backend_options_handler),
        )
        .route(
            "/get-rclone-backend-store-path",
            get(handlers::get_rclone_backend_store_path_handler),
        )
        .route("/check-links", get(handlers::check_links_handler))
        .route(
            "/check-rclone-update",
            get(handlers::check_rclone_update_handler),
        )
        .route("/update-rclone", get(handlers::update_rclone_handler))
}

fn mount_serve_routes() -> Router<WebServerState> {
    Router::new()
        .route(
            "/mounted-remotes",
            get(handlers::get_mounted_remotes_handler),
        )
        .route(
            "/get-cached-mounted-remotes",
            get(handlers::get_cached_mounted_remotes_handler),
        )
        .route(
            "/get-cached-serves",
            get(handlers::get_cached_serves_handler),
        )
        .route(
            "/serve/start-profile",
            post(handlers::start_serve_profile_handler),
        )
        .route("/serve/stop", post(handlers::stop_serve_handler))
        .route(
            "/mount-remote-profile",
            post(handlers::mount_remote_profile_handler),
        )
        .route("/unmount-remote", post(handlers::unmount_remote_handler))
        .route("/mount-types", get(handlers::get_mount_types_handler))
        .route(
            "/rename-mount-profile-in-cache",
            post(handlers::rename_mount_profile_handler),
        )
        .route(
            "/rename-serve-profile-in-cache",
            post(handlers::rename_serve_profile_handler),
        )
}

fn scheduled_tasks_routes() -> Router<WebServerState> {
    Router::new()
        .route(
            "/reload-scheduled-tasks-from-configs",
            post(handlers::reload_scheduled_tasks_from_configs_handler),
        )
        .route(
            "/get-scheduled-tasks",
            get(handlers::get_scheduled_tasks_handler),
        )
        .route(
            "/toggle-scheduled-task",
            post(handlers::toggle_scheduled_task_handler),
        )
        .route(
            "/get-scheduled-tasks-stats",
            get(handlers::get_scheduled_tasks_stats_handler),
        )
        .route(
            "/reload-scheduled-tasks",
            post(handlers::reload_scheduled_tasks_handler),
        )
        .route(
            "/clear-all-scheduled-tasks",
            post(handlers::clear_all_scheduled_tasks_handler),
        )
        .route(
            "/get-scheduled-task",
            get(handlers::get_scheduled_task_handler),
        )
}

fn flags_routes() -> Router<WebServerState> {
    Router::new()
        .route("/flags/mount", get(handlers::get_mount_flags_handler))
        .route("/flags/copy", get(handlers::get_copy_flags_handler))
        .route("/flags/sync", get(handlers::get_sync_flags_handler))
        .route("/flags/bisync", get(handlers::get_bisync_flags_handler))
        .route("/flags/move", get(handlers::get_move_flags_handler))
        .route("/flags/filter", get(handlers::get_filter_flags_handler))
        .route("/flags/vfs", get(handlers::get_vfs_flags_handler))
        .route("/flags/backend", get(handlers::get_backend_flags_handler))
        .route(
            "/get-option-blocks",
            get(handlers::get_option_blocks_handler),
        )
        .route(
            "/get-flags-by-category",
            get(handlers::get_flags_by_category_handler),
        )
        .route("/serve/types", get(handlers::get_serve_types_handler))
        .route("/serve/flags", get(handlers::get_serve_flags_handler))
}

fn security_routes() -> Router<WebServerState> {
    Router::new()
        .route(
            "/has-stored-password",
            get(handlers::has_stored_password_handler),
        )
        .route(
            "/is-config-encrypted",
            get(handlers::is_config_encrypted_handler),
        )
        .route(
            "/remove-config-password",
            post(handlers::remove_config_password_handler),
        )
        .route(
            "/validate-rclone-password",
            get(handlers::validate_rclone_password_handler),
        )
        .route(
            "/store-config-password",
            post(handlers::store_config_password_handler),
        )
        .route(
            "/unencrypt-config",
            post(handlers::unencrypt_config_handler),
        )
        .route("/encrypt-config", post(handlers::encrypt_config_handler))
        .route(
            "/get-config-password",
            get(handlers::get_config_password_handler),
        )
        .route(
            "/set-config-password-env",
            post(handlers::set_config_password_env_handler),
        )
        .route(
            "/change-config-password",
            post(handlers::change_config_password_handler),
        )
}

fn logs_routes() -> Router<WebServerState> {
    Router::new()
        .route("/get-remote-logs", get(handlers::get_remote_logs_handler))
        .route(
            "/clear-remote-logs",
            get(handlers::clear_remote_logs_handler),
        )
}

fn vfs_routes() -> Router<WebServerState> {
    Router::new()
        .route("/vfs/list", get(handlers::vfs_list_handler))
        .route("/vfs/forget", post(handlers::vfs_forget_handler))
        .route("/vfs/refresh", post(handlers::vfs_refresh_handler))
        .route("/vfs/stats", get(handlers::vfs_stats_handler))
        .route(
            "/vfs/poll-interval",
            post(handlers::vfs_poll_interval_handler),
        )
        .route("/vfs/queue", get(handlers::vfs_queue_handler))
        .route(
            "/vfs/queue/set-expiry",
            post(handlers::vfs_queue_set_expiry_handler),
        )
}

fn backup_routes() -> Router<WebServerState> {
    Router::new()
        .route("/backup-settings", get(handlers::backup_settings_handler))
        .route(
            "/analyze-backup-file",
            get(handlers::analyze_backup_file_handler),
        )
        .route(
            "/restore-settings",
            post(handlers::restore_settings_handler),
        )
        .route(
            "/get-export-categories",
            get(handlers::get_export_categories_handler),
        )
}

fn backend_routes() -> Router<WebServerState> {
    Router::new()
        .route("/list-backends", get(handlers::list_backends_handler))
        .route(
            "/get-active-backend",
            get(handlers::get_active_backend_handler),
        )
        .route("/switch-backend", post(handlers::switch_backend_handler))
        .route("/add-backend", post(handlers::add_backend_handler))
        .route("/update-backend", post(handlers::update_backend_handler))
        .route("/remove-backend", post(handlers::remove_backend_handler))
        .route(
            "/test-backend-connection",
            post(handlers::test_backend_connection_handler),
        )
        .route(
            "/get-backend-profiles",
            get(handlers::get_backend_profiles_handler),
        )
}

fn debug_routes() -> Router<WebServerState> {
    Router::new().route("/debug/info", get(handlers::get_debug_info_handler))
}
