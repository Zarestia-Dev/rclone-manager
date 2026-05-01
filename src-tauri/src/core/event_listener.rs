use crate::core::{
    scheduler::commands::reload_scheduled_tasks_from_configs, settings::AppSettingsManager,
};
use log::{debug, error, info};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::{
    core::lifecycle::shutdown::shutdown_app,
    rclone::commands::system::set_bandwidth_limit,
    utils::{
        logging::log::update_log_level,
        types::events::{
            JOB_CACHE_CHANGED, RCLONE_PASSWORD_STORED, REMOTE_CACHE_CHANGED,
            SYSTEM_SETTINGS_CHANGED, SettingsChangeEvent,
        },
    },
};

fn parse_payload<T: for<'de> serde::Deserialize<'de>>(payload: &str) -> Result<T, String> {
    serde_json::from_str(payload).map_err(|e| e.to_string())
}

#[cfg(feature = "tray")]
fn trigger_tray_update(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::core::tray::core::update_tray_menu(app).await {
            error!("Failed to update tray menu: {e}");
        }
    });
}

fn handle_ctrl_c(app: &AppHandle) {
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = tokio::signal::ctrl_c().await {
            error!("Failed to install Ctrl+C handler: {e}");
            return;
        }
        info!("Ctrl+C received, initiating shutdown");
        let _ = shutdown_app(app_clone.clone()).await;
        app_clone.exit(0);
    });
}

fn handle_rclone_password_stored(app: &AppHandle) {
    let app_clone = app.clone();
    app.listen(RCLONE_PASSWORD_STORED, move |_| {
        let app = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            use crate::utils::types::core::EngineState;
            app.state::<EngineState>()
                .lock()
                .await
                .set_password_error(false);
        });
    });
}

fn handle_remote_presence_changed(app: &AppHandle) {
    let app_clone = app.clone();
    app.listen(REMOTE_CACHE_CHANGED, move |_| {
        let app = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            use crate::rclone::backend::BackendManager;
            let cache = &app.state::<BackendManager>().remote_cache;

            let (r1, r2) = tokio::join!(
                cache.refresh_remote_list(app.clone()),
                cache.refresh_remote_configs(app.clone()),
            );
            if let (Err(e1), Err(e2)) = (r1, r2) {
                error!("Failed to refresh cache: {e1}, {e2}");
            }

            let remote_names = cache.get_remotes().await;
            let all_configs = crate::core::settings::remote::manager::get_all_remote_settings_sync(
                app.state::<AppSettingsManager>().inner(),
                &remote_names,
            );

            if let Err(e) = reload_scheduled_tasks_from_configs(app.clone(), all_configs).await {
                error!("Failed to reload scheduled tasks after remote change: {e}");
            }

            #[cfg(feature = "tray")]
            trigger_tray_update(app);
        });
    });
}

