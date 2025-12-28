use log::{debug, error, info};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Listener, Manager};

#[cfg(desktop)]
use crate::core::tray::core::update_tray_menu;

#[cfg(desktop)]
use crate::utils::app::builder::setup_tray;

use crate::{
    core::{lifecycle::shutdown::handle_shutdown, scheduler::engine::CronScheduler},
    rclone::{
        commands::system::set_bandwidth_limit,
        state::scheduled_tasks::{ScheduledTasksCache, reload_scheduled_tasks_from_configs},
    },
    utils::{
        logging::log::update_log_level,
        types::{
            all_types::RcloneState,
            events::{
                JOB_CACHE_CHANGED, MOUNT_STATE_CHANGED, RCLONE_PASSWORD_STORED,
                REMOTE_CACHE_UPDATED, REMOTE_PRESENCE_CHANGED, REMOTE_STATE_CHANGED,
                SERVE_STATE_CHANGED, SYSTEM_SETTINGS_CHANGED, UPDATE_TRAY_MENU,
            },
        },
    },
};

// Mobile no-op stub for update_tray_menu
#[cfg(not(desktop))]
async fn update_tray_menu(_app: AppHandle, _max_items: usize) -> Result<(), String> {
    Ok(())
}

// Mobile no-op stub for setup_tray
#[cfg(not(desktop))]
async fn setup_tray(_app: AppHandle, _max_items: usize) -> tauri::Result<()> {
    Ok(())
}

fn parse_payload<T: for<'de> serde::Deserialize<'de>>(payload: Option<&str>) -> Result<T, String> {
    payload
        .ok_or_else(|| "No payload".into())
        .and_then(|p| serde_json::from_str(p).map_err(|e| e.to_string()))
}

fn handle_ctrl_c(app: &AppHandle) {
    let app_handle_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        use tokio::signal::ctrl_c;
        ctrl_c().await.expect("Failed to install Ctrl+C handler");
        info!("🧹 Ctrl+C received via tokio. Initiating shutdown...");
        handle_shutdown(app_handle_clone.clone()).await;
        app_handle_clone.exit(0);
    });
}

fn handle_rclone_password_stored(app: &AppHandle) {
    let app_clone = app.clone();
    app.listen(RCLONE_PASSWORD_STORED, move |_| {
        let _app = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            // Clear the engine flag using the new helper
            tauri::async_runtime::spawn_blocking(move || {
                let _ = crate::utils::types::all_types::RcApiEngine::with_lock(|e| {
                    e.set_password_error(false);
                });
            });
        });
    });
}

fn handle_remote_state_changed(app: &AppHandle) {
    let app_clone = app.clone();
    app.listen(REMOTE_STATE_CHANGED, move |event| {
        debug!(
            "🔄 Remote state changed! Raw payload: {:?}",
            event.payload()
        );
        let app = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            let client = app
                .state::<crate::utils::types::all_types::RcloneState>()
                .client
                .clone();
            let backend = crate::rclone::backend::BACKEND_MANAGER.get_active().await;
            // guard deleted
            let cache = &crate::rclone::backend::BACKEND_MANAGER.remote_cache;

            if let Err(e) = cache.refresh_mounted_remotes(&client, &backend).await {
                error!("Failed to refresh mounted remotes: {e}");
            }
            if let Err(e) = update_tray_menu(app.clone(), 0).await {
                error!("Failed to update tray menu: {e}");
            }

            let _ = app
                .clone()
                .emit(MOUNT_STATE_CHANGED, "remote_presence")
                .map_err(|e| {
                    error!("❌ Failed to emit event to frontend: {e}");
                });
        });
    });
}

