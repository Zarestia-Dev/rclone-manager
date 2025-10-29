use log::{debug, error, info};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::{
    RcloneState,
    core::{lifecycle::shutdown::handle_shutdown, tray::core::update_tray_menu},
    rclone::{
        commands::set_bandwidth_limit,
        engine::ENGINE,
        state::{CACHE, ENGINE_STATE},
    },
    utils::{app::builder::setup_tray, logging::log::update_log_level},
};

mod events {
    pub const RCLONE_ENGINE: &str = "rclone_engine";
    pub const RCLONE_API_URL_UPDATED: &str = "rclone_api_url_updated";
    pub const REMOTE_STATE_CHANGED: &str = "remote_state_changed";
    pub const REMOTE_PRESENCE_CHANGED: &str = "remote_presence_changed";
    pub const SYSTEM_SETTINGS_CHANGED: &str = "system_settings_changed";
    pub const TRAY_MENU_UPDATED: &str = "tray_menu_updated";
    pub const JOB_CACHE_CHANGED: &str = "job_cache_changed";
}

fn parse_payload<T: for<'de> serde::Deserialize<'de>>(payload: Option<&str>) -> Result<T, String> {
    payload
        .ok_or_else(|| "No payload".into())
        .and_then(|p| serde_json::from_str(p).map_err(|e| e.to_string()))
}

async fn refresh_and_update_tray(app: AppHandle, max_items: usize) {
    CACHE.refresh_all(app.clone()).await;
    if let Err(e) = update_tray_menu(app, max_items).await {
        error!("Failed to update tray menu: {e}");
    }
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

fn handle_rclone_api_url_updated(app: &AppHandle) {
    let app_handle = app.clone();
    app.listen(events::RCLONE_API_URL_UPDATED, move |_| {
        let app = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            let port = ENGINE_STATE.get_api().1;
            let result = tauri::async_runtime::spawn_blocking(move || {
                let mut engine = match ENGINE.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                engine.update_port(&app, port)
            })
            .await;

            if let Err(e) = result {
                error!("Failed to update Rclone API port: {e}");
            }
        });
    });
}

fn handle_rclone_api_ready(app: &AppHandle) {
    let app_clone = app.clone();
    app.listen(events::RCLONE_ENGINE, move |event| {
        let app = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            // Parse the payload as JSON
            if let Ok(payload) = parse_payload::<serde_json::Value>(Some(event.payload())) {
                match payload.get("status").and_then(|s| s.as_str()) {
                    Some("ready") => {
                        debug!("RCLONE_ENGINE is ready");
                        if let Some(port) = payload.get("port") {
                            debug!("API ready on port: {}", port);
                        }
                        refresh_and_update_tray(app, 0).await;
                    }
                    Some("password_stored") => {
                        // Clear the engine flag and attempt a restart if engine not running
                        tauri::async_runtime::spawn_blocking(move || {
                            let mut engine = match ENGINE.lock() {
                                Ok(guard) => guard,
                                Err(poisoned) => poisoned.into_inner(),
                            };

                            engine.password_error = false;
                        });
                    }
                    Some("error") => {
                        if let Some(message) = payload.get("message").and_then(|m| m.as_str()) {
                            error!("RCLONE_ENGINE error: {}", message);
                        } else {
                            error!("RCLONE_ENGINE encountered an error");
                        }
                    }
                    Some(status) => {
                        debug!("RCLONE_ENGINE unknown status: {}", status);
                    }
                    _ => {}
                }
            }
        });
    });
}

fn handle_remote_state_changed(app: &AppHandle) {
    let app_clone = app.clone();
    app.listen(events::REMOTE_STATE_CHANGED, move |event| {
        debug!(
            "🔄 Remote state changed! Raw payload: {:?}",
            event.payload()
        );
        let app = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = CACHE.refresh_mounted_remotes(app.clone()).await {
                error!("Failed to refresh mounted remotes: {e}");
            }
            if let Err(e) = update_tray_menu(app.clone(), 0).await {
                error!("Failed to update tray menu: {e}");
            }

            let _ = app
                .clone()
                .emit("mount_cache_updated", "remote_presence")
                .map_err(|e| {
                    error!("❌ Failed to emit event to frontend: {e}");
                });
        });
    });
}

fn handle_remote_presence_changed(app: &AppHandle) {
    let app_clone = app.clone();
    app.listen(events::REMOTE_PRESENCE_CHANGED, move |_| {
        let app_clone = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            let refresh_tasks = tokio::join!(
                CACHE.refresh_remote_list(app_clone.clone()),
                CACHE.refresh_remote_configs(app_clone.clone()),
                CACHE.refresh_remote_settings(app_clone.clone()),
            );
            if let (Err(e1), Err(e2), Err(e3)) = refresh_tasks {
                error!("Failed to refresh cache: {e1}, {e2}, {e3}");
            }
            if let Err(e) = update_tray_menu(app_clone.clone(), 0).await {
                error!("Failed to update tray menu: {e}");
            }

            let _ = app_clone
                .emit("remote_cache_updated", "remote_presence")
                .map_err(|e| {
                    error!("❌ Failed to emit event to frontend: {e}");
                });
        });
    });
}

