use log::{debug, error, info, warn};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(feature = "librclone")]
use crate::utils::rclone::endpoints::core;
use crate::utils::{
    app::notification::{EngineStage, NotificationEvent, notify},
    types::{
        events::{EngineStatus, RCLONE_ENGINE_STATUS_CHANGED},
        state::{EnginePhase, EngineState, RcApiEngine, RcloneState},
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
        self.mark_stopping();

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

        self.mark_stopped();
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
    engine.clear_errors();
    if matches!(engine.phase, EnginePhase::Updating) {
        engine.mark_stopped();
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EngineStatusInfo {
    pub running: bool,
    pub should_exit: bool,
    pub updating: bool,
}

impl From<&EnginePhase> for EngineStatusInfo {
    fn from(phase: &EnginePhase) -> Self {
        Self {
            running: phase.is_operational(),
            should_exit: phase.is_shutting_down(),
            #[cfg(not(feature = "librclone"))]
            updating: matches!(phase, EnginePhase::Updating),
            #[cfg(feature = "librclone")]
            updating: false,
        }
    }
}

impl EngineStatusInfo {
    #[must_use]
    pub fn is_inactive(self) -> bool {
        !self.running || self.updating || self.should_exit
    }
}

pub async fn get_engine_status(app: &AppHandle) -> EngineStatusInfo {
    let state = app.state::<EngineState>();
    let engine = state.lock().await;
    EngineStatusInfo::from(&engine.phase)
}

pub async fn start_engine_if_not_running(app: &AppHandle) {
    let state = app.state::<EngineState>();
    let mut engine = state.lock().await;
    if !engine.is_running() {
        start(&mut engine, app).await;
    }
}

pub async fn mark_engine_dead(app: &AppHandle) {
    let state = app.state::<EngineState>();
    let mut engine = state.lock().await;
    engine.mark_stopped();
}

pub async fn start(engine: &mut RcApiEngine, app: &AppHandle) {
    if let Some(blocking_phase) = engine.start_block_reason() {
        debug!("Engine cannot start: {blocking_phase}");
        emit_block_status(app, blocking_phase);
        return;
    }

    #[cfg(feature = "librclone")]
    start_librclone(engine, app).await;
    #[cfg(not(feature = "librclone"))]
    start_daemon(engine, app).await;
}

fn emit_block_status(app: &AppHandle, phase: &EnginePhase) {
    match phase {
        EnginePhase::FailedPassword => {
            notify(
                app,
                NotificationEvent::Engine(EngineStage::PasswordRequired),
            );
        }
        #[cfg(not(feature = "librclone"))]
        EnginePhase::FailedPath => {
            notify(app, NotificationEvent::Engine(EngineStage::BinaryNotFound));
        }
        #[cfg(not(feature = "librclone"))]
        EnginePhase::FailedVersion { .. } => {}
        #[cfg(not(feature = "librclone"))]
        EnginePhase::Updating => {}
        EnginePhase::FailedOther { .. } => {}
        _ => {}
    }

    let status: EngineStatus = phase.into();
    app.emit(RCLONE_ENGINE_STATUS_CHANGED, status).ok();
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
                engine.mark_running();
                info!("Rclone API started on port {}", engine.current_api_port);

                super::post_start::run_post_start_setup(app).await;
            } else {
                error!("Failed to start Rclone API within timeout");
                engine.mark_stopped();
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
            engine.mark_running();
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

    if !engine.phase.is_failed() {
        engine.mark_other_failed(e);
    }

    emit_block_status(app, &engine.phase);
}

pub fn restart_for_config_change(app: &AppHandle, change_type: &str) {
    info!("Restarting engine due to {change_type} change");

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
    // (cheap), which clears all rclone state (remotes, VFS caches, in-flight
    // jobs) and starts fresh.
    #[cfg(not(feature = "librclone"))]
    {
        if let Err(e) = engine.kill_process(app).await {
            error!("Failed to stop engine cleanly during restart: {e}");
        }
    }
    #[cfg(feature = "librclone")]
    {
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

    if engine.is_running() {
        Ok(())
    } else {
        Err(EngineError::RestartFailed(
            "Engine failed to start after restart".to_string(),
        ))
    }
}
