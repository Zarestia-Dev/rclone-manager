use crate::core::settings::AppSettingsManager;
use log::{debug, error, info};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::{
    core::{lifecycle::shutdown::handle_shutdown, scheduler::engine::CronScheduler},
    rclone::{
        commands::system::set_bandwidth_limit,
        state::scheduled_tasks::{ScheduledTasksCache, reload_scheduled_tasks_from_configs},
    },
    utils::{
        logging::log::update_log_level,
        types::{
            core::RcloneState,
            events::{
                JOB_CACHE_CHANGED, RCLONE_PASSWORD_STORED, REMOTE_CACHE_CHANGED,
                SERVE_STATE_CHANGED, SYSTEM_SETTINGS_CHANGED, UPDATE_TRAY_MENU,
            },
        },
    },
};

// ============================================================================
// Platform-specific stubs
// ============================================================================

#[cfg(desktop)]
use crate::{core::tray::core::update_tray_menu, utils::app::builder::setup_tray};

#[cfg(not(desktop))]
async fn update_tray_menu(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(not(desktop))]
async fn setup_tray(_app: AppHandle, _max_items: usize) -> tauri::Result<()> {
    Ok(())
}

// ============================================================================
// Helpers
// ============================================================================

fn parse_payload<T: for<'de> serde::Deserialize<'de>>(payload: Option<&str>) -> Result<T, String> {
    payload
        .ok_or_else(|| "No payload".into())
        .and_then(|p| serde_json::from_str(p).map_err(|e| e.to_string()))
}

// ============================================================================
// Event Handlers
// ============================================================================

fn handle_ctrl_c(app: &AppHandle) {
    let app_handle_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        use tokio::signal::ctrl_c;
        if let Err(e) = ctrl_c().await {
            error!("Failed to install Ctrl+C handler: {}", e);
            return;
        }
        info!("🧹 Ctrl+C received via tokio. Initiating shutdown...");
        handle_shutdown(app_handle_clone.clone()).await;
        app_handle_clone.exit(0);
    });
}

fn handle_rclone_password_stored(app: &AppHandle) {
    let app_clone = app.clone();
    app.listen(RCLONE_PASSWORD_STORED, move |_| {
        let app = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            use crate::utils::types::core::EngineState;
            let state = app.state::<EngineState>();
            let mut engine = state.lock().await;
            engine.set_password_error(false);
        });
    });
}

fn handle_remote_presence_changed(app: &AppHandle) {
    let app_clone = app.clone();
    // Listen for consolidated cache change event
    app.listen(REMOTE_CACHE_CHANGED, move |_| {
        let app_clone = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            let client = app_clone.state::<RcloneState>().client.clone();

            let backend = crate::rclone::backend::BACKEND_MANAGER.get_active().await;
            let cache = &crate::rclone::backend::BACKEND_MANAGER.remote_cache;

            let refresh_tasks: (Result<(), String>, Result<(), String>) = tokio::join!(
                cache.refresh_remote_list(&client, &backend),
                cache.refresh_remote_configs(&client, &backend),
            );

            if let (Err(e1), Err(e2)) = refresh_tasks {
                error!("Failed to refresh cache: {e1}, {e2}");
            }

            let remote_names = cache.get_remotes().await;
            let manager = app_clone.state::<AppSettingsManager>();

            // Note: This is a synchronous call, might block momentarily but is usually fast
            let all_configs = crate::core::settings::remote::manager::get_all_remote_settings_sync(
                manager.inner(),
                &remote_names,
            );

            let cache_state = app_clone.state::<ScheduledTasksCache>();
            let scheduler_state = app_clone.state::<CronScheduler>();

            if let Err(e) = reload_scheduled_tasks_from_configs(
                cache_state,
                scheduler_state,
                all_configs,
                app_clone.clone(),
            )
            .await
            {
                error!("❌ Failed to reload scheduled tasks after remote change: {e}");
            }

            if let Err(e) = update_tray_menu(app_clone.clone()).await {
                error!("Failed to update tray menu: {e}");
            }
        });
    });
}

// ============================================================================
// Settings Change Handlers (Refactored)
// ============================================================================