fn handle_remote_presence_changed(app: &AppHandle) {
    let app_clone = app.clone();
    app.listen(REMOTE_PRESENCE_CHANGED, move |_| {
        let app_clone = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            let client = app_clone
                .state::<crate::utils::types::all_types::RcloneState>()
                .client
                .clone();

            let backend = crate::rclone::backend::BACKEND_MANAGER.get_active().await;
            // guard deleted
            let cache = &crate::rclone::backend::BACKEND_MANAGER.remote_cache;

            let refresh_tasks: (Result<(), String>, Result<(), String>) = tokio::join!(
                cache.refresh_remote_list(&client, &backend),
                cache.refresh_remote_configs(&client, &backend),
            );
            if let (Err(e1), Err(e2)) = refresh_tasks {
                error!("Failed to refresh cache: {e1}, {e2}");
            }

            let remote_names = cache.get_remotes().await;
            let manager = app_clone.state::<rcman::SettingsManager<rcman::JsonStorage>>();
            let all_configs = crate::core::settings::remote::manager::get_all_remote_settings_sync(
                manager.inner(),
                &remote_names,
            );

            let cache_state = app_clone.state::<ScheduledTasksCache>();
            let scheduler_state = app_clone.state::<CronScheduler>();

            if let Err(e) =
                reload_scheduled_tasks_from_configs(cache_state, scheduler_state, all_configs).await
            {
                error!("❌ Failed to reload scheduled tasks after remote change: {e}");
            }

            if let Err(e) = update_tray_menu(app_clone.clone(), 0).await {
                error!("Failed to update tray menu: {e}");
            }

            let _ = app_clone
                .emit(REMOTE_CACHE_UPDATED, "remote_presence")
                .map_err(|e| {
                    error!("❌ Failed to emit event to frontend: {e}");
                });
        });
    });
}

fn tray_menu_updated(app: &AppHandle) {
    let app_clone = app.clone();
    app.listen(UPDATE_TRAY_MENU, move |_| {
        let app = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = update_tray_menu(app, 0).await {
                error!("Failed to update tray menu: {e}");
            }
        });
    });
}

fn handle_job_cache_changed(app: &AppHandle) {
    let app_clone = app.clone();
    app.listen(JOB_CACHE_CHANGED, move |event| {
        debug!("🔄 Job cache changed! Raw payload: {:?}", event.payload());

        let app = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = update_tray_menu(app, 0).await {
                error!("Failed to update tray menu: {e}");
            }
        });
    });
}

fn handle_serve_state_changed(app: &AppHandle) {
    let app_clone = app.clone();
    app.listen(SERVE_STATE_CHANGED, move |event| {
        let app = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            debug!("🔄 Serve state changed! Raw payload: {:?}", event.payload());

            let client = app
                .state::<crate::utils::types::all_types::RcloneState>()
                .client
                .clone();
            let backend = crate::rclone::backend::BACKEND_MANAGER.get_active().await;
            // guard deleted
            let cache = &crate::rclone::backend::BACKEND_MANAGER.remote_cache;

            if let Err(e) = cache.refresh_serves(&client, &backend).await {
                error!("❌ Failed to refresh serves cache: {e}");
            }

            if let Err(e) = update_tray_menu(app.clone(), 0).await {
                error!("Failed to update tray menu after serve change: {e}");
            }
        });
    });
}

