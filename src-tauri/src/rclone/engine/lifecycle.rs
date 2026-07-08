use log::{debug, error, info, warn};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(feature = "librclone")]
use crate::utils::rclone::endpoints::core;
use crate::utils::{
    app::notification::{EngineStage, NotificationEvent, notify},
    types::{
        events::{EngineStatus, RCLONE_ENGINE_STATUS_CHANGED},
        state::{EngineState, RcApiEngine, RcloneState},
    },
};

use super::error::EngineError;

pub fn mark_startup_complete(app: &AppHandle) {
    let state = app.state::<RcloneState>();
    state.initial_startup.store(false, Ordering::Release);
    debug!("Initial startup complete, health monitoring enabled");
}

#[cfg(not(feature = "librclone"))]
const API_READY_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EngineStatusInfo {
    pub running: bool,
    pub should_exit: bool,
    pub updating: bool,
}

impl RcApiEngine {
    pub async fn init(&mut self, app: &AppHandle) {
        if self.validate_config(app).await {
            start(self, app).await;
        } else {
            warn!("Engine startup aborted due to configuration validation failure");
        }
    }

    pub async fn shutdown(&mut self, _app: &AppHandle) {
        info!("Shutting down Rclone engine");
        self.should_exit = true;

        // Desktop: kill the rcd child process via core/quit + force-kill.
        #[cfg(not(feature = "librclone"))]
        {
            if let Err(e) = self.kill_process(_app).await {
                error!("Failed to stop engine cleanly: {e}");
            }
            self.process = None;
        }

        // Mobile: finalize librclone (releases Go runtime resources).
        // Safe to call even if not initialized; RcloneFinalize is idempotent.
        #[cfg(feature = "librclone")]
        {
            crate::rclone::backend::rclone_ffi::finalize();
        }

        self.running = false;
    }
}

#[cfg(not(feature = "librclone"))]
pub async fn set_engine_updating(app: &AppHandle, updating: bool) {
    let state = app.state::<EngineState>();
    let mut engine = state.lock().await;
    engine.set_updating(updating);
}

#[cfg(not(feature = "librclone"))]
pub async fn shutdown_engine(app: &AppHandle) {
    let state = app.state::<EngineState>();
    let mut engine = state.lock().await;
    engine.shutdown(app).await;
}

#[cfg(not(feature = "librclone"))]
pub async fn resume_engine(app: &AppHandle) {
    let state = app.state::<EngineState>();
    let mut engine = state.lock().await;
    engine.should_exit = false;
    engine.set_updating(false);
}

pub async fn get_engine_status(app: &AppHandle) -> EngineStatusInfo {
    let state = app.state::<EngineState>();
    let engine = state.lock().await;
    EngineStatusInfo {
        running: engine.running,
        #[cfg(not(feature = "librclone"))]
        updating: engine.updating,
        #[cfg(feature = "librclone")]
        updating: false,
        should_exit: engine.should_exit,
    }
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

            #[cfg(not(feature = "librclone"))]
            super::core::PauseReason::Path => {
                app.emit(RCLONE_ENGINE_STATUS_CHANGED, EngineStatus::PathError)
                    .ok();
            }
            #[cfg(not(feature = "librclone"))]
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
            #[cfg(not(feature = "librclone"))]
            super::core::PauseReason::Updating => {}
        }
        return;
    }

    #[cfg(feature = "librclone")]
    start_librclone(engine, app).await;
    #[cfg(not(feature = "librclone"))]
    start_daemon(engine, app).await;
}

/// Desktop path: spawn the rcd daemon, wait for HTTP readiness, run post-start.
#[cfg(not(feature = "librclone"))]
async fn start_daemon(engine: &mut RcApiEngine, app: &AppHandle) {
    if engine.is_api_healthy(app).await {
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

            if engine.wait_until_ready(app, API_READY_TIMEOUT_SECS).await {
                engine.running = true;
                info!("Rclone API started on port {}", engine.current_api_port);

                super::post_start::run_post_start_setup(app).await;
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

#[cfg(feature = "librclone")]
async fn start_librclone(engine: &mut RcApiEngine, app: &AppHandle) {
    let transport = app.state::<RcloneState>().transport.clone();
    match transport.rpc(core::VERSION, None).await {
        Ok(_) => {
            engine.running = true;
            info!("librclone transport ready (in-process)");
            super::post_start::run_post_start_setup(app).await;
        }
        Err(e) => {
            error!("librclone transport not responsive: {e}");
            handle_start_failure(engine, app, format!("librclone init failed: {e}")).await;
        }
    }
}

async fn handle_start_failure(engine: &mut RcApiEngine, app: &AppHandle, e: String) {
    error!("Failed to spawn Rclone process: {e}");

    #[cfg(not(feature = "librclone"))]
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

    #[cfg(feature = "librclone")]
    let status = if engine.password_error {
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
) {
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
}

async fn restart_engine(app: &AppHandle, change_type: &str) -> super::error::EngineResult<()> {
    let engine_state = app.state::<EngineState>();
    let mut engine = engine_state.lock().await;

    // Desktop: kill the daemon process before restart.
    // Mobile: librclone is in-process — "restart" = finalize + re-initialize
    // (cheap), or just re-verify if finalize+init isn't needed.
    #[cfg(not(feature = "librclone"))]
    {
        if let Err(e) = engine.kill_process(app).await {
            error!("Failed to stop engine cleanly during restart: {e}");
        }
    }
    #[cfg(feature = "librclone")]
    {
        // librclone restart: finalize the Go runtime + re-initialize.
        // This clears all rclone state (remotes, VFS caches, in-flight jobs)
        // and starts fresh. Cheaper than a process restart but not free.
        log::info!("Restarting librclone (finalize + initialize) for {change_type} change");
        crate::rclone::backend::rclone_ffi::finalize();
        crate::rclone::backend::rclone_ffi::initialize();
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