fn handle_general_settings_change(app: &AppHandle, general: &Value) {
    // 1. Notifications
    // Note: notifications setting is now read from AppSettingsManager which caches internally
    if let Some(notification) = general.get("notifications").and_then(|v| v.as_bool()) {
        debug!("💬 Notifications changed to: {notification}");
    }

    // 2. Start on Startup
    if let Some(startup) = general.get("start_on_startup").and_then(|v| v.as_bool()) {
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
            let autostart = app.autolaunch();
            let _ = if startup {
                autostart.enable()
            } else {
                autostart.disable()
            };
        }
    }

    // 3. Tray Visibility
    if let Some(tray_enabled) = general.get("tray_enabled").and_then(|v| v.as_bool()) {
        #[cfg(desktop)]
        {
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                debug!("🛠️ Tray visibility changed to: {tray_enabled}");
                if let Some(tray) = app_clone.tray_by_id("main-tray") {
                    let _ = tray.set_visible(tray_enabled);
                } else {
                    let app = app_clone.clone();
                    // Double spawn to ensure independent task if setup_tray blocks/failures shouldn't crash
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = setup_tray(app).await {
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

    // 4. Restrict Mode
    if let Some(restrict) = general.get("restrict").and_then(|v| v.as_bool()) {
        debug!("🔒 Restrict mode changed to: {restrict}");
        // Note: restrict setting is now read from AppSettingsManager which caches internally
        let app_clone = app.clone();
        if let Err(e) = app_clone.emit(REMOTE_CACHE_CHANGED, "restrict_mode_changed") {
            error!("❌ Failed to emit remote presence changed event: {e}");
        }
    }

    // 5. Language
    if let Some(language) = general.get("language").and_then(|v| v.as_str()) {
        debug!("🌐 Language changed to: {language}");
        crate::utils::i18n::set_language(language);

        // Emit APP_EVENT for frontend
        if let Err(e) = app.emit(
            crate::utils::types::events::APP_EVENT,
            serde_json::json!({
                "status": "language_changed",
                "language": language
            }),
        ) {
            error!("❌ Failed to emit language change event: {e}");
        }

        #[cfg(desktop)]
        {
            if let Err(e) = app.emit(UPDATE_TRAY_MENU, ()) {
                error!("❌ Failed to emit tray menu update event: {e}");
            }
        }
    }
}

fn handle_core_settings_change(app: &AppHandle, core: &Value) {
    // 1. Bandwidth Limit
    if let Some(bandwidth_limit) = core.get("bandwidth_limit") {
        debug!("🌐 Bandwidth limit changed to: {bandwidth_limit}");
        let app = app.clone();

        // Parse bandwidth limit safely
        let bandwidth_limit_opt = if bandwidth_limit.is_null() {
            None
        } else if let Some(s) = bandwidth_limit.as_str() {
            Some(s.to_string())
        } else {
            bandwidth_limit.as_u64().map(|n| n.to_string())
        };

        tauri::async_runtime::spawn(async move {
            let rclone_state = app.state::<RcloneState>();
            if let Err(e) =
                set_bandwidth_limit(app.clone(), bandwidth_limit_opt, rclone_state).await
            {
                error!("Failed to set bandwidth limit: {e:?}");
            }
        });
    }

    // 2. Rclone Config Path
    if let Some(rclone_path) = core.get("rclone_path").and_then(|v| v.as_str()) {
        debug!("🔄 Rclone path changed to: {rclone_path}");

        match crate::rclone::engine::lifecycle::restart_for_config_change(
            app,
            "rclone_path",
            "previous",
            rclone_path,
        ) {
            Ok(_) => info!("Rclone path updated to: {rclone_path}"),
            Err(e) => error!("Failed to restart engine for rclone path change: {e}"),
        }
    }

    // 3. Max Tray Items
    if let Some(max_items) = core.get("max_tray_items").and_then(|v| v.as_u64()) {
        debug!("🗂️ Max tray items changed to: {max_items}");
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = update_tray_menu(app).await {
                error!("Failed to update tray menu: {e}");
            }
        });
    }
}

fn handle_developer_settings_change(_app: &AppHandle, developer: &Value) {
    // 1. Log Level
    if let Some(log_level) = developer.get("log_level").and_then(|v| v.as_str()) {
        debug!("📊 Log level changed to: {log_level}");
        update_log_level(log_level);
    }

    // 2. Destroy Window On Close
    if let Some(destroy_window) = developer
        .get("destroy_window_on_close")
        .and_then(|v| v.as_bool())
    {
        debug!("♻️ Destroy window on close changed to: {destroy_window}");
        // Note: destroy_window_on_close is read from AppSettingsManager
    }
}

fn handle_settings_changed(app: &AppHandle) {
    let app_clone = app.clone();
    app.listen(SYSTEM_SETTINGS_CHANGED, move |event| {
        let app = app_clone.clone();
        debug!("🔄 Settings saved! Raw payload: {:?}", event.payload());

        match parse_payload::<Value>(Some(event.payload())) {
            Ok(settings) => {
                if let Some(general) = settings.get("general") {
                    handle_general_settings_change(&app, general);
                }

                if let Some(core) = settings.get("core") {
                    handle_core_settings_change(&app, core);
                }

                if let Some(developer) = settings.get("developer") {
                    handle_developer_settings_change(&app, developer);
                }
            }
            Err(e) => error!("❌ Failed to parse settings change: {e}"),
        }
    });
}

// ============================================================================
// Other Handlers
// ============================================================================

fn tray_menu_updated(app: &AppHandle) {
    let app_clone = app.clone();
    app.listen(UPDATE_TRAY_MENU, move |_| {
        let app = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = update_tray_menu(app).await {
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
            if let Err(e) = update_tray_menu(app).await {
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
            if let Err(e) = update_tray_menu(app.clone()).await {
                error!("Failed to update tray menu after serve change: {e}");
            }
        });
    });
}

fn handle_backend_switched(app: &AppHandle) {
    let app_clone = app.clone();
    use crate::utils::types::events::BACKEND_SWITCHED;
    app.listen(BACKEND_SWITCHED, move |event| {
        debug!("🔄 Backend switched! Raw payload: {:?}", event.payload());
        let app = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            // Update tray menu to reflect potentially new remotes
            if let Err(e) = update_tray_menu(app.clone()).await {
                error!("Failed to update tray menu: {e}");
            }
        });
    });
}

fn handle_remote_settings_changed(app: &AppHandle) {
    let app_clone = app.clone();
    use crate::utils::types::events::REMOTE_SETTINGS_CHANGED;
    app.listen(REMOTE_SETTINGS_CHANGED, move |event| {
        debug!("🔄 Remote settings changed! Payload: {:?}", event.payload());
        let app = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            // Update tray menu since showOnTray or other display settings may have changed
            if let Err(e) = update_tray_menu(app).await {
                error!("Failed to update tray menu after remote settings change: {e}");
            }
        });
    });
}

pub fn setup_event_listener(app: &AppHandle) {
    handle_ctrl_c(app);

    handle_rclone_password_stored(app);
    handle_serve_state_changed(app);
    handle_remote_presence_changed(app);
    handle_settings_changed(app);
    handle_remote_settings_changed(app);
    tray_menu_updated(app);
    handle_job_cache_changed(app);
    handle_backend_switched(app);
    debug!("✅ Event listeners set up");
}