fn handle_settings_changed(app: &AppHandle) {
    let app_handle = app.clone();

    let app_handle_clone = app_handle.clone();
    app.listen(SYSTEM_SETTINGS_CHANGED, move |event| {
        let app_handle = app_handle_clone.clone();
        debug!("🔄 Settings saved! Raw payload: {:?}", event.payload());

        match parse_payload::<Value>(Some(event.payload())) {
            Ok(settings) => {
                if let Some(general) = settings.get("general") {
                    if let Some(notification) =
                        general.get("notifications").and_then(|v| v.as_bool())
                    {
                        debug!("💬 Notifications changed to: {notification}");
                        let notifications_enabled = app_handle.state::<RcloneState>();
                        let mut guard = match notifications_enabled.notifications_enabled.write() {
                            Ok(g) => g,
                            Err(e) => {
                                error!("Failed to write notifications_enabled: {e}");
                                return;
                            }
                        };
                        *guard = notification;
                    }

                    if let Some(startup) = general.get("start_on_startup").and_then(|v| v.as_bool())
                    {
                        debug!("🚀 Start on Startup changed to: {startup}");

                        #[cfg(feature = "flatpak")]
                        {
                            use crate::utils::app::platform::manage_flatpak_autostart;
                            if let Err(e) = manage_flatpak_autostart(startup) {
                                error!("Failed to update flatpak autostart: {e}");
                            }
                        }

                        #[cfg(all(desktop, not(feature = "flatpak")))]
                        {
                            use tauri_plugin_autostart::ManagerExt;
                            let autostart = app_handle.autolaunch();
                            let _ = if startup {
                                autostart.enable()
                            } else {
                                autostart.disable()
                            };
                        }
                    }

                    if let Some(tray_enabled) =
                        general.get("tray_enabled").and_then(|v| v.as_bool())
                    {
                        #[cfg(desktop)]
                        {
                            let app_handle_clone = app_handle.clone();
                            tauri::async_runtime::spawn(async move {
                                let tray_state = app_handle_clone.state::<RcloneState>();
                                let mut guard = match tray_state.tray_enabled.write() {
                                    Ok(g) => g,
                                    Err(e) => {
                                        error!("Failed to write tray_enabled: {e}");
                                        return;
                                    }
                                };
                                *guard = tray_enabled;
                                debug!("🛠️ Tray visibility changed to: {tray_enabled}");
                                if let Some(tray) = app_handle_clone.tray_by_id("main-tray") {
                                    let _ = tray.set_visible(tray_enabled);
                                } else {
                                    let app = app_handle_clone.clone();
                                    tauri::async_runtime::spawn(async move {
                                        if let Err(e) = setup_tray(app, 0).await {
                                            error!("Failed to set up tray: {e}");
                                        }
                                    });
                                }
                            });
                        }
                        #[cfg(not(desktop))]
                        {
                            let _ = tray_enabled; // Silence unused warning
                        }
                    }
                    if let Some(restrict) = general.get("restrict").and_then(|v| v.as_bool()) {
                        debug!("🔒 Restrict mode changed to: {restrict}");
                        let rclone_state = app_handle.state::<RcloneState>();
                        let mut guard = match rclone_state.restrict_mode.write() {
                            Ok(g) => g,
                            Err(e) => {
                                error!("Failed to write restrict_mode: {e}");
                                return;
                            }
                        };
                        *guard = restrict;
                        let app_handle_clone = app_handle.clone();
                        app_handle_clone
                            .emit(REMOTE_PRESENCE_CHANGED, "restrict_mode_changed")
                            .unwrap_or_else(|e| {
                                error!("❌ Failed to emit remote presence changed event: {e}");
                            });
                    }
                }

                if let Some(core) = settings.get("core").cloned() {
                    if let Some(bandwidth_limit) = core.get("bandwidth_limit") {
                        debug!("🌐 Bandwidth limit changed to: {bandwidth_limit}");
                        let app = app_handle.clone();
                        let bandwidth_limit_opt = if bandwidth_limit.is_null() {
                            None
                        } else if let Some(s) = bandwidth_limit.as_str() {
                            Some(s.to_string())
                        } else {
                            bandwidth_limit.as_u64().map(|n| n.to_string())
                        };
                        tauri::async_runtime::spawn(async move {
                            let app_clone = app.clone();
                            let rclone_state = app.state::<RcloneState>();
                            if let Err(e) = set_bandwidth_limit(
                                app_clone.clone(),
                                bandwidth_limit_opt.clone(),
                                rclone_state,
                            )
                            .await
                            {
                                error!("Failed to set bandwidth limit: {e:?}");
                            }
                        });
                    }

                    if let Some(config_path) =
                        core.get("rclone_config_file").and_then(|v| v.as_str())
                    {
                        debug!("🔄 Rclone config path changed to: {config_path}");
                        let rclone_state = app_handle.state::<RcloneState>();
                        let old_rclone_config_file = match rclone_state.rclone_config_file.read() {
                            Ok(cfg) => cfg.to_string(),
                            Err(e) => {
                                error!("Failed to read rclone_config_file: {e}");
                                return;
                            }
                        };
                        let mut guard = match rclone_state.rclone_config_file.write() {
                            Ok(g) => g,
                            Err(e) => {
                                error!("Failed to write rclone_config_file: {e}");
                                return;
                            }
                        };
                        *guard = config_path.to_string();
                        drop(guard);

                        if let Err(e) = crate::rclone::engine::lifecycle::restart_for_config_change(
                            &app_handle,
                            "rclone_config_file",
                            &old_rclone_config_file,
                            config_path,
                        ) {
                            error!("Failed to restart engine for rclone config file change: {e}");
                        }
                        info!(
                            "Rclone config file updated to: {}",
                            match rclone_state.rclone_config_file.read() {
                                Ok(cfg) => cfg,
                                Err(e) => {
                                    error!("Failed to read rclone_config_file for logging: {e}");
                                    return;
                                }
                            }
                        );
                    }

                    if let Some(rclone_path) = core.get("rclone_path").and_then(|v| v.as_str()) {
                        debug!("🔄 Rclone path changed to: {rclone_path}");
                        let rclone_state = app_handle.state::<RcloneState>();
                        let old_rclone_path = match rclone_state.rclone_path.read() {
                            Ok(path) => path.clone(),
                            Err(e) => {
                                error!("Failed to read rclone_path: {e}");
                                return;
                            }
                        };
                        debug!("Old rclone path: {}", old_rclone_path.to_string_lossy());
                        {
                            let mut path_guard = match rclone_state.rclone_path.write() {
                                Ok(g) => g,
                                Err(e) => {
                                    error!("Failed to write rclone_path: {e}");
                                    return;
                                }
                            };
                            *path_guard = std::path::PathBuf::from(rclone_path);
                        }

                        // Restart engine with new rclone path
                        if let Err(e) = crate::rclone::engine::lifecycle::restart_for_config_change(
                            &app_handle,
                            "rclone_path",
                            &old_rclone_path.to_string_lossy(),
                            rclone_path,
                        ) {
                            error!("Failed to restart engine for rclone path change: {e}");
                        }
                        info!(
                            "Rclone path updated to: {}",
                            match rclone_state.rclone_path.read() {
                                Ok(path) => path.to_string_lossy().to_string(),
                                Err(e) => {
                                    error!("Failed to read rclone_path for logging: {e}");
                                    return;
                                }
                            }
                        );
                    }

                    if let Some(max_items) = core.get("max_tray_items").and_then(|v| v.as_u64()) {
                        debug!("🗂️ Max tray items changed to: {max_items}");
                        let app = app_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = update_tray_menu(app, max_items as usize).await {
                                error!("Failed to update tray menu: {e}");
                            }
                        });
                    }

                    if let Some(terminal_apps) =
                        core.get("terminal_apps").and_then(|v| v.as_array())
                    {
                        debug!("🖥️ Terminal apps changed: {terminal_apps:?}");
                        let rclone_state = app_handle.state::<RcloneState>();
                        let mut terminal_apps_guard = match rclone_state.terminal_apps.write() {
                            Ok(g) => g,
                            Err(e) => {
                                error!("Failed to write terminal_apps: {e}");
                                return;
                            }
                        };
                        *terminal_apps_guard = terminal_apps
                            .iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect::<Vec<String>>();
                    }
                }

                if let Some(developer) = settings.get("developer") {
                    if let Some(debug_logging) =
                        developer.get("debug_logging").and_then(|v| v.as_bool())
                    {
                        debug!("🐞 Debug logging changed to: {debug_logging}");
                        update_log_level(debug_logging);
                    }

                    if let Some(destroy_window) = developer
                        .get("destroy_window_on_close")
                        .and_then(|v| v.as_bool())
                    {
                        debug!("♻️ Destroy window on close changed to: {destroy_window}");
                        let rclone_state = app_handle.state::<RcloneState>();
                        let mut guard = match rclone_state.destroy_window_on_close.write() {
                            Ok(g) => g,
                            Err(e) => {
                                error!("Failed to write destroy_window_on_close: {e}");
                                return;
                            }
                        };
                        *guard = destroy_window;
                    }
                }
            }
            Err(e) => error!("❌ Failed to parse settings change: {e}"),
        }
    });
}

pub fn setup_event_listener(app: &AppHandle) {
    handle_ctrl_c(app);

    handle_rclone_password_stored(app);
    handle_remote_state_changed(app);
    handle_serve_state_changed(app);
    handle_remote_presence_changed(app);
    handle_settings_changed(app);
    tray_menu_updated(app);
    handle_job_cache_changed(app);
    debug!("✅ Event listeners set up");
}