fn tray_menu_updated(app: &AppHandle) {
    let app_clone = app.clone();
    app.listen(events::TRAY_MENU_UPDATED, move |_| {
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
    app.listen(events::JOB_CACHE_CHANGED, move |event| {
        debug!("🔄 Job cache changed! Raw payload: {:?}", event.payload());

        let app = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = update_tray_menu(app, 0).await {
                error!("Failed to update tray menu: {e}");
            }
        });
    });
}

fn handle_settings_changed(app: &AppHandle) {
    let app_handle = app.clone();

    let app_handle_clone = app_handle.clone();
    app.listen(events::SYSTEM_SETTINGS_CHANGED, move |event| {
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
                        let mut guard =
                            notifications_enabled.notifications_enabled.write().unwrap();
                        *guard = notification;
                    }

                    if let Some(startup) = general.get("start_on_startup").and_then(|v| v.as_bool())
                    {
                        debug!("🚀 Start on Startup changed to: {startup}");
                        let autostart = app_handle.autolaunch();
                        let _ = if startup {
                            autostart.enable()
                        } else {
                            autostart.disable()
                        };
                    }

                    if let Some(tray_enabled) =
                        general.get("tray_enabled").and_then(|v| v.as_bool())
                    {
                        let app_handle_clone = app_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            let tray_state = app_handle_clone.state::<RcloneState>();
                            let mut guard = tray_state.tray_enabled.write().unwrap();
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
                    if let Some(restrict) = general.get("restrict").and_then(|v| v.as_bool()) {
                        debug!("🔒 Restrict mode changed to: {restrict}");
                        let rclone_state = app_handle.state::<RcloneState>();
                        let mut guard = rclone_state.restrict_mode.write().unwrap();
                        *guard = restrict;
                        let app_handle_clone = app_handle.clone();
                        app_handle_clone
                            .emit("remote_presence_changed", "restrict_mode_changed")
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
                            // Get the RcloneState from tauri's state management
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
                        let old_rclone_config_file =
                            rclone_state.rclone_config_file.read().unwrap().to_string();
                        let mut guard = rclone_state.rclone_config_file.write().unwrap();
                        *guard = config_path.to_string();
                        drop(guard); // Release the lock

                        // Restart engine with new rclone config file
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
                            rclone_state.rclone_config_file.read().unwrap()
                        );

                        // let config_path = config_path.to_string();
                        // let app_handle_clone = app_handle.clone();
                        // tauri::async_runtime::spawn(async move {
                        //     if let Err(e) = set_rclone_config_file(app_handle_clone.clone(), config_path).await {
                        //         error!("Failed to set Rclone config path: {e}");
                        //     }
                        // });
                    }

                    if let Some(rclone_path) = core.get("rclone_path").and_then(|v| v.as_str()) {
                        debug!("🔄 Rclone path changed to: {rclone_path}");
                        let rclone_state = app_handle.state::<RcloneState>();
                        let old_rclone_path = rclone_state.rclone_path.read().unwrap().clone();
                        debug!("Old rclone path: {}", old_rclone_path.to_string_lossy());
                        {
                            let mut path_guard = rclone_state.rclone_path.write().unwrap();
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
                            rclone_state.rclone_path.read().unwrap().to_string_lossy()
                        );
                    }

                    if let Some(api_port) = core.get("rclone_api_port").and_then(|v| v.as_u64()) {
                        debug!("🔌 Rclone API Port changed to: {api_port}");
                        let old_port = ENGINE_STATE.get_api().1.to_string();

                        if let Err(e) = ENGINE_STATE
                            .set_api(format!("http://127.0.0.1:{api_port}"), api_port as u16)
                        {
                            error!("Failed to set Rclone API Port: {e}");
                        } else {
                            // Restart engine with new API port
                            if let Err(e) =
                                crate::rclone::engine::lifecycle::restart_for_config_change(
                                    &app_handle,
                                    "api_port",
                                    &old_port,
                                    &api_port.to_string(),
                                )
                            {
                                error!("Failed to restart engine for API port change: {e}");
                            }
                        }
                    }

                    if let Some(oauth_port) = core.get("rclone_oauth_port").and_then(|v| v.as_u64())
                    {
                        debug!("🔑 Rclone OAuth Port changed to: {oauth_port}");
                        if let Err(e) = ENGINE_STATE
                            .set_oauth(format!("http://127.0.0.1:{oauth_port}"), oauth_port as u16)
                        {
                            error!("Failed to set Rclone OAuth Port: {e}");
                        }
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
                        let mut terminal_apps_guard = rclone_state.terminal_apps.write().unwrap();
                        *terminal_apps_guard = terminal_apps
                            .iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect::<Vec<String>>();
                    }
                }

                if let Some(developer) = settings.get("developer")
                    && let Some(debug_logging) =
                        developer.get("debug_logging").and_then(|v| v.as_bool())
                {
                    debug!("🐞 Debug logging changed to: {debug_logging}");
                    update_log_level(debug_logging);
                }
            }
            Err(e) => error!("❌ Failed to parse settings change: {e}"),
        }
    });
}

pub fn setup_event_listener(app: &AppHandle) {
    handle_ctrl_c(app);
    handle_rclone_api_url_updated(app);
    handle_rclone_api_ready(app);
    handle_remote_state_changed(app);
    handle_remote_presence_changed(app);
    handle_settings_changed(app);
    tray_menu_updated(app);
    handle_job_cache_changed(app);
    debug!("✅ Event listeners set up");
}
