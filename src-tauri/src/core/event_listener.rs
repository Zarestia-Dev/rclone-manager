use log::{debug, error, info};
use serde_json::Value;
use tauri::{AppHandle, Manager};

#[cfg(all(desktop, not(all(target_os = "linux", feature = "flatpak"))))]
use tauri_plugin_autostart::ManagerExt;

use crate::{
    core::{
        automation::commands::reload_automations_from_configs, bridge::event::BridgeEvent,
        lifecycle::shutdown::shutdown_app,
    },
    rclone::{backend::BackendManager, commands::system::bandwidth_limit},
    utils::{
        logging::log::update_log_level,
        types::{
            events::{
                JOB_CACHE_CHANGED, JobChangeEvent, RCLONE_PASSWORD_STORED, REMOTE_CACHE_CHANGED,
                SYSTEM_SETTINGS_CHANGED, SettingsChangeEvent,
            },
            state::EngineState,
        },
    },
};

#[cfg(any(
    feature = "tray",
    all(
        feature = "desktop",
        not(any(target_os = "android", target_os = "ios"))
    )
))]
use crate::utils::types::events::{MOUNT_STATE_CHANGED, SERVE_STATE_CHANGED};

#[cfg(feature = "tray")]
use crate::utils::types::events::{BACKEND_SWITCHED, REMOTE_SETTINGS_CHANGED, UPDATE_TRAY_MENU};

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
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<EngineState>();
        let mut engine = state.lock().await;
        engine.clear_errors();
        engine.init(&app).await;
    });
}

fn handle_remote_presence_changed(app: &AppHandle, payload: &Value) {
    if payload.as_str() == Some("system_refresh") {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let cache = &app.state::<BackendManager>().remote_cache;

        let (r1, r2) = tokio::join!(
            cache.refresh_remote_list(app.clone()),
            cache.refresh_remote_configs(app.clone()),
        );
        if let (Err(e1), Err(e2)) = (r1, r2) {
            error!("Failed to refresh cache: {e1}, {e2}");
        }

        if let Err(e) = reload_automations_from_configs(&app).await {
            error!("Failed to reload automations after remote change: {e}");
        }

        #[cfg(feature = "tray")]
        trigger_tray_update(app);
    });
}

fn handle_settings_changed(app: &AppHandle, payload: &Value) {
    debug!("Settings saved. Payload: {:?}", payload);

    match serde_json::from_value::<SettingsChangeEvent>(payload.clone()) {
        Ok(change) => match (change.category.as_str(), change.key.as_str()) {
            #[cfg(feature = "tauri-plugin-notification")]
            ("general", "notifications") => {
                if let Some(enabled) = change.value.as_bool() {
                    handle_notifications_change(app, enabled);
                }
            }
            #[cfg(all(target_os = "linux", feature = "flatpak"))]
            ("general", "start_on_startup") => {
                if let Some(startup) = change.value.as_bool() {
                    handle_autostart_change(startup);
                }
            }
            #[cfg(all(desktop, not(all(target_os = "linux", feature = "flatpak"))))]
            ("general", "start_on_startup") => {
                if let Some(startup) = change.value.as_bool() {
                    handle_autostart_change(app, startup);
                }
            }
            #[cfg(feature = "tray")]
            ("general", "tray_enabled") => {
                if let Some(enabled) = change.value.as_bool() {
                    handle_tray_visibility_change(app, enabled);
                }
            }
            #[cfg(feature = "tray")]
            ("general", "tray_icon_theme") => {
                trigger_tray_update(app.clone());
            }
            ("general", "restrict") => {
                if let Some(restrict) = change.value.as_bool() {
                    handle_restrict_mode_change(restrict);
                }
            }
            ("general", "language") => {
                if let Some(lang) = change.value.as_str() {
                    crate::utils::i18n::apply_language_change(lang);
                }
            }
            #[cfg(all(
                feature = "desktop",
                not(any(target_os = "android", target_os = "ios"))
            ))]
            ("general", "prevent_sleep") => {
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    crate::core::power::update_power_inhibition(&app_clone).await;
                });
            }
            ("core", "bandwidth_limit") => {
                handle_bandwidth_limit_change(app, &change.value);
            }
            ("core", "rclone_binary") => {
                if let Some(path) = change.value.as_str() {
                    handle_rclone_binary_change(app, path);
                }
            }
            ("core", "rclone_additional_flags") => {
                if let Some(flags) = change.value.as_array() {
                    handle_rclone_flags_change(app, flags);
                }
            }
            #[cfg(feature = "tray")]
            ("core", "max_tray_items") => {
                if let Some(max) = change.value.as_u64() {
                    handle_max_tray_items_change(app, max);
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
            _ => debug!(
                "Unhandled setting change: {}.{}",
                change.category, change.key
            ),
        },
        Err(e) => error!("Failed to parse settings change: {e}"),
    }
}

