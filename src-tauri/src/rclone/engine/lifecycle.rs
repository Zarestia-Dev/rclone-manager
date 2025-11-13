use log::{debug, error, info};
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::{Duration, sleep};

use crate::{
    core::{
        initialization::apply_core_settings, settings::operations::core::load_startup_settings,
        tray::core::update_tray_menu,
    },
    utils::types::{
        all_types::{RcApiEngine, RemoteCache},
        events::{
            ENGINE_RESTARTED, RCLONE_ENGINE_ERROR, RCLONE_ENGINE_PASSWORD_ERROR,
            RCLONE_ENGINE_PATH_ERROR, RCLONE_ENGINE_READY,
        },
        settings::SettingsState,
    },
};

impl RcApiEngine {
    pub fn init(&mut self, app: &AppHandle) {
        let app_handle = app.clone();

        if self.validate_config_sync(app) {
            tauri::async_runtime::block_on(start(self, app));
        }

        tauri::async_runtime::spawn(async move {
            loop {
                let mut engine = RcApiEngine::lock_engine().await;

                if engine.should_exit {
                    break;
                }

                if !engine.is_api_healthy(&app_handle).await && !engine.should_exit {
                    debug!("🔄 Rclone API not healthy, attempting restart...");
                    start(&mut engine, &app_handle).await;
                }

                drop(engine);
                sleep(Duration::from_secs(5)).await;
            }

            info!("🛑 Engine monitoring thread exiting.");
        });
    }

    pub async fn shutdown(&mut self) {
        info!("🛑 Shutting down Rclone engine...");
        self.should_exit = true;

        if let Err(e) = stop(self).await {
            error!("Failed to stop engine cleanly: {e}");
        }

        self.process = None;
        self.running = false;
    }
}

pub async fn start(engine: &mut RcApiEngine, app: &AppHandle) {
    if !engine.running && engine.updating {
        debug!("⏸️ Engine is in updating state, not starting until updating is false");
        return;
    }
    if engine.password_error {
        debug!("⏸️ Engine has password error, not starting until resolved");
        app.emit(RCLONE_ENGINE_PASSWORD_ERROR, ()).ok();
        return;
    }
    if engine.path_error {
        debug!("⏸️ Engine has path error, not starting until resolved");
        app.emit(RCLONE_ENGINE_PATH_ERROR, ()).ok();
        return;
    }
    if engine.is_api_healthy(app).await {
        debug!("✅ API is already healthy, skipping restart");
        return;
    }
    if engine.process.is_some() {
        debug!("⚠️ Rclone process already exists, stopping first...");
        if let Err(e) = stop(engine).await {
            error!("Failed to stop Rclone process: {e}");
        }
    }
    if let Err(e) = RcApiEngine::kill_all_rclone_rcd(&engine).await {
        error!("Failed to emergency cleanup: {e}");
    }
    if let Err(e) = engine.kill_port_processes() {
        error!("Failed to clean up port processes: {e}");
    }

    match engine.spawn_process(app).await {
        Ok(child) => {
            engine.process = Some(child);

            if engine.wait_until_ready(app, 10).await {
                engine.running = true;
                let port = engine.api_port; // <-- Use field from self
                info!("✅ Rclone API started successfully on port {port}");
                if let Err(e) = app.emit(RCLONE_ENGINE_READY, ()) {
                    error!("Failed to emit ready event: {e}");
                }

                let app_handle = app.clone();
                match load_startup_settings(&app_handle.state::<SettingsState<tauri::Wry>>()).await
                {
                    Ok(settings) => {
                        tauri::async_runtime::spawn(async move {
                            apply_core_settings(&app_handle, &settings).await;

                            let mut engine = RcApiEngine::lock_engine().await;
                            engine.path_error = false;
                            engine.password_error = false;

                            // Drop lock before async cache operations
                            drop(engine);

                            let cache = app_handle.state::<RemoteCache>();

                            match cache.refresh_all(app_handle.clone()).await {
                                Ok(_) => debug!("Caches refreshed successfully after engine ready"),
                                Err(e) => error!("Failed to refresh caches: {e}"),
                            }

                            if let Err(e) = update_tray_menu(app_handle.clone(), 0).await {
                                error!("Failed to update tray menu: {e}");
                            }
                        });
                    }
                    Err(e) => {
                        error!("Failed to load settings to apply after engine start: {}", e);
                    }
                }
            } else {
                error!("❌ Failed to start Rclone API within timeout.");
                engine.process = None;
                engine.running = false;
                if let Err(e) = app.emit(RCLONE_ENGINE_ERROR, ()) {
                    error!("Failed to emit event: {e}");
                }
            }
        }
        Err(e) => {
            error!("❌ Failed to spawn Rclone process: {e}");
            if engine.path_error {
                if let Err(err) = app.emit(RCLONE_ENGINE_PATH_ERROR, ()) {
                    error!("Failed to emit path error event: {err}");
                }
            } else {
                if let Err(err) = app.emit(RCLONE_ENGINE_ERROR, ()) {
                    error!("Failed to emit event: {err}");
                }
            }
        }
    }
}