fn handle_settings_changed(app: &AppHandle) {
    let app_clone = app.clone();
    app.listen(SYSTEM_SETTINGS_CHANGED, move |event| {
        let app = app_clone.clone();
        debug!("Settings saved. Payload: {:?}", event.payload());

        match parse_payload::<SettingsChangeEvent>(event.payload()) {
            Ok(change) => match (change.category.as_str(), change.key.as_str()) {
                ("general", "notifications") => {
                    if let Some(enabled) = change.value.as_bool() {
                        debug!("Notifications changed to: {enabled}");
                        tauri::async_runtime::spawn(async move {
                            use crate::core::alerts::cache;
                            let manager = app.state::<AppSettingsManager>();
                            let _ = crate::core::alerts::seed::seed_defaults(&manager);

                            if let Some(mut action) =
                                cache::get_action(&manager, "default-os-toast")
                                && action.is_enabled() != enabled
                            {
                                action.set_enabled(enabled);
                                let _ = cache::upsert_action(&manager, action);
                            }

                            if let Some(mut rule) = cache::get_rule(&manager, "default-rule")
                                && rule.enabled != enabled
                            {
                                rule.enabled = enabled;
                                let _ = cache::upsert_rule(&manager, rule);
                            }
                        });
                    }
                }
                ("general", "start_on_startup") => {
                    if let Some(startup) = change.value.as_bool() {
                        handle_autostart_change(&app, startup);
                    }
                }
                #[cfg(feature = "tray")]
                ("general", "tray_enabled") => {
                    if let Some(enabled) = change.value.as_bool() {
                        handle_tray_visibility_change(&app, enabled);
                    }
                }
                ("general", "restrict") => {
                    if let Some(restrict) = change.value.as_bool() {
                        handle_restrict_mode_change(&app, restrict);
                    }
                }
                ("general", "language") => {
                    if let Some(lang) = change.value.as_str() {
                        handle_language_change(&app, lang);
                    }
                }
                ("core", "bandwidth_limit") => {
                    handle_bandwidth_limit_change(&app, &change.value);
                }
                ("core", "rclone_binary") => {
                    if let Some(path) = change.value.as_str() {
                        handle_rclone_binary_change(&app, path);
                    }
                }
                ("core", "rclone_additional_flags") => {
                    if let Some(flags) = change.value.as_array() {
                        handle_rclone_flags_change(&app, flags);
                    }
                }
                #[cfg(feature = "tray")]
                ("core", "max_tray_items") => {
                    if let Some(max) = change.value.as_u64() {
                        handle_max_tray_items_change(&app, max);
                    }
                }
                ("developer", "log_level") => {
                    if let Some(level) = change.value.as_str() {
                        debug!("Log level changed to: {level}");
                        update_log_level(level);
                    }
                }
                ("developer", "destroy_window_on_close") => {
                    if let Some(destroy) = change.value.as_bool() {
                        debug!("Destroy window on close changed to: {destroy}");
                    }
                }
                ("*", "*") => {
                    info!("Global settings reset detected, re-initializing core components");
                    handle_global_reset(&app);
                }
                ("*", "hot_reload") => {
                    if let Some(path) = change.value.get("path").and_then(|p| p.as_str()) {
                        info!("Hot reload applied from {path}");
                    } else {
                        info!("Hot reload applied");
                    }
                }
                _ => debug!(
                    "Unhandled setting change: {}.{}",
                    change.category, change.key
                ),
            },
            Err(e) => error!("Failed to parse settings change: {e}"),
        }
    });
}

fn handle_autostart_change(_app: &AppHandle, enabled: bool) {
    debug!("Autostart changed to: {enabled}");

    #[cfg(feature = "flatpak")]
    {
        use crate::utils::app::platform::manage_flatpak_autostart;
        if let Err(e) = manage_flatpak_autostart(enabled) {
            error!("Failed to update flatpak autostart: {e}");
        }
    }

    #[cfg(all(desktop, not(feature = "flatpak")))]
    {
        use tauri_plugin_autostart::ManagerExt;
        let autostart = _app.autolaunch();
        let _ = if enabled {
            autostart.enable()
        } else {
            autostart.disable()
        };
    }
}

fn handle_restrict_mode_change(app: &AppHandle, enabled: bool) {
    debug!("Restrict mode changed to: {enabled}");
    if let Err(e) = app.emit(REMOTE_CACHE_CHANGED, "restrict_mode_changed") {
        error!("Failed to emit remote cache changed event: {e}");
    }
}

fn handle_language_change(app: &AppHandle, lang: &str) {
    debug!("Language changed to: {lang}");
    crate::utils::i18n::set_language(lang);

    if let Err(e) = app.emit(
        crate::utils::types::events::APP_EVENT,
        serde_json::json!({ "status": "language_changed", "language": lang }),
    ) {
        error!("Failed to emit language change event: {e}");
    }

    #[cfg(feature = "tray")]
    trigger_tray_update(app.clone());
}

fn handle_bandwidth_limit_change(app: &AppHandle, value: &Value) {
    debug!("Bandwidth limit changed to: {value}");
    let app = app.clone();
    let limit = if value.is_null() {
        None
    } else if let Some(s) = value.as_str() {
        Some(s.to_string())
    } else {
        value.as_u64().map(|n| n.to_string())
    };

    tauri::async_runtime::spawn(async move {
        if let Err(e) = set_bandwidth_limit(app, limit).await {
            error!("Failed to set bandwidth limit: {e:?}");
        }
    });
}

