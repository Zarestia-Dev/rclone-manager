use log::{debug, error, info, warn};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

static INITIAL_STARTUP: AtomicBool = AtomicBool::new(true);

use crate::rclone::backend::BackendManager;

pub fn mark_startup_complete() {
    INITIAL_STARTUP.store(false, Ordering::Relaxed);
    debug!("Initial startup complete, health monitoring enabled");
}

const API_READY_TIMEOUT_SECS: u64 = 10;
const MONITORING_INTERVAL_SECS: u64 = if cfg!(test) { 1 } else { 5 };

use crate::utils::{
    app::notification::{EngineStage, NotificationEvent, notify},
    types::{
        core::{RcApiEngine, RcloneState},
        events::{
            ENGINE_RESTARTED, RCLONE_ENGINE_ERROR, RCLONE_ENGINE_PASSWORD_ERROR,
            RCLONE_ENGINE_PATH_ERROR, RCLONE_ENGINE_READY,
        },
    },
};

fn spawn_monitoring_loop(app_handle: AppHandle) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(MONITORING_INTERVAL_SECS));
        interval.tick().await;

        loop {
            interval.tick().await;

            if app_handle.state::<RcloneState>().is_shutting_down() {
                break;
            }

            {
                use crate::utils::types::core::EngineState;
                let engine_state = app_handle.state::<EngineState>();
                let mut engine = engine_state.lock().await;

                if engine.should_exit {
                    break;
                }

                if INITIAL_STARTUP.load(Ordering::Relaxed) {
                    debug!("Skipping health check during initial startup");
                    continue;
                }

                let client = app_handle.state::<RcloneState>().client.clone();
                let backend_manager = app_handle.state::<BackendManager>();
                if !engine.is_api_healthy(&client, &backend_manager).await && !engine.should_exit {
                    debug!("Rclone API not healthy, attempting restart...");
                    start(&mut engine, &app_handle).await;
                }
            }
        }

        info!("Engine monitoring task exiting.");
    });
}

impl RcApiEngine {
    pub async fn init(&mut self, app: &AppHandle) {
        let app_handle = app.clone();

        if self.validate_config(app).await {
            start(self, app).await;
        } else {
            warn!("Engine startup aborted due to configuration validation failure");
        }

        spawn_monitoring_loop(app_handle);
    }

    pub async fn shutdown(&mut self, app: &AppHandle) {
        info!("Shutting down Rclone engine...");
        self.should_exit = true;

        if let Err(e) = self.kill_process(app).await {
            error!("Failed to stop engine cleanly: {e}");
        }

        self.process = None;
        self.running = false;
    }
}

/// Start the Rclone engine.
pub async fn start(engine: &mut RcApiEngine, app: &AppHandle) {
    if let Some(reason) = engine.start_blocked_reason() {
        debug!("Engine cannot start: {reason}");
        match reason {
            super::core::PauseReason::Password => {
                app.emit(RCLONE_ENGINE_PASSWORD_ERROR, ()).ok();
            }
            super::core::PauseReason::Path => {
                app.emit(RCLONE_ENGINE_PATH_ERROR, ()).ok();
            }
            super::core::PauseReason::Updating => {}
        }
        return;
    }

    let client = app.state::<RcloneState>().client.clone();
    let backend_manager = app.state::<BackendManager>();
    if engine.is_api_healthy(&client, &backend_manager).await {
        debug!("API is already healthy, skipping restart");
        return;
    }

    if engine.process.is_some() {
        debug!("Rclone process already exists, stopping first...");
        if let Err(e) = engine.kill_process(app).await {
            error!("Failed to stop Rclone process: {e}");
        }
    }

    if let Err(e) = engine.kill_port_processes() {
        error!("Failed to clean up port processes: {e}");
    }

    match engine.spawn_process(app).await {
        Ok(child) => {
            engine.process = Some(child);

            if engine
                .wait_until_ready(&client, &backend_manager, API_READY_TIMEOUT_SECS)
                .await
            {
                engine.running = true;
                info!("Rclone API started on port {}", engine.current_api_port);

                if let Err(e) = app.emit(RCLONE_ENGINE_READY, ()) {
                    error!("Failed to emit ready event: {e}");
                }

                super::post_start::trigger_post_start_setup(app.clone());
            } else {
                error!("Failed to start Rclone API within timeout.");
                engine.running = false;
                engine.process = None;
                let _ = engine.kill_process(app).await;
                handle_start_failure(engine, app, "Timeout waiting for API readiness".to_string());
            }
        }
        Err(e) => {
            handle_start_failure(engine, app, e.to_string());
        }
    }
}

