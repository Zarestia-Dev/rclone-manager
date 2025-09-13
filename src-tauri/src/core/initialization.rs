use log::{debug, error, info};
use std::path::PathBuf;
use tauri::Manager;

use crate::{
    core::event_listener::setup_event_listener,
    rclone::{
        commands::set_bandwidth_limit,
        state::{CACHE, ENGINE_STATE},
    },
    utils::{
        app::builder::setup_tray,
        types::all_types::{AppSettings, RcApiEngine, RcloneState},
    },
};

/// Initializes Rclone API and OAuth state, and launches the Rclone engine.
pub fn init_rclone_state(
    app_handle: &tauri::AppHandle,
    settings: &AppSettings,
) -> Result<(), String> {
    let api_url = format!("http://127.0.0.1:{}", settings.core.rclone_api_port);
    let oauth_url = format!("http://127.0.0.1:{}", settings.core.rclone_oauth_port);

    ENGINE_STATE
        .set_api(api_url, settings.core.rclone_api_port)
        .map_err(|e| format!("Failed to set Rclone API: {e}"))?;

    ENGINE_STATE
        .set_oauth(oauth_url, settings.core.rclone_oauth_port)
        .map_err(|e| format!("Failed to set Rclone OAuth: {e}"))?;

    let mut engine = RcApiEngine::lock_engine()?;
    engine.init(app_handle);

    info!("🔄 Rclone engine initialized");
    Ok(())
}

/// Sets up the configuration directory for the application
pub fn setup_config_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config directory: {e}"))?;

    Ok(config_dir)
}

/// Handles async startup tasks
pub async fn async_startup(app_handle: tauri::AppHandle, settings: AppSettings) {
    debug!("🚀 Starting async startup tasks");

    setup_event_listener(&app_handle);

    // TODO: Register global shortcuts once tauri-plugin-global-shortcut API is clarified
    // if let Err(e) = register_global_shortcuts(&app_handle) {
    //     error!("Failed to register global shortcuts: {}", e);
    // }

    CACHE.refresh_all(app_handle.clone()).await;
    debug!("🔄 Cache refreshed");

    // Check if --tray argument is provided to override settings
    let force_tray = std::env::args().any(|arg| arg == "--tray");

    if settings.general.tray_enabled || force_tray {
        if force_tray {
            debug!("🧊 Setting up tray (forced by --tray argument)");
        } else {
            debug!("🧊 Setting up tray (enabled in settings)");
        }
        if let Err(e) = setup_tray(app_handle.clone(), settings.core.max_tray_items).await {
            error!("Failed to setup tray: {e}");
        }
    }
}

pub async fn apply_core_settings(app_handle: &tauri::AppHandle, settings: &AppSettings) {
    if !settings.core.bandwidth_limit.is_empty() {
        debug!(
            "🌐 Setting bandwidth limit: {}",
            settings.core.bandwidth_limit
        );
        let rclone_state = app_handle.state::<RcloneState>();

        if let Err(e) = set_bandwidth_limit(
            app_handle.clone(),
            Some(settings.core.bandwidth_limit.clone()),
            rclone_state,
        )
        .await
        {
            error!("Failed to set bandwidth limit: {e}");
        }
    }

    // if !settings.core.rclone_config_file.is_empty() {
    //     debug!(
    //         "🔗 Setting Rclone config path: {}",
    //         settings.core.rclone_config_file
    //     );
    //     if let Err(e) =
    //         set_rclone_config_file(app_handle.clone(), settings.core.rclone_config_file.clone())
    //             .await
    //     {
    //         error!("Failed to set Rclone config path: {e}");
    //     }
    // }
}