#[cfg(feature = "tauri-plugin-notification")]
fn handle_notifications_change(app: &AppHandle, enabled: bool) {
    debug!("Notifications changed to: {enabled}");
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        use crate::core::alerts::cache;

        let manager = app.state::<crate::core::settings::AppSettingsManager>();
        let mut updated = false;

        if cache::get_action(&manager, "default-os-toast").is_none()
            || cache::get_rule(&manager, "default-rule").is_none()
        {
            let _ = crate::core::alerts::seed::seed_defaults(&manager);
            updated = true;
        }

        if let Some(mut action) = cache::get_action(&manager, "default-os-toast")
            && action.is_enabled() != enabled
        {
            action.set_enabled(enabled);
            let _ = cache::upsert_action(&manager, action);
            updated = true;
        }

        if let Some(mut rule) = cache::get_rule(&manager, "default-rule")
            && rule.enabled != enabled
        {
            rule.enabled = enabled;
            let _ = cache::upsert_rule(&manager, rule);
            updated = true;
        }

        if updated {
            let alert_cache = app.state::<cache::AlertRuleCache>();
            alert_cache.reload_actions(&manager).await;
            alert_cache.reload_rules(&manager).await;

            crate::core::bridge::emit(
                SYSTEM_SETTINGS_CHANGED,
                SettingsChangeEvent {
                    category: "alerts".to_string(),
                    key: "*".to_string(),
                    value: serde_json::Value::Null,
                },
            );
        }
    });
}

#[cfg(all(target_os = "linux", feature = "flatpak"))]
fn handle_autostart_change(enabled: bool) {
    debug!("Autostart changed to: {enabled}");
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::utils::app::platform::manage_flatpak_background_portal(enabled).await
        {
            error!("Failed to update flatpak autostart: {e}");
        }
    });
}

#[cfg(all(desktop, not(all(target_os = "linux", feature = "flatpak"))))]
fn handle_autostart_change(app: &AppHandle, enabled: bool) {
    debug!("Autostart changed to: {enabled}");
    let autostart = app.autolaunch();
    let _ = if enabled {
        autostart.enable()
    } else {
        autostart.disable()
    };
}

fn handle_restrict_mode_change(enabled: bool) {
    debug!("Restrict mode changed to: {enabled}");
    crate::core::bridge::emit(REMOTE_CACHE_CHANGED, "restrict_mode_changed");
}

fn handle_bandwidth_limit_change(app: &AppHandle, value: &Value) {
    debug!("Bandwidth limit changed to: {value}");
    let app = app.clone();
    let limit = value
        .as_str()
        .map(String::from)
        .or_else(|| value.as_u64().map(|n| n.to_string()));

    tauri::async_runtime::spawn(async move {
        if let Err(e) = bandwidth_limit(app, limit).await {
            error!("Failed to set bandwidth limit: {e:?}");
        }
    });
}

fn handle_rclone_binary_change(app: &AppHandle, path: &str) {
    debug!("Rclone binary changed to: {path}");
    crate::rclone::engine::lifecycle::restart_for_config_change(app, "rclone_binary");
    info!("Rclone binary updated to: {path}");
}

fn handle_rclone_flags_change(app: &AppHandle, flags: &[Value]) {
    debug!("Rclone additional flags changed to: {flags:?}");
    crate::rclone::engine::lifecycle::restart_for_config_change(app, "rclone_additional_flags");
    info!("Engine restarting due to additional flags change");
}

fn handle_job_cache_changed(app: &AppHandle, payload: &Value) {
    let app = app.clone();
    let payload = payload.clone();

    tauri::async_runtime::spawn(async move {
        if let Ok(ev) = serde_json::from_value::<JobChangeEvent>(payload)
            && let Ok(id) = ev.job_id.parse::<u64>()
            && let Some(job) = app.state::<BackendManager>().job_cache.get_job(id).await
        {
            #[cfg(feature = "tray")]
            if job.job_type.is_tray_relevant() {
                trigger_tray_update(app.clone());
            }

            if job.status.is_finished() {
                crate::core::flow::workflow::engine::trigger_workflows_for_job_finish(&app, &job)
                    .await;
            }

            #[cfg(all(
                feature = "desktop",
                not(any(target_os = "android", target_os = "ios"))
            ))]
            crate::core::power::update_power_inhibition(&app).await;
        }
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

fn dispatch_bridge_event(app: &AppHandle, event: BridgeEvent) {
    match event.event.as_str() {
        RCLONE_PASSWORD_STORED => {
            handle_rclone_password_stored(app);
        }
        REMOTE_CACHE_CHANGED => {
            handle_remote_presence_changed(app, &event.payload);
        }
        SYSTEM_SETTINGS_CHANGED => {
            handle_settings_changed(app, &event.payload);
        }
        JOB_CACHE_CHANGED => {
            handle_job_cache_changed(app, &event.payload);
        }
        #[cfg(feature = "tray")]
        SERVE_STATE_CHANGED
        | MOUNT_STATE_CHANGED
        | BACKEND_SWITCHED
        | REMOTE_SETTINGS_CHANGED
        | UPDATE_TRAY_MENU => {
            trigger_tray_update(app.clone());
        }
        _ => {}
    }

    #[cfg(all(
        feature = "desktop",
        not(any(target_os = "android", target_os = "ios"))
    ))]
    if event.event == SERVE_STATE_CHANGED || event.event == MOUNT_STATE_CHANGED {
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            crate::core::power::update_power_inhibition(&app_clone).await;
        });
    }
}

pub fn setup_event_listener(app: &AppHandle) {
    handle_ctrl_c(app);

    let Some(mut rx) = crate::core::bridge::subscribe() else {
        error!("Failed to subscribe to EventBridge: bridge not initialized");
        return;
    };

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    dispatch_bridge_event(&app, event);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    debug!("Event listener lagged behind, skipped {skipped} events");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    debug!("EventBridge closed, terminating listener loop");
                    break;
                }
            }
        }
    });

    debug!("Event listeners set up");
}