fn handle_rclone_binary_change(app: &AppHandle, path: &str) {
    debug!("Rclone binary changed to: {path}");
    match crate::rclone::engine::lifecycle::restart_for_config_change(
        app,
        "rclone_binary",
        "previous",
        path,
    ) {
        Ok(()) => info!("Rclone binary updated to: {path}"),
        Err(e) => error!("Failed to restart engine for rclone binary change: {e}"),
    }
}

fn handle_rclone_flags_change(app: &AppHandle, flags: &[Value]) {
    debug!("Rclone additional flags changed to: {flags:?}");
    let flags_str = serde_json::to_string(flags).unwrap_or_default();
    match crate::rclone::engine::lifecycle::restart_for_config_change(
        app,
        "rclone_additional_flags",
        "previous",
        &flags_str,
    ) {
        Ok(()) => info!("Engine restarting due to additional flags change"),
        Err(e) => error!("Failed to restart engine for flags change: {e}"),
    }
}

fn handle_global_reset(app: &AppHandle) {
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = set_bandwidth_limit(app_clone.clone(), None).await;
        crate::utils::i18n::set_language("en");
        #[cfg(feature = "tray")]
        trigger_tray_update(app_clone);
    });
}

fn handle_job_cache_changed(app: &AppHandle) {
    let app_clone = app.clone();
    app.listen(JOB_CACHE_CHANGED, move |event| {
        let app = app_clone.clone();
        let payload = event.payload().trim_matches('"').to_string();

        tauri::async_runtime::spawn(async move {
            if let Ok(jobid) = payload.parse::<u64>() {
                use crate::rclone::backend::BackendManager;
                let cache = &app.state::<BackendManager>().job_cache;
                if let Some(job) = cache.get_job(jobid).await
                    && !job.job_type.is_tray_relevant()
                {
                    return;
                }
            }
            #[cfg(feature = "tray")]
            trigger_tray_update(app);
        });
    });
}

#[cfg(feature = "tray")]
fn handle_max_tray_items_change(app: &AppHandle, max: u64) {
    debug!("Max tray items changed to: {max}");
    trigger_tray_update(app.clone());
}

#[cfg(feature = "tray")]
fn handle_tray_visibility_change(app: &AppHandle, enabled: bool) {
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        debug!("Tray visibility changed to: {enabled}");
        if let Some(tray) = app_clone.tray_by_id("main-tray") {
            let _ = tray.set_visible(enabled);
        } else if let Err(e) = crate::utils::app::builder::setup_tray(app_clone).await {
            error!("Failed to set up tray: {e}");
        }
    });
}

// These listeners all just trigger a tray update; keep them as a group rather
// than duplicating the boilerplate across separate functions.
#[cfg(feature = "tray")]
fn register_tray_refresh_listeners(app: &AppHandle) {
    use crate::utils::types::events::{
        BACKEND_SWITCHED, MOUNT_STATE_CHANGED, REMOTE_SETTINGS_CHANGED, SERVE_STATE_CHANGED,
        UPDATE_TRAY_MENU,
    };

    for event in [
        SERVE_STATE_CHANGED,
        MOUNT_STATE_CHANGED,
        BACKEND_SWITCHED,
        REMOTE_SETTINGS_CHANGED,
        UPDATE_TRAY_MENU,
    ] {
        let app_clone = app.clone();
        app.listen(event, move |_| trigger_tray_update(app_clone.clone()));
    }
}

pub fn setup_event_listener(app: &AppHandle) {
    #[cfg(feature = "tray")]
    register_tray_refresh_listeners(app);

    handle_ctrl_c(app);
    handle_rclone_password_stored(app);
    handle_remote_presence_changed(app);
    handle_settings_changed(app);
    handle_job_cache_changed(app);
    debug!("Event listeners set up");
}
