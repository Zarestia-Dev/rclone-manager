use std::{
    process::Child,
    sync::{Arc, Mutex},
};

use log::{debug, error};
use serde_json::Value;
use tauri::Listener;
use tauri_plugin_autostart::ManagerExt;
use tokio::sync::broadcast::Receiver;

use crate::{
    core::tray::tray::setup_tray,
    init_logging,
    rclone::api::{
        engine::stop_rc_api,
        state::{set_rclone_api_url_port, set_rclone_oauth_url_port},
    },
};

use super::tray::tray::update_tray_menu;

pub fn setup_event_listener(
    app: &tauri::AppHandle,
    rc_process: Arc<Mutex<Option<Child>>>,
    mut update_receiver: Receiver<()>,
) {
    // Handle rclone API URL updates
    let rc_process_clone = rc_process.clone();
    app.listen("rclone_api_url_updated", move |_| {
        if let Ok(mut guard) = rc_process_clone.lock() {
            stop_rc_api(&mut *guard);
        } else {
            error!("Failed to acquire lock on rc_process_clone.");
        }
    });

    // Handle rclone API started event
    let app_clone = app.clone();
    app.listen("rclone_api_started", move |_| {
        let app_clone_inner = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = update_tray_menu(&app_clone_inner, 0).await {
                error!("Failed to update tray menu: {}", e);
            }
        });
    });

    // Handle settings changes - REGISTERED ONLY ONCE
    let app_handle_clone = app.clone();
    app.listen("settings_changed", move |event| {
        let app_handle_inner = app_handle_clone.clone();

        debug!("🔄 Settings saved! Raw payload: {:?}", event.payload());

        match serde_json::from_str::<Value>(event.payload()) {
            Ok(parsed_settings) => {
                debug!("✅ Parsed settings: {:?}", parsed_settings);

                // General settings
                if let Some(general) = parsed_settings.get("general") {
                    // Start on startup
                    if let Some(start_on_startup) = general.get("start_on_startup").and_then(|v| v.as_bool()) {
                        debug!("🚀 Start on Startup changed to: {}", start_on_startup);
                        let autostart_manager = app_handle_inner.autolaunch();
                        if start_on_startup {
                            let _ = autostart_manager.enable();
                        } else {
                            let _ = autostart_manager.disable();
                        }
                    }

                    // Tray visibility
                    if let Some(tray_enabled) = general.get("tray_enabled").and_then(|v| v.as_bool()) {
                        debug!("🛠️ Tray visibility changed to: {}", tray_enabled);
                        if let Some(tray) = app_handle_inner.tray_by_id("main") {
                            let _ = tray.set_visible(tray_enabled);
                        } else {
                            let app_handle = app_handle_inner.clone();
                            tauri::async_runtime::spawn(async move {
                                if let Err(e) = setup_tray(&app_handle, 0).await {
                                    error!("Failed to set up tray: {}", e);
                                }
                            });
                        }
                    }
                }

                // Core settings
                if let Some(core) = parsed_settings.get("core") {
                    // Rclone API port
                    if let Some(rclone_api_port) = core.get("rclone_api_port").and_then(|v| v.as_u64()) {
                        debug!("🔌 Rclone API Port changed to: {}", rclone_api_port);
                        set_rclone_api_url_port(&app_handle_inner, rclone_api_port as u16);
                    }

                    // Rclone OAuth port
                    if let Some(rclone_oauth_port) = core.get("rclone_oauth_port").and_then(|v| v.as_u64()) {
                        debug!("🔑 Rclone OAuth Port changed to: {}", rclone_oauth_port);
                        set_rclone_oauth_url_port(rclone_oauth_port as u16);
                    }

                    // Max tray items
                    if let Some(max_tray_items) = core.get("max_tray_items").and_then(|v| v.as_u64()) {
                        debug!("🗂️ Max tray items changed to: {}", max_tray_items);
                        let app_handle = app_handle_inner.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = update_tray_menu(&app_handle, max_tray_items as usize).await {
                                error!("Failed to update tray menu: {}", e);
                            }
                        });
                    }
                }

                // Experimental settings
                if let Some(experimental) = parsed_settings.get("experimental") {
                    if let Some(debug_logging) = experimental.get("debug_logging").and_then(|v| v.as_bool()) {
                        debug!("🐞 Debug logging changed to: {}", debug_logging);
                        init_logging(debug_logging);
                    }
                }
            }
            Err(e) => {
                error!("❌ Failed to parse settings change: {}", e);
            }
        }
    });

    // Background update receiver - just logs changes without re-registering listeners
    tauri::async_runtime::spawn(async move {
        while update_receiver.recv().await.is_ok() {
            debug!("🔄 Detected settings change, applying updates...");
            // No listener registration here - just notification
        }
    });
}