fn handle_start_failure(engine: &mut RcApiEngine, app: &AppHandle, e: String) {
    error!("Failed to spawn Rclone process: {e}");

    if engine.path_error {
        app.emit(RCLONE_ENGINE_PATH_ERROR, ()).ok();
        notify(app, NotificationEvent::Engine(EngineStage::BinaryNotFound));
    } else if engine.password_error {
        app.emit(RCLONE_ENGINE_PASSWORD_ERROR, ()).ok();
        notify(
            app,
            NotificationEvent::Engine(EngineStage::PasswordRequired),
        );
    } else {
        app.emit(RCLONE_ENGINE_ERROR, ()).ok();
    }
}

/// Restart engine due to a configuration change (rclone path, API port, flags, etc.).
/// Fires-and-forgets an async task; results are communicated via events.
pub fn restart_for_config_change(
    app: &AppHandle,
    change_type: &str,
    old_value: &str,
    new_value: &str,
) -> super::error::EngineResult<()> {
    info!("Restarting engine due to {change_type} change: {old_value} → {new_value}");

    let app = app.clone();
    let change_type = change_type.to_string();
    let old_value = old_value.to_string();
    let new_value = new_value.to_string();

    tauri::async_runtime::spawn(async move {
        match restart_engine(&app, &change_type).await {
            Ok(()) => {
                info!("Engine restarted for {change_type} change");
                app.emit(
                    ENGINE_RESTARTED,
                    serde_json::json!({
                        "reason": change_type,
                        "old_value": old_value,
                        "new_value": new_value,
                        "success": true,
                    }),
                )
                .ok();
                notify(&app, NotificationEvent::Engine(EngineStage::Restarted));
            }
            Err(e) => {
                error!("Failed to restart engine for {change_type} change: {e}");
                app.emit(RCLONE_ENGINE_ERROR, ()).ok();
                notify(
                    &app,
                    NotificationEvent::Engine(EngineStage::RestartFailed {
                        error: e.to_string(),
                    }),
                );
            }
        }
    });

    Ok(())
}

async fn restart_engine(app: &AppHandle, change_type: &str) -> super::error::EngineResult<()> {
    use super::error::EngineError;
    use crate::utils::types::core::EngineState;

    let engine_state = app.state::<EngineState>();
    let mut engine = engine_state.lock().await;

    if let Err(e) = engine.kill_process(app).await {
        error!("Failed to stop engine cleanly during restart: {e}");
    }

    if !engine.validate_config(app).await {
        return Err(EngineError::ConfigValidationFailed(format!(
            "Configuration validation failed after {change_type} change"
        )));
    }

    start(&mut engine, app).await;

    if engine.running {
        Ok(())
    } else {
        Err(EngineError::RestartFailed(
            "Engine failed to start after restart".to_string(),
        ))
    }
}

#[allow(clippy::items_after_test_module)]
#[cfg(test)]
mod tests {
    use crate::rclone::engine::core::PauseReason;
    use crate::utils::types::core::RcApiEngine;

    #[test]
    fn test_start_blocked_reason_priority() {
        let mut engine = RcApiEngine::default();
        assert!(engine.start_blocked_reason().is_none());

        engine.set_updating(true);
        engine.set_password_error(true);
        assert_eq!(engine.start_blocked_reason(), Some(PauseReason::Updating));

        engine.set_updating(false);
        assert_eq!(engine.start_blocked_reason(), Some(PauseReason::Password));

        engine.set_password_error(false);
        engine.set_path_error(true);
        assert_eq!(engine.start_blocked_reason(), Some(PauseReason::Path));
    }

    #[test]
    fn test_is_api_healthy_logic_stub() {
        let engine = RcApiEngine::default();
        assert!(!engine.running);
    }
}
