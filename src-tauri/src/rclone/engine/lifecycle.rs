use log::{debug, error, info, warn};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

use crate::rclone::backend::BackendManager;
use crate::rclone::engine::poller::stop_system_poller;
use crate::utils::{
    app::notification::{EngineStage, NotificationEvent, notify},
    types::{
        events::{EngineStatus, RCLONE_ENGINE_STATUS_CHANGED},
        state::{EngineState, RcApiEngine, RcloneState},
    },
};

pub fn mark_startup_complete(app: &AppHandle) {
    let state = app.state::<RcloneState>();
    state.initial_startup.store(false, Ordering::Release);
    debug!("Initial startup complete, health monitoring enabled");
}

const API_READY_TIMEOUT_SECS: u64 = 10;

impl RcApiEngine {
    pub async fn init(&mut self, app: &AppHandle) {
        if self.validate_config(app).await {
            start(self, app).await;
        } else {
            warn!("Engine startup aborted due to configuration validation failure");
        }
    }

    pub async fn shutdown(&mut self, app: &AppHandle) {
        info!("Shutting down Rclone engine");
        self.should_exit = true;

        if let Err(e) = self.kill_process(app).await {
            error!("Failed to stop engine cleanly: {e}");
        }

        self.process = None;
        self.running = false;
        stop_system_poller(app);
    }
}

pub async fn set_engine_updating(app: &AppHandle, updating: bool) {
    let state = app.state::<EngineState>();
    let mut engine = state.lock().await;
    engine.set_updating(updating);
}

pub async fn shutdown_engine(app: &AppHandle) {
    let state = app.state::<EngineState>();
    let mut engine = state.lock().await;
    engine.shutdown(app).await;
}

pub async fn resume_engine(app: &AppHandle) {
    let state = app.state::<EngineState>();
    let mut engine = state.lock().await;
    engine.should_exit = false;
    engine.set_updating(false);
}

pub async fn clear_engine_errors(app: &AppHandle) {
    let state = app.state::<EngineState>();
    let mut engine = state.lock().await;
    engine.clear_errors();
}

pub async fn get_engine_status(app: &AppHandle) -> (bool, bool, bool) {
    let state = app.state::<EngineState>();
    let engine = state.lock().await;
    (engine.running, engine.updating, engine.should_exit)
}

pub async fn start_engine_if_not_running(app: &AppHandle) {
    let state = app.state::<EngineState>();
    let mut engine = state.lock().await;
    if !engine.running {
        start(&mut engine, app).await;
    }
}

pub async fn mark_engine_dead(app: &AppHandle) {
    let state = app.state::<EngineState>();
    let mut engine = state.lock().await;
    engine.running = false;
}

pub async fn start(engine: &mut RcApiEngine, app: &AppHandle) {
    if let Some(reason) = engine.start_blocked_reason() {
        debug!("Engine cannot start: {reason}");
        match reason {
            super::core::PauseReason::Password => {
                app.emit(RCLONE_ENGINE_STATUS_CHANGED, EngineStatus::PasswordError)
                    .ok();
            }
            super::core::PauseReason::Path => {
                app.emit(RCLONE_ENGINE_STATUS_CHANGED, EngineStatus::PathError)
                    .ok();
            }
            super::core::PauseReason::Version => {
                let required = crate::core::check_binaries::MIN_RCLONE_VERSION.to_string();
                let rclone_binary = crate::core::check_binaries::read_rclone_binary(app);
                let version = crate::core::check_binaries::get_rclone_version(&rclone_binary)
                    .await
                    .unwrap_or_else(|| "unknown".to_string());
                app.emit(
                    RCLONE_ENGINE_STATUS_CHANGED,
                    EngineStatus::VersionError { version, required },
                )
                .ok();
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
        debug!("Rclone process already exists, stopping first");
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

                super::post_start::trigger_post_start_setup(app.clone());
            } else {
                error!("Failed to start Rclone API within timeout");
                engine.running = false;
                engine.process = None;
                let _ = engine.kill_process(app).await;
                handle_start_failure(engine, app, "Timeout waiting for API readiness".to_string())
                    .await;
            }
        }
        Err(e) => {
            handle_start_failure(engine, app, e.to_string()).await;
        }
    }
}

async fn handle_start_failure(engine: &mut RcApiEngine, app: &AppHandle, e: String) {
    error!("Failed to spawn Rclone process: {e}");

    let status = if engine.path_error {
        notify(app, NotificationEvent::Engine(EngineStage::BinaryNotFound));
        EngineStatus::PathError
    } else if engine.version_error {
        let required = crate::core::check_binaries::MIN_RCLONE_VERSION.to_string();
        let rclone_binary = crate::core::check_binaries::read_rclone_binary(app);
        let version = crate::core::check_binaries::get_rclone_version(&rclone_binary)
            .await
            .unwrap_or_else(|| "unknown".to_string());
        EngineStatus::VersionError { version, required }
    } else if engine.password_error {
        notify(
            app,
            NotificationEvent::Engine(EngineStage::PasswordRequired),
        );
        EngineStatus::PasswordError
    } else {
        EngineStatus::Error { message: e }
    };

    app.emit(RCLONE_ENGINE_STATUS_CHANGED, &status).ok();
}

pub fn restart_for_config_change(
    app: &AppHandle,
    change_type: &str,
    old_value: &str,
    new_value: &str,
) -> super::error::EngineResult<()> {
    info!("Restarting engine due to {change_type} change: {old_value} → {new_value}");

    let app = app.clone();
    let change_type = change_type.to_string();

    tauri::async_runtime::spawn(async move {
        match restart_engine(&app, &change_type).await {
            Ok(()) => {
                info!("Engine restarted for {change_type} change");
                app.emit(
                    RCLONE_ENGINE_STATUS_CHANGED,
                    EngineStatus::Restarted {
                        reason: change_type,
                    },
                )
                .ok();
                notify(&app, NotificationEvent::Engine(EngineStage::Restarted));
            }
            Err(e) => {
                error!("Failed to restart engine for {change_type} change: {e}");
                app.emit(
                    RCLONE_ENGINE_STATUS_CHANGED,
                    EngineStatus::Error {
                        message: e.to_string(),
                    },
                )
                .ok();
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
    use crate::utils::types::state::EngineState;

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
    use crate::utils::types::state::RcApiEngine;

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