pub async fn stop(engine: &mut RcApiEngine) -> Result<(), String> {
    engine.kill_process()
}

pub fn restart_for_config_change(
    app: &AppHandle,
    change_type: &str,
    old_value: &str,
    new_value: &str,
) -> Result<(), String> {
    info!("🔄 Restarting engine due to {change_type} change: {old_value} → {new_value}");

    let app_handle = app.clone();
    let change_type = change_type.to_string();
    let old_value = old_value.to_string();
    let new_value = new_value.to_string();

    tauri::async_runtime::spawn(async move {
        let result = restart_engine_async(&app_handle, &change_type).await;

        match result {
            Ok(_) => {
                info!("✅ Engine restarted successfully for {change_type} change");

                if let Err(e) = app_handle.emit(
                    ENGINE_RESTARTED,
                    serde_json::json!({
                        "reason": change_type,
                        "old_value": old_value,
                        "new_value": new_value,
                        "success": true
                    }),
                ) {
                    error!("Failed to emit engine restart success event: {e}");
                }
            }
            Err(e) => {
                error!("❌ Failed to restart engine for {change_type} change: {e}");

                if let Err(emit_err) = app_handle.emit(RCLONE_ENGINE_ERROR, ()) {
                    error!("Failed to emit engine restart failure event: {emit_err}");
                }
            }
        }
    });

    Ok(())
}

async fn restart_engine_async(app: &AppHandle, change_type: &str) -> Result<(), String> {
    let mut engine = RcApiEngine::lock_engine().await;

    debug!("🛑 Stopping current engine for {change_type} change...");
    if let Err(e) = stop(&mut engine).await {
        error!("Failed to stop engine cleanly: {e}");
    }

    match change_type {
        "rclone_path" => {
            debug!("🔄 Updating rclone path...");
            // The validation check is now handled by validate_config_async
            if !engine.validate_config_async(app).await {
                error!("❌ Rclone path validation failed, aborting engine restart");
                return Err("Rclone path validation failed".to_string());
            }
        }
        "api_port" => {
            debug!("🔄 API port updated in ENGINE");
        }
        "rclone_config_file" => {
            debug!("🔄 Config file updated in RcloneState");
            // Use the new async-safe function
            engine.validate_config_async(app).await;
        }
        _ => {
            debug!("🔄 Generic restart for {change_type}");
        }
    }
    drop(engine); // Drop lock before re-locking in start()

    // --- Get engine from the global static again ---
    let mut engine = RcApiEngine::lock_engine().await;
    debug!("🚀 Starting engine with new configuration...");
    start(&mut engine, app).await;

    if engine.running {
        info!("✅ Engine restart completed successfully");
        Ok(())
    } else {
        Err("Engine failed to start after restart".to_string())
    }
}